"""Add indexes to entries for common lookups

Revision ID: 20250515120000
Revises: 20250501120000
Create Date: 2025-05-15 12:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20250515120000"
down_revision = "20250501120000"
branch_labels = None
depends_on = None


INDEXES = (
    ("entries_created_at_idx", "created_at"),
    ("entries_item_id_idx", "item_id"),
    ("entries_user_id_idx", "user_id"),
)


def upgrade() -> None:
    for name, column in INDEXES:
        op.create_index(name, "entries", [column])


def downgrade() -> None:
    for name, _ in reversed(INDEXES):
        op.drop_index(name, table_name="entries")
