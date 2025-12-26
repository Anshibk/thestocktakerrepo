from __future__ import annotations

from app.db.session import SessionLocal
from app.models.category import CategoryGroup, SubCategory
from app.models.metric import Metric
from app.models.role import DashboardScope, EntryScope, Role
from app.models.session_inv import InventorySession
from app.models.user import User

DEFAULT_METRICS = ["ltr", "kg", "gm", "nos"]

DEFAULT_GROUPS = {
    "Raw Materials": ["Herbs", "Powders"],
    "Semi Finished Goods": ["Majun (Semi Finished)", "Roghan (Semi Finished)"],
    "Finished Goods": ["Majun", "Syrup (Semi Finished)", "Roghan"],
}


def seed() -> None:
    with SessionLocal() as db:
        default_role = db.query(Role).filter(Role.name == "Default").one_or_none()
        if not default_role:
            default_role = Role(
                name="Default",
                can_view_dashboard=True,
                can_view_add_item=True,
                can_view_raw=True,
                can_view_sfg=True,
                can_view_fg=True,
                can_view_manage_data=True,
                can_view_users=True,
                can_manage_users=True,
                can_manage_roles=True,
                can_import_master_data=True,
                can_add_entry_raw=True,
                can_add_entry_sfg=True,
                can_add_entry_fg=True,
                can_edit_entry_raw=True,
                can_edit_entry_sfg=True,
                can_edit_entry_fg=True,
                can_edit_manage_data=True,
                can_edit_add_item=True,
                can_bulk_edit_delete_add_item=True,
                can_bulk_edit_delete_raw=True,
                can_bulk_edit_delete_sfg=True,
                can_bulk_edit_delete_fg=True,
                can_export_dashboard_summary=True,
                can_export_dashboard_entries=True,
                can_view_dashboard_cards=True,
                can_open_dashboard_modal=True,
                dashboard_scope=DashboardScope.ORG,
                entry_scope=EntryScope.ORG,
                add_item_scope=DashboardScope.ORG,
                raw_scope=EntryScope.ORG,
                sfg_scope=EntryScope.ORG,
                fg_scope=EntryScope.ORG,
            )
            db.add(default_role)
            db.flush()

        for metric in DEFAULT_METRICS:
            if not db.query(Metric).filter(Metric.name == metric).count():
                db.add(Metric(name=metric))

        for group_name, subs in DEFAULT_GROUPS.items():
            group = db.query(CategoryGroup).filter(CategoryGroup.name == group_name).one_or_none()
            if not group:
                group = CategoryGroup(name=group_name)
                db.add(group)
                db.flush()
            for sub in subs:
                exists = (
                    db.query(SubCategory)
                    .filter(SubCategory.group_id == group.id, SubCategory.name == sub)
                    .one_or_none()
                )
                if not exists:
                    db.add(SubCategory(name=sub, group_id=group.id))

        if not db.query(InventorySession).count():
            db.add(InventorySession(code="2025-09", name="Sep-2025 Monthly", status="active"))

        db.commit()


if __name__ == "__main__":
    seed()
