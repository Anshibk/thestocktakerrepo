from __future__ import annotations

import enum
import uuid

from sqlalchemy import Boolean, Column, Enum, String
from sqlalchemy.dialects.postgresql import UUID

from app.db.base import Base


class DashboardScope(str, enum.Enum):
    OWN = "own"
    ORG = "org"


class EntryScope(str, enum.Enum):
    OWN = "own"
    ORG = "org"


class Role(Base):
    __tablename__ = "roles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), unique=True, nullable=False)

    can_view_dashboard = Column(Boolean, default=True)
    can_view_add_item = Column(Boolean, default=True)
    can_view_raw = Column(Boolean, default=True)
    can_view_sfg = Column(Boolean, default=True)
    can_view_fg = Column(Boolean, default=True)
    can_view_manage_data = Column(Boolean, default=True)
    can_view_users = Column(Boolean, default=False)

    can_manage_users = Column(Boolean, default=False)
    can_manage_roles = Column(Boolean, default=False)
    can_delete_users = Column(Boolean, default=False)
    can_delete_roles = Column(Boolean, default=False)

    can_import_master_data = Column("can_add_item", Boolean, default=False)
    can_add_entry_raw = Column(Boolean, default=False)
    can_add_entry_sfg = Column(Boolean, default=False)
    can_add_entry_fg = Column(Boolean, default=False)
    can_edit_entry_raw = Column(Boolean, default=False)
    can_edit_entry_sfg = Column(Boolean, default=False)
    can_edit_entry_fg = Column(Boolean, default=False)
    can_edit_manage_data = Column(Boolean, default=False)
    can_edit_add_item = Column(Boolean, default=False)

    can_bulk_edit_delete_add_item = Column("can_bulk_edit_add_item", Boolean, default=False)
    can_bulk_edit_delete_raw = Column("can_bulk_edit_raw", Boolean, default=False)
    can_bulk_edit_delete_sfg = Column("can_bulk_edit_sfg", Boolean, default=False)
    can_bulk_edit_delete_fg = Column("can_bulk_edit_fg", Boolean, default=False)

    can_export_dashboard_summary = Column(Boolean, default=False)
    can_export_dashboard_entries = Column(Boolean, default=False)

    can_view_dashboard_cards = Column(Boolean, default=True)
    can_open_dashboard_modal = Column(Boolean, default=True)

    dashboard_scope = Column(
        Enum(DashboardScope, name="dashboard_scope", native_enum=False),
        default=DashboardScope.OWN,
        nullable=False,
    )
    add_item_scope = Column(
        Enum(DashboardScope, name="add_item_scope_enum", native_enum=False),
        default=DashboardScope.OWN,
        nullable=False,
    )
    entry_scope = Column(
        Enum(EntryScope, name="entry_scope", native_enum=False),
        default=EntryScope.OWN,
        nullable=False,
    )
    raw_scope = Column(
        Enum(EntryScope, name="raw_scope_enum", native_enum=False),
        default=EntryScope.OWN,
        nullable=False,
    )
    sfg_scope = Column(
        Enum(EntryScope, name="sfg_scope_enum", native_enum=False),
        default=EntryScope.OWN,
        nullable=False,
    )
    fg_scope = Column(
        Enum(EntryScope, name="fg_scope_enum", native_enum=False),
        default=EntryScope.OWN,
        nullable=False,
    )
