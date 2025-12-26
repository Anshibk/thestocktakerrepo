"""Add can_delete_users and can_delete_roles columns to roles table

Revision ID: 20250626120000
Revises: 20250601120000
Create Date: 2025-06-26 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20250626120000'
down_revision = '20250601120000'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('roles', sa.Column('can_delete_users', sa.Boolean(), nullable=True, server_default='false'))
    op.add_column('roles', sa.Column('can_delete_roles', sa.Boolean(), nullable=True, server_default='false'))
    
    # Set can_delete_users and can_delete_roles to true for roles that already have can_manage_users/can_manage_roles
    op.execute("UPDATE roles SET can_delete_users = can_manage_users WHERE can_manage_users = true")
    op.execute("UPDATE roles SET can_delete_roles = can_manage_roles WHERE can_manage_roles = true")


def downgrade() -> None:
    op.drop_column('roles', 'can_delete_roles')
    op.drop_column('roles', 'can_delete_users')
