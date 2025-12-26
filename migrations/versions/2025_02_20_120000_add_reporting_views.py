"""add reporting support views

Revision ID: 20250220120000
Revises: 20250101000000
Create Date: 2025-02-20 12:00:00
"""

from __future__ import annotations

from alembic import op


revision = "20250220120000"
down_revision = "20250101000000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE VIEW dashboard_card AS
        WITH groups AS (
            SELECT
                cg.id,
                cg.name,
                COUNT(DISTINCT c.id) AS categories,
                COUNT(DISTINCT i.id) AS items
            FROM category_groups cg
            LEFT JOIN categories c ON c.group_id = cg.id
            LEFT JOIN items i ON i.category_id = c.id
            GROUP BY cg.id, cg.name
        ),
        owners AS (
            SELECT DISTINCT COALESCE(u.parent_admin_id, u.id) AS owner_admin_id
            FROM users u
            UNION
            SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM users)
        ),
        metrics AS (
            SELECT
                COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
                cg.id AS group_id,
                COUNT(DISTINCT e.item_id) AS counted,
                COALESCE(SUM(e.qty * COALESCE(e.price_at_entry, i.price, 0)), 0) AS total_value
            FROM entries e
            JOIN users u ON u.id = e.user_id
            JOIN items i ON i.id = e.item_id
            LEFT JOIN categories c ON c.id = i.category_id
            LEFT JOIN category_groups cg ON cg.id = c.group_id
            GROUP BY owner_admin_id, cg.id
        )
        SELECT
            o.owner_admin_id,
            g.name AS group_name,
            g.categories,
            g.items,
            COALESCE(m.counted, 0) AS counted,
            COALESCE(m.total_value, 0) AS total_value
        FROM owners o
        CROSS JOIN groups g
        LEFT JOIN metrics m
            ON m.owner_admin_id IS NOT DISTINCT FROM o.owner_admin_id
            AND m.group_id = g.id;
        """
    )

    op.execute(
        """
        CREATE VIEW dashboard_table AS
        SELECT
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            e.item_id,
            i.name AS item_name,
            c.name AS category_name,
            cg.name AS group_name,
            COUNT(DISTINCT e.batch) AS batches,
            COALESCE(SUM(e.qty), 0) AS total_qty,
            COALESCE(SUM(e.qty * COALESCE(e.price_at_entry, i.price, 0)), 0) AS total_value
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
        LEFT JOIN categories c ON c.id = e.category_id
        LEFT JOIN category_groups cg ON cg.id = c.group_id
        GROUP BY owner_admin_id, e.user_id, e.item_id, i.name, c.name, cg.name;
        """
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
        CREATE VIEW add_new_item_form AS
        SELECT
            i.id,
            i.name AS item_name,
            cg.name AS group_name,
            c.name AS sub_category,
            i.unit,
            i.price
        FROM items i
        LEFT JOIN categories c ON c.id = i.category_id
        LEFT JOIN category_groups cg ON cg.id = c.group_id;
        """
    )

    op.execute(
        """
        CREATE VIEW add_new_entry AS
        SELECT
            e.id,
            e.session_id,
            COALESCE(u.parent_admin_id, u.id) AS owner_admin_id,
            e.user_id,
            i.name AS item_name,
            e.qty,
            e.batch,
            w.name AS warehouse,
            e.type
        FROM entries e
        JOIN users u ON u.id = e.user_id
        JOIN items i ON i.id = e.item_id
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

    op.execute(
        """
        CREATE VIEW manage_data_group_table AS
        SELECT id, name FROM category_groups;
        """
    )

    op.execute(
        """
        CREATE VIEW manage_data_sub_categories_table AS
        SELECT
            c.id,
            cg.name AS parent_group,
            c.name AS sub_category_name
        FROM categories c
        JOIN category_groups cg ON cg.id = c.group_id;
        """
    )

    op.execute(
        """
        CREATE VIEW manage_data_warehouse_table AS
        SELECT id, name FROM warehouses;
        """
    )

    op.execute(
        """
        CREATE VIEW manage_data_metric_table AS
        SELECT id, name FROM metrics;
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS manage_data_metric_table")
    op.execute("DROP VIEW IF EXISTS manage_data_warehouse_table")
    op.execute("DROP VIEW IF EXISTS manage_data_sub_categories_table")
    op.execute("DROP VIEW IF EXISTS manage_data_group_table")
    op.execute("DROP VIEW IF EXISTS finished_goods_table")
    op.execute("DROP VIEW IF EXISTS semi_finished_table")
    op.execute("DROP VIEW IF EXISTS rawmaterials_table")
    op.execute("DROP VIEW IF EXISTS add_new_entry")
    op.execute("DROP VIEW IF EXISTS add_new_item_form")
    op.execute("DROP VIEW IF EXISTS dashboard_modale_table")
    op.execute("DROP VIEW IF EXISTS dashboard_table")
    op.execute("DROP VIEW IF EXISTS dashboard_card")
