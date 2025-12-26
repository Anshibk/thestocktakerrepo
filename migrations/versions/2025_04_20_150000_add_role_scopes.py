"""Add granular share scopes to roles

Revision ID: 20250420150000
Revises: 20250405120000
Create Date: 2025-04-20 15:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20250420150000"
down_revision = "20250405120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "roles",
        sa.Column("add_item_scope", sa.String(length=10), nullable=False, server_default="own"),
    )
    op.add_column(
        "roles",
        sa.Column("raw_scope", sa.String(length=10), nullable=False, server_default="own"),
    )
    op.add_column(
        "roles",
        sa.Column("sfg_scope", sa.String(length=10), nullable=False, server_default="own"),
    )
    op.add_column(
        "roles",
        sa.Column("fg_scope", sa.String(length=10), nullable=False, server_default="own"),
    )
    op.add_column(
        "roles",
        sa.Column("can_edit_entry_raw", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("can_edit_entry_sfg", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "roles",
        sa.Column("can_edit_entry_fg", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.execute("UPDATE roles SET add_item_scope = COALESCE(dashboard_scope, 'own')")
    op.execute("UPDATE roles SET raw_scope = COALESCE(entry_scope, 'own')")
    op.execute("UPDATE roles SET sfg_scope = COALESCE(entry_scope, 'own')")
    op.execute("UPDATE roles SET fg_scope = COALESCE(entry_scope, 'own')")
    op.execute("UPDATE roles SET can_edit_entry_raw = COALESCE(can_add_entry_raw, FALSE)")
    op.execute("UPDATE roles SET can_edit_entry_sfg = COALESCE(can_add_entry_sfg, FALSE)")
    op.execute("UPDATE roles SET can_edit_entry_fg = COALESCE(can_add_entry_fg, FALSE)")

    op.alter_column("roles", "add_item_scope", server_default=None)
    op.alter_column("roles", "raw_scope", server_default=None)
    op.alter_column("roles", "sfg_scope", server_default=None)
    op.alter_column("roles", "fg_scope", server_default=None)
    op.alter_column("roles", "can_edit_entry_raw", server_default=None)
    op.alter_column("roles", "can_edit_entry_sfg", server_default=None)
    op.alter_column("roles", "can_edit_entry_fg", server_default=None)


def downgrade() -> None:
    op.drop_column("roles", "can_edit_entry_fg")
    op.drop_column("roles", "can_edit_entry_sfg")
    op.drop_column("roles", "can_edit_entry_raw")
    op.drop_column("roles", "fg_scope")
    op.drop_column("roles", "sfg_scope")
    op.drop_column("roles", "raw_scope")
    op.drop_column("roles", "add_item_scope")
