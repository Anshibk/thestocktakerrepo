from __future__ import annotations

from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.schemas.auth import AuthResponse
from app.services import auth_service


router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/google/start")
def start_google_oauth(
    request: Request,
    invitation_token: str | None = None,
    next: str | None = None,
):
    redirect_url = auth_service.build_google_oauth_redirect(request, invitation_token, next)
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/google/callback")
def google_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    if error:
        message = quote_plus(error)
        return RedirectResponse(url=f"/login?error={message}", status_code=status.HTTP_303_SEE_OTHER)
    if not code:
        return RedirectResponse(url="/login?error=missing_code", status_code=status.HTTP_303_SEE_OTHER)
    try:
        next_url = auth_service.complete_google_oauth(db, request, code, state)
    except HTTPException as exc:
        message = quote_plus(str(exc.detail))
        return RedirectResponse(url=f"/login?error={message}", status_code=status.HTTP_303_SEE_OTHER)
    return RedirectResponse(url=next_url or "/dashboard", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/logout", response_model=AuthResponse)
def logout(request: Request):
    request.session.clear()
    return AuthResponse(ok=True)
