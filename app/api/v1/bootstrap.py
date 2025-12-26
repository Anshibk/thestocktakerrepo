from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user, get_db
from app.models.category import CategoryGroup, SubCategory
from app.models.metric import Metric
from app.models.session_inv import InventorySession
from app.models.user import User
from app.models.warehouse import Warehouse

router = APIRouter(prefix="/bootstrap", tags=["bootstrap"])

PERMISSION_FIELDS = [
    "can_view_dashboard",
    "can_view_add_item",
    "can_view_raw",
    "can_view_sfg",
    "can_view_fg",
    "can_view_manage_data",
    "can_view_users",
    "can_manage_users",
    "can_manage_roles",
    "can_import_master_data",
    "can_add_entry_raw",
    "can_add_entry_sfg",
    "can_add_entry_fg",
    "can_edit_entry_raw",
    "can_edit_entry_sfg",
    "can_edit_entry_fg",
    "can_edit_manage_data",
    "can_edit_add_item",
    "can_bulk_edit_delete_add_item",
    "can_bulk_edit_delete_raw",
    "can_bulk_edit_delete_sfg",
    "can_bulk_edit_delete_fg",
    "can_export_dashboard_summary",
    "can_export_dashboard_entries",
    "can_view_dashboard_cards",
    "can_open_dashboard_modal",
]


@router.get("/")
def bootstrap(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    groups = db.query(CategoryGroup).order_by(CategoryGroup.name).all()
    subs = db.query(SubCategory).order_by(SubCategory.name).all()
    metrics = db.query(Metric).order_by(Metric.name).all()
    warehouses = db.query(Warehouse).order_by(Warehouse.name).all()
    location_payload = [{"id": str(w.id), "name": w.name} for w in warehouses]
    sessions = db.query(InventorySession).order_by(InventorySession.name).all()
    role = current_user.role
    return {
        "user": {
            "id": str(current_user.id),
            "name": current_user.name,
            "role": role.name,
            "permissions": {field: getattr(role, field) for field in PERMISSION_FIELDS},
            "dashboard_scope": role.dashboard_scope,
            "entry_scope": getattr(role, "entry_scope", None),
            "share_scopes": {
                "dashboard": getattr(role, "dashboard_scope", None),
                "add_item": getattr(role, "add_item_scope", None),
                "raw": getattr(role, "raw_scope", None),
                "sfg": getattr(role, "sfg_scope", None),
                "fg": getattr(role, "fg_scope", None),
            },
        },
        "groups": [{"id": str(g.id), "name": g.name} for g in groups],
        "subcategories": [
            {"id": str(s.id), "name": s.name, "group_id": str(s.group_id)} for s in subs
        ],
        "metrics": [{"id": str(m.id), "name": m.name} for m in metrics],
        "locations": location_payload,
        "warehouses": location_payload,
        "sessions": [{"id": str(s.id), "code": s.code, "name": s.name} for s in sessions],
    }
