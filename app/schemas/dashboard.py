from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class DashboardCard(BaseModel):
    group_name: str
    categories: int
    items: int
    counted: int
    total_value: float


class DashboardTableRow(BaseModel):
    item_id: uuid.UUID
    item_name: str
    category_name: Optional[str]
    batches: int
    entries_logged: int
    total_qty: float
    total_value: float
    unit: Optional[str] = None


class DashboardItemInfo(BaseModel):
    item_id: uuid.UUID
    item_name: str
    category_name: Optional[str]


class DashboardDetailRow(BaseModel):
    entry_id: uuid.UUID
    username: str
    item_name: str
    category_name: Optional[str]
    unit: Optional[str]
    batch: Optional[str]
    qty: float
    mfg: Optional[str]
    exp: Optional[str]
    location: str
    price: float
    line_value: float
    created_at: datetime


class DashboardSummaryResponse(BaseModel):
    cards: list[DashboardCard]
    table: list[DashboardTableRow]


class DashboardDetailResponse(BaseModel):
    item: DashboardItemInfo
    entries: list[DashboardDetailRow]
    total: int
    limit: int
    offset: int
    has_next: bool
