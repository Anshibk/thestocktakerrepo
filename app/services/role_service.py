from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models.role import DashboardScope, EntryScope, Role
from app.schemas.role import RoleCreate, RoleUpdate


class RoleInUseError(Exception):
    """Raised when attempting to delete a role that still has users."""


def list_roles(db: Session) -> list[Role]:
    return db.query(Role).order_by(Role.name).all()


def create_role(db: Session, payload: RoleCreate) -> Role:
    role = Role(**payload.dict())
    db.add(role)
    db.commit()
    db.refresh(role)
    return role


def update_role(db: Session, role_id: uuid.UUID, payload: RoleUpdate) -> Role:
    role = db.get(Role, role_id)
    if not role:
        raise ValueError("Role not found")
    data = payload.dict(exclude_unset=True)
    for key, value in data.items():
        setattr(role, key, value)
    db.commit()
    db.refresh(role)
    return role


def delete_role(db: Session, role_id: uuid.UUID) -> None:
    role = db.get(Role, role_id)
    if not role:
        raise ValueError("Role not found")
    if role.users:
        raise RoleInUseError("Cannot delete role with assigned users")
    db.delete(role)
    db.commit()
