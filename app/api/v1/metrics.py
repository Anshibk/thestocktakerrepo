from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import exists, func
from sqlalchemy.orm import Session

from app.core.deps import get_db, require_permission
from app.models.entry import Entry
from app.models.item import Item
from app.models.metric import Metric
from app.schemas.metric import MetricCreate, MetricOut

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/", response_model=list[MetricOut])
def list_metrics(db: Session = Depends(get_db)):
    return db.query(Metric).order_by(Metric.name).all()


@router.post("/", response_model=MetricOut, status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_permission("can_edit_manage_data"))])
def create_metric(payload: MetricCreate, db: Session = Depends(get_db)):
    metric = Metric(**payload.dict())
    db.add(metric)
    db.commit()
    db.refresh(metric)
    return metric


@router.delete("/{metric_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_permission("can_edit_manage_data"))])
def delete_metric(metric_id: uuid.UUID, db: Session = Depends(get_db)):
    metric = db.get(Metric, metric_id)
    if not metric:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Metric not found")
    lower_name = metric.name.lower()
    has_items = db.query(
        exists().where(func.lower(Item.unit) == lower_name)
    ).scalar()
    if has_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete a metric that is used by items.",
        )
    has_entries = db.query(
        exists().where(func.lower(Entry.unit) == lower_name)
    ).scalar()
    if has_entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete a metric that is referenced by inventory entries.",
        )
    db.delete(metric)
    db.commit()
    return None
