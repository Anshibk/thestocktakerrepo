"""enable google auth and invitations

Revision ID: 20250601120000
Revises: 20250520120500
Create Date: 2025-06-01 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision = "20250601120000"
down_revision = "20250520120500"
branch_labels: tuple[str, ...] | None = None
depends_on: tuple[str, ...] | None = None


def upgrade() -> None:
    # Drop reporting views that depend on users.username so we can alter the column
    op.execute("DROP VIEW IF EXISTS finished_goods_table")
    op.execute("DROP VIEW IF EXISTS semi_finished_table")
    op.execute("DROP VIEW IF EXISTS rawmaterials_table")
    op.execute("DROP VIEW IF EXISTS dashboard_modale_table")

    op.alter_column(
        "users",
        "username",
        existing_type=sa.String(length=60),
        type_=sa.String(length=120),
        existing_nullable=False,
    )
    op.alter_column(
        "users",
        "password",
        existing_type=sa.String(length=255),
        nullable=True,
    )
    op.add_column("users", sa.Column("email", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("google_sub", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("invitation_token", sa.String(length=128), nullable=True))
    op.add_column(
        "users",
        sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("invited_by_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_users_invited_by",
        "users",
        "users",
        ["invited_by_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "uq_users_email",
        "users",
        ["email"],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )
    op.create_index(
        "uq_users_google_sub",
        "users",
        ["google_sub"],
        unique=True,
        postgresql_where=sa.text("google_sub IS NOT NULL"),
    )
    op.create_index(
        "uq_users_invitation_token",
        "users",
        ["invitation_token"],
        unique=True,
        postgresql_where=sa.text("invitation_token IS NOT NULL"),
    )
    op.execute(
        "UPDATE users SET email = username WHERE email IS NULL AND position('@' in username) > 0"
    )

    # Recreate the reporting views with the wider username column available
    op.execute(
        """
        CREATE VIEW dashboard_modale_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            COALESCE(e.price_at_entry, i.price, 0) AS price,
            COALESCE(e.qty * COALESCE(e.price_at_entry, i.price, 0), 0) AS line_value,
            e.type,
            e.created_at
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id;
        """
    )
    op.execute(
        """
        CREATE VIEW rawmaterials_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'raw';
        """
    )
    op.execute(
        """
        CREATE VIEW semi_finished_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'sfg';
        """
    )
    op.execute(
        """
        CREATE VIEW finished_goods_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'fg';
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS finished_goods_table")
    op.execute("DROP VIEW IF EXISTS semi_finished_table")
    op.execute("DROP VIEW IF EXISTS rawmaterials_table")
    op.execute("DROP VIEW IF EXISTS dashboard_modale_table")

    op.execute(
        "UPDATE users SET email = NULL, google_sub = NULL, invitation_token = NULL, invited_at = NULL, invited_by_id = NULL"
    )
    op.drop_index("uq_users_invitation_token", table_name="users")
    op.drop_index("uq_users_google_sub", table_name="users")
    op.drop_index("uq_users_email", table_name="users")
    op.drop_constraint("fk_users_invited_by", "users", type_="foreignkey")
    op.drop_column("users", "invited_by_id")
    op.drop_column("users", "invited_at")
    op.drop_column("users", "invitation_token")
    op.drop_column("users", "google_sub")
    op.drop_column("users", "email")
    op.alter_column(
        "users",
        "password",
        existing_type=sa.String(length=255),
        nullable=False,
    )
    op.alter_column(
        "users",
        "username",
        existing_type=sa.String(length=120),
        type_=sa.String(length=60),
        existing_nullable=False,
    )

    op.execute(
        """
        CREATE VIEW dashboard_modale_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            COALESCE(e.price_at_entry, i.price, 0) AS price,
            COALESCE(e.qty * COALESCE(e.price_at_entry, i.price, 0), 0) AS line_value,
            e.type,
            e.created_at
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id;
        """
    )
    op.execute(
        """
        CREATE VIEW rawmaterials_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'raw';
        """
    )
    op.execute(
        """
        CREATE VIEW semi_finished_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'sfg';
        """
    )
    op.execute(
        """
        CREATE VIEW finished_goods_table AS
        SELECT
            e.id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            u.username,
            i.name AS item_name,
            c.name AS category_name,
            e.batch,
            e.qty,
            w.name AS warehouse,
            SUM(e.qty) OVER (PARTITION BY e.item_id) AS total_qty
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        JOIN warehouses w ON w.id = e.warehouse_id
        WHERE e.type = 'fg';
        """
    )
