from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict


class ItemBase(BaseModel):
    name: str
    unit: str
    price: Optional[Decimal] = None
    category_id: Optional[uuid.UUID] = None


class ItemCreate(ItemBase):
    pass


class ItemUpdate(BaseModel):
    name: Optional[str] = None
    unit: Optional[str] = None
    price: Optional[Decimal] = None
    category_id: Optional[uuid.UUID] = None


class ItemOut(ItemBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
