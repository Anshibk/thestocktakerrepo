from __future__ import annotations

import uuid
from enum import Enum

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.deps import (
    get_current_user,
    get_db,
    resolve_dashboard_visible_user_ids,
)
from app.models.item import Item
from app.models.user import User
from app.schemas.dashboard import (
    DashboardDetailResponse,
    DashboardSummaryResponse,
)
from app.services import dashboard_service


class DashboardExportMode(str, Enum):
    WITH_MASTER = "with-master"
    VALUATED = "valuated"

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummaryResponse)
def summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    user_ids = resolve_dashboard_visible_user_ids(db, current_user)
    scoped_ids = None if user_ids is None else list(user_ids)

    cards = dashboard_service.cards(db, scoped_ids)
    table = dashboard_service.table(db, scoped_ids)
    return DashboardSummaryResponse(cards=cards, table=table)


@router.get("/detail", response_model=DashboardDetailResponse)
def detail(
    item_id: uuid.UUID = Query(...),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user_ids = resolve_dashboard_visible_user_ids(db, current_user)
    scoped_ids = None if user_ids is None else list(user_ids)

    if not db.get(Item, item_id):
        raise HTTPException(status_code=404, detail="Item not found")

    detail_payload = dashboard_service.detail(
        db,
        scoped_ids,
        item_id,
        limit=limit,
        offset=offset,
    )
    if detail_payload.get("item") is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return DashboardDetailResponse(**detail_payload)


@router.get("/detail/{item_id}/export")
def export_detail(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    role = current_user.role
    if not role.can_export_dashboard_entries:
        raise HTTPException(status_code=403, detail="Permission denied")

    user_ids = resolve_dashboard_visible_user_ids(db, current_user)
    scoped_ids = None if user_ids is None else list(user_ids)

    if not db.get(Item, item_id):
        raise HTTPException(status_code=404, detail="Item not found")

    detail_payload = dashboard_service.detail(
        db,
        scoped_ids,
        item_id,
        limit=None,
        offset=0,
    )
    if detail_payload.get("item") is None:
        raise HTTPException(status_code=404, detail="Item not found")

    summary_rows = dashboard_service.table(db, scoped_ids)
    stream, filename = dashboard_service.export_detail(detail_payload, summary_rows)
    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export")
def export_dashboard(
    mode: DashboardExportMode = Query(default=DashboardExportMode.VALUATED),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    role = current_user.role
    if mode == DashboardExportMode.WITH_MASTER and not role.can_export_dashboard_summary:
        raise HTTPException(status_code=403, detail="Permission denied")
    if mode == DashboardExportMode.VALUATED and not role.can_export_dashboard_entries:
        raise HTTPException(status_code=403, detail="Permission denied")

    user_ids = resolve_dashboard_visible_user_ids(db, current_user)
    scoped_ids = None if user_ids is None else list(user_ids)

    include_master = mode == DashboardExportMode.WITH_MASTER
    stream, filename = dashboard_service.export_dashboard(
        db, scoped_ids, include_master_items=include_master
    )
    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
