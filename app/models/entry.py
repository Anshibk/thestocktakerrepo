from __future__ import annotations

import enum
import uuid

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Numeric, String, TIMESTAMP, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class EntryType(str, enum.Enum):
    RAW = "raw"
    SFG = "sfg"
    FG = "fg"


class Entry(Base):
    __tablename__ = "entries"
    __table_args__ = (
        CheckConstraint("type in ('raw','sfg','fg')", name="ck_entries_type"),
        Index("entries_created_at_idx", "created_at"),
        Index("entries_item_id_idx", "item_id"),
        Index("entries_user_id_idx", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions_inv.id"), nullable=False)
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id"), nullable=False)
    category_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    type: Mapped[EntryType] = mapped_column(Enum(EntryType, name="entry_type"), nullable=False)
    unit: Mapped[str] = mapped_column(String(40), nullable=False)
    qty: Mapped[float] = mapped_column(Numeric(14, 3), nullable=False)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"), nullable=False)
    batch: Mapped[str | None] = mapped_column(String(120), nullable=True)
    mfg: Mapped[str | None] = mapped_column(String(32), nullable=True)
    exp: Mapped[str | None] = mapped_column(String(32), nullable=True)
    price_at_entry: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    created_at = mapped_column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    session = relationship("app.models.session_inv.InventorySession")
    item = relationship("app.models.item.Item")
    warehouse = relationship("app.models.warehouse.Warehouse")
    category = relationship("app.models.category.SubCategory")
    user = relationship("app.models.user.User")
