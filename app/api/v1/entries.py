from __future__ import annotations

import uuid
import asyncio
from contextlib import suppress
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.core.deps import (
    get_current_user,
    get_db,
    resolve_entry_edit_user_ids,
    resolve_entry_view_user_ids,
)
from app.models.entry import Entry, EntryType
from app.models.user import User
from app.schemas.entry import (
    EntryBulkDeleteRequest,
    EntryCreate,
    EntryOut,
    EntryPage,
    EntryUpdate,
)
from app.services import inventory_service
from app.core.realtime import entry_event_broker, notify_entry_deleted

router = APIRouter(prefix="/entries", tags=["entries"])


def _parse_type(value: str | None) -> Optional[EntryType]:
    if value is None:
        return None
    try:
        return EntryType(value.lower())
    except ValueError as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid entry type") from exc


def _ensure_permission(user: User, entry_type: EntryType) -> None:
    flag_map = {
        EntryType.RAW: "can_add_entry_raw",
        EntryType.SFG: "can_add_entry_sfg",
        EntryType.FG: "can_add_entry_fg",
    }
    if not getattr(user.role, flag_map[entry_type]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")


def _ensure_bulk_permission(user: User, entry_type: EntryType) -> None:
    flag_map = {
        EntryType.RAW: "can_bulk_edit_delete_raw",
        EntryType.SFG: "can_bulk_edit_delete_sfg",
        EntryType.FG: "can_bulk_edit_delete_fg",
    }
    if not getattr(user.role, flag_map[entry_type]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")


def _ensure_edit_permission(user: User, entry_type: EntryType) -> None:
    flag_map = {
        EntryType.RAW: "can_edit_entry_raw",
        EntryType.SFG: "can_edit_entry_sfg",
        EntryType.FG: "can_edit_entry_fg",
    }
    if not getattr(user.role, flag_map[entry_type]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")


@router.get("/", response_model=EntryPage)
def list_entries(
    entry_type: str | None = Query(default=None, alias="type"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    type_filter = _parse_type(entry_type)
    visible_user_ids = resolve_entry_view_user_ids(db, current_user, type_filter)
    if visible_user_ids is not None and not visible_user_ids:
        return EntryPage(items=[], total=0, limit=limit, offset=offset, has_next=False)
    items, total = inventory_service.list_entries(
        db,
        user_ids=None if visible_user_ids is None else list(visible_user_ids),
        entry_type=type_filter,
        limit=limit,
        offset=offset,
    )
    has_next = offset + len(items) < total
    return EntryPage(items=items, total=total, limit=limit, offset=offset, has_next=has_next)


@router.post("/", response_model=EntryOut, status_code=status.HTTP_201_CREATED)
def create_entry(
    payload: EntryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ensure_permission(current_user, payload.type)
    return inventory_service.create_entry(db, payload, current_user.id)


@router.put("/{entry_id}", response_model=EntryOut)
def update_entry(entry_id: uuid.UUID, payload: EntryUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    entry = db.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    _ensure_edit_permission(current_user, entry.type)
    allowed_user_ids = resolve_entry_edit_user_ids(db, current_user, entry.type)
    if allowed_user_ids is not None and entry.user_id not in allowed_user_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return inventory_service.update_entry(db, entry_id, payload)


@router.delete("/bulk", status_code=status.HTTP_204_NO_CONTENT)
def bulk_delete_entries(
    payload: EntryBulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    entry_ids = payload.entry_ids or []
    if not entry_ids:
        return None

    entries = (
        db.query(Entry)
        .filter(Entry.id.in_(entry_ids))
        .all()
    )

    found_map: dict[uuid.UUID, Entry] = {entry.id: entry for entry in entries}
    missing = [str(entry_id) for entry_id in entry_ids if entry_id not in found_map]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"missing_entry_ids": missing},
        )

    ordered_entries = [found_map[entry_id] for entry_id in entry_ids]

    permissions_cache: dict[EntryType, set[uuid.UUID] | None] = {}
    for entry in ordered_entries:
        _ensure_bulk_permission(current_user, entry.type)
        allowed = permissions_cache.get(entry.type)
        if entry.type not in permissions_cache:
            resolved = resolve_entry_edit_user_ids(db, current_user, entry.type)
            allowed = None if resolved is None else set(resolved)
            permissions_cache[entry.type] = allowed
        if allowed is not None and entry.user_id not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden",
            )

    deleted = inventory_service.delete_entries_bulk(db, [entry.id for entry in ordered_entries])
    if deleted:
        for entry in ordered_entries:
            entry_id_str = str(entry.id)
            entry_type = str(getattr(entry.type, "value", entry.type)).lower()
            notify_entry_deleted(entry_id_str, entry_type)
    return None


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    entry = db.get(Entry, entry_id)
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    allowed_user_ids = resolve_entry_edit_user_ids(db, current_user, entry.type)
    if allowed_user_ids is not None and entry.user_id not in allowed_user_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    _ensure_bulk_permission(current_user, entry.type)
    inventory_service.delete_entry(db, entry_id)
    return None


@router.websocket("/stream")
async def entry_stream(websocket: WebSocket):
    user_id = websocket.session.get("user_id") if hasattr(websocket, "session") else None
    if not user_id:
        await websocket.close(code=1008)
        return
    try:
        user_uuid = uuid.UUID(str(user_id))
    except ValueError:
        await websocket.close(code=1008)
        return
    with SessionLocal() as db:
        user = db.get(User, user_uuid)
        if not user or not user.is_active:
            await websocket.close(code=1008)
            return
    await websocket.accept()
    queue = await entry_event_broker.subscribe()
    receiver_task: asyncio.Task[str] | None = None
    try:
        await websocket.send_json({"type": "connected"})
        while True:
            if receiver_task is None:
                receiver_task = asyncio.create_task(websocket.receive_text())
            waiter = asyncio.create_task(queue.get())
            done, pending = await asyncio.wait(
                {waiter, receiver_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if receiver_task in done:
                # client closed connection
                break
            message = waiter.result()
            await websocket.send_json(message)
            waiter.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        await entry_event_broker.unsubscribe(queue)
        if receiver_task:
            receiver_task.cancel()
            with suppress(Exception):
                await receiver_task
