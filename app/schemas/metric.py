from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict


class MetricBase(BaseModel):
    name: str


class MetricCreate(MetricBase):
    pass


class MetricOut(MetricBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
