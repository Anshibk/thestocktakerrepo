from __future__ import annotations

import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict


class CategoryGroupBase(BaseModel):
    name: str


class CategoryGroupCreate(CategoryGroupBase):
    pass


class CategoryGroupOut(CategoryGroupBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)


class SubCategoryBase(BaseModel):
    name: str
    group_id: uuid.UUID


class SubCategoryCreate(SubCategoryBase):
    pass


class SubCategoryUpdate(BaseModel):
    name: Optional[str] = None
    group_id: Optional[uuid.UUID] = None


class SubCategoryOut(SubCategoryBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
