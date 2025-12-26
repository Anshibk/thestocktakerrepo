from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.core.config import settings


# Optimized connection pooling for faster database access
engine = create_engine(
    settings.database_url,
    echo=False,
    future=True,
    poolclass=QueuePool,
    pool_size=5,           # Keep 5 connections ready
    max_overflow=10,       # Allow 10 extra connections when busy
    pool_timeout=30,       # Wait 30s for connection
    pool_recycle=1800,     # Recycle connections after 30 minutes
    pool_pre_ping=True,    # Check connection health before use
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False, future=True)


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
