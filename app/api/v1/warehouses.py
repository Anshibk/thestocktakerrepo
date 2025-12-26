from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import exists
from sqlalchemy.orm import Session

from app.core.deps import get_db, require_permission
from app.models.entry import Entry
from app.models.warehouse import Warehouse
from app.schemas.warehouse import WarehouseCreate, WarehouseOut

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


@router.get("/", response_model=list[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db)):
    return db.query(Warehouse).order_by(Warehouse.name).all()


@router.post("/", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_permission("can_edit_manage_data"))])
def create_warehouse(payload: WarehouseCreate, db: Session = Depends(get_db)):
    warehouse = Warehouse(**payload.dict())
    db.add(warehouse)
    db.commit()
    db.refresh(warehouse)
    return warehouse


@router.delete("/{warehouse_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_permission("can_edit_manage_data"))])
def delete_warehouse(warehouse_id: uuid.UUID, db: Session = Depends(get_db)):
    warehouse = db.get(Warehouse, warehouse_id)
    if not warehouse:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Warehouse not found")
    has_entries = db.query(exists().where(Entry.warehouse_id == warehouse_id)).scalar()
    if has_entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete a location that is referenced by inventory entries.",
        )
    db.delete(warehouse)
    db.commit()
    return None
