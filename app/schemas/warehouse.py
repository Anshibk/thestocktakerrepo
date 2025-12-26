from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict


class WarehouseBase(BaseModel):
    name: str


class WarehouseCreate(WarehouseBase):
    pass


class WarehouseOut(WarehouseBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
