from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr

from app.schemas.role import RoleOut


class UserCreate(BaseModel):
    email: EmailStr
    name: str  # Name is now required
    role_id: uuid.UUID
    dashboard_share_enabled: bool = False
    is_active: bool = True


class UserUpdate(BaseModel):
    name: Optional[str] = None
    role_id: Optional[uuid.UUID] = None
    is_active: Optional[bool] = None
    dashboard_share_enabled: Optional[bool] = None
    regenerate_invitation: Optional[bool] = None


class UserOut(BaseModel):
    id: uuid.UUID
    name: str
    username: str
    email: Optional[str]
    is_active: bool
    dashboard_share_enabled: bool
    role: RoleOut
    parent_admin_id: Optional[uuid.UUID]
    invited_by_id: Optional[uuid.UUID]
    invited_at: Optional[datetime]
    invitation_token: Optional[str]
    google_linked: bool

    model_config = ConfigDict(from_attributes=True)
