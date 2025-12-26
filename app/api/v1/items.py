from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import exists
from sqlalchemy.orm import Session

from app.core.deps import get_db, require_permission
from app.models.item import Item
from app.models.entry import Entry
from app.schemas.item import ItemCreate, ItemOut, ItemUpdate
from app.services import item_service

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/", response_model=list[ItemOut])
def list_items(
    q: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    query = db.query(Item)
    if q:
        query = query.filter(Item.name.ilike(f"%{q}%"))
    return query.order_by(Item.name).all()


@router.post(
    "/",
    response_model=ItemOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("can_import_master_data"))],
)
def create_item(payload: ItemCreate, db: Session = Depends(get_db)):
    item = Item(**payload.dict())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put(
    "/{item_id}",
    response_model=ItemOut,
    dependencies=[Depends(require_permission("can_edit_add_item"))],
)
def update_item(item_id: uuid.UUID, payload: ItemUpdate, db: Session = Depends(get_db)):
    item = db.get(Item, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    data = payload.dict(exclude_unset=True)
    for key, value in data.items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete(
    "/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("can_bulk_edit_delete_add_item"))],
)
def delete_item(item_id: uuid.UUID, db: Session = Depends(get_db)):
    item = db.get(Item, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    has_entries = db.query(exists().where(Entry.item_id == item_id)).scalar()
    if has_entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete an item that has inventory entries.",
        )
    db.delete(item)
    db.commit()
    return None


@router.post(
    "/import",
    dependencies=[Depends(require_permission("can_import_master_data"))],
)
async def import_items(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    is_excel = "excel" in content_type or content_type.endswith("sheet") or filename.endswith(".xlsx")
    if not is_excel:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload an .xlsx spreadsheet",
        )
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    try:
        result = item_service.import_items(db, payload, original_filename=file.filename or "import.xlsx")
    except ValueError as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return result
