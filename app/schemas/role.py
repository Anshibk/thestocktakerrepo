from __future__ import annotations

import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.models.role import DashboardScope, EntryScope


class RoleBase(BaseModel):
    name: str
    can_view_dashboard: bool = True
    can_view_add_item: bool = True
    can_view_raw: bool = True
    can_view_sfg: bool = True
    can_view_fg: bool = True
    can_view_manage_data: bool = True
    can_view_users: bool = False
    can_manage_users: bool = False
    can_manage_roles: bool = False
    can_delete_users: bool = False
    can_delete_roles: bool = False

    can_import_master_data: bool = False
    can_add_entry_raw: bool = False
    can_add_entry_sfg: bool = False
    can_add_entry_fg: bool = False
    can_edit_entry_raw: bool = False
    can_edit_entry_sfg: bool = False
    can_edit_entry_fg: bool = False
    can_edit_manage_data: bool = False
    can_edit_add_item: bool = False

    can_bulk_edit_delete_add_item: bool = False
    can_bulk_edit_delete_raw: bool = False
    can_bulk_edit_delete_sfg: bool = False
    can_bulk_edit_delete_fg: bool = False

    can_export_dashboard_summary: bool = False
    can_export_dashboard_entries: bool = False

    can_view_dashboard_cards: bool = True
    can_open_dashboard_modal: bool = True

    dashboard_scope: DashboardScope = DashboardScope.OWN
    entry_scope: EntryScope = EntryScope.OWN
    add_item_scope: DashboardScope = DashboardScope.OWN
    raw_scope: EntryScope = EntryScope.OWN
    sfg_scope: EntryScope = EntryScope.OWN
    fg_scope: EntryScope = EntryScope.OWN


class RoleCreate(RoleBase):
    pass


class RoleUpdate(RoleBase):
    name: Optional[str] = None


class RoleOut(RoleBase):
    id: uuid.UUID

    model_config = ConfigDict(from_attributes=True)
