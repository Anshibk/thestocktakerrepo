"""expand role permissions

Revision ID: 20250301120000
Revises: 20250220120000
Create Date: 2025-03-01 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20250301120000"
down_revision = "20250220120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "roles",
        sa.Column("can_manage_users", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("can_manage_roles", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("can_export_dashboard_summary", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("can_export_dashboard_entries", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("entry_scope", sa.String(length=10), nullable=False, server_default="own"),
    )

    op.execute(
        "UPDATE roles SET dashboard_scope = 'org' WHERE dashboard_scope IN ('all', 'team')"
    )


def downgrade() -> None:
    op.drop_column("roles", "entry_scope")
    op.drop_column("roles", "can_export_dashboard_entries")
    op.drop_column("roles", "can_export_dashboard_summary")
    op.drop_column("roles", "can_manage_roles")
    op.drop_column("roles", "can_manage_users")
