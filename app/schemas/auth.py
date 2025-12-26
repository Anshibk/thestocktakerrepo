from __future__ import annotations

from pydantic import BaseModel


class AuthResponse(BaseModel):
    ok: bool
