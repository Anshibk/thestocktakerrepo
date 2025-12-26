from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_validator, validator

from app.models.entry import EntryType


class EntryBase(BaseModel):
    session_id: uuid.UUID
    item_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    type: EntryType
    unit: str
    qty: Decimal
    warehouse_id: uuid.UUID
    batch: Optional[str] = None
    price_at_entry: Optional[Decimal] = None
    mfg: Optional[str] = None
    exp: Optional[str] = None

    _normalize_month_year = validator("mfg", "exp", pre=True, allow_reuse=True)(
        lambda cls, value: (str(value).strip() or None) if value is not None else None
    )


class EntryCreate(EntryBase):
    entry_date: Optional[date] = None


class EntryUpdate(BaseModel):
    qty: Optional[Decimal] = None
    warehouse_id: Optional[uuid.UUID] = None
    batch: Optional[str] = None
    price_at_entry: Optional[Decimal] = None
    mfg: Optional[str] = None
    exp: Optional[str] = None
    entry_date: Optional[date] = None

    _normalize_month_year = validator("mfg", "exp", pre=True, allow_reuse=True)(
        lambda cls, value: (str(value).strip() or None) if value is not None else None
    )


class EntryOut(EntryBase):
    id: uuid.UUID
    created_at: datetime
    entry_date: Optional[date] = None
    user_id: Optional[uuid.UUID] = None
    user: Optional["EntryUserOut"] = None

    @validator("entry_date", pre=True, always=True)
    def _derive_entry_date(cls, value, values):
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        created_at = values.get("created_at")
        if isinstance(created_at, datetime):
            return created_at.date()
        return None

    model_config = ConfigDict(from_attributes=True)


class EntryUserOut(BaseModel):
    id: uuid.UUID
    username: str
    name: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class EntryPage(BaseModel):
    items: list[EntryOut]
    total: int
    limit: int
    offset: int
    has_next: bool


class EntryBulkDeleteRequest(BaseModel):
    entry_ids: list[uuid.UUID]

    @field_validator("entry_ids", mode="after")
    @classmethod
    def _deduplicate_ids(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        seen: set[uuid.UUID] = set()
        result: list[uuid.UUID] = []
        for entry_id in value:
            if entry_id in seen:
                continue
            seen.add(entry_id)
            result.append(entry_id)
        return result


EntryOut.model_rebuild()
