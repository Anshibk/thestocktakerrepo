"""add mfg and exp columns to entries

Revision ID: 20250405120000
Revises: 20250301120000
Create Date: 2025-04-05 12:00:00
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20250405120000"
down_revision = "20250301120000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("entries", sa.Column("mfg", sa.String(length=32), nullable=True))
    op.add_column("entries", sa.Column("exp", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("entries", "exp")
    op.drop_column("entries", "mfg")

