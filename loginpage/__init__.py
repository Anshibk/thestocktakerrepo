from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models.user import User

from passlib.context import CryptContext


pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except ValueError:
        # Fallback for legacy plain-text passwords
        return plain_password == hashed_password


def authenticate(db: Session, username: str, password: str) -> Optional[User]:
    """Authenticate a user against the stored (hashed) password."""
    username = username.strip()
    user = (
        db.query(User)
        .filter(User.username.ilike(username))
        .filter(User.is_active.is_(True))
        .first()
    )
    if user and verify_password(password, user.password):
        return user
    return None
