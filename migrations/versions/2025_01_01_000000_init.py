"""initial schema

Revision ID: 20250101000000
Revises: 
Create Date: 2025-01-01 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "20250101000000"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=100), nullable=False, unique=True),
        sa.Column("can_view_dashboard", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_add_item", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_raw", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_sfg", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_fg", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_manage_data", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_view_users", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_add_item", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_add_entry_raw", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_add_entry_sfg", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_add_entry_fg", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_edit_manage_data", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_bulk_edit_add_item", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_bulk_edit_raw", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_bulk_edit_sfg", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_bulk_edit_fg", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_view_dashboard_cards", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_open_dashboard_modal", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("dashboard_scope", sa.String(length=10), nullable=False, server_default="own"),
    )

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("username", sa.String(length=60), nullable=False, unique=True),
        sa.Column("password", sa.String(length=255), nullable=False),
        sa.Column("role_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roles.id"), nullable=False),
        sa.Column("parent_admin_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("dashboard_share_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )

    op.create_table(
        "category_groups",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False, unique=True),
    )

    op.create_table(
        "categories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("group_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("category_groups.id"), nullable=False),
        sa.UniqueConstraint("group_id", "name", name="uq_category_group_name"),
    )

    op.create_table(
        "metrics",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=50), nullable=False, unique=True),
    )

    op.create_table(
        "warehouses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False, unique=True),
    )

    op.create_table(
        "sessions_inv",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(length=60), nullable=False, unique=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="active"),
    )

    op.create_table(
        "items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=200), nullable=False, unique=True),
        sa.Column("unit", sa.String(length=40), nullable=False),
        sa.Column("price", sa.Numeric(12, 2)),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("categories.id")),
    )

    op.create_table(
        "entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sessions_inv.id"), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("items.id"), nullable=False),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("categories.id")),
        sa.Column("type", sa.String(length=10), nullable=False),
        sa.Column("unit", sa.String(length=40), nullable=False),
        sa.Column("qty", sa.Numeric(14, 3), nullable=False),
        sa.Column("warehouse_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("warehouses.id"), nullable=False),
        sa.Column("batch", sa.String(length=120)),
        sa.Column("price_at_entry", sa.Numeric(12, 2)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("entries")
    op.drop_table("items")
    op.drop_table("sessions_inv")
    op.drop_table("warehouses")
    op.drop_table("metrics")
    op.drop_table("categories")
    op.drop_table("category_groups")
    op.drop_table("users")
    op.drop_table("roles")
