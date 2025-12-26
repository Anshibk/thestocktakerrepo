"""Add can_edit_add_item flag

Revision ID: 20250501120000
Revises: 20250420150000
Create Date: 2025-05-01 12:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20250501120000"
down_revision = "20250420150000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "roles",
        sa.Column("can_edit_add_item", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('roles')}
    if 'can_import_master_data' in columns:
        source_column = 'can_import_master_data'
    elif 'can_add_item' in columns:
        source_column = 'can_add_item'
    else:
        source_column = None

    if source_column:
        bind.execute(sa.text(f"UPDATE roles SET can_edit_add_item = {source_column}"))

    op.alter_column("roles", "can_edit_add_item", server_default=None)


def downgrade() -> None:
    op.drop_column("roles", "can_edit_add_item")
