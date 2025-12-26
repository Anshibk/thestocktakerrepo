from __future__ import annotations

import os
from pathlib import Path
import asyncio

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from app.api.v1 import auth, bootstrap, categories, dashboard, entries, items, metrics, roles, users, warehouses
from app.core.config import settings
from app.core.deps import get_current_user
from app.core.realtime import entry_event_broker

settings.validate_runtime()

# Auto-run migrations on startup (for cloud deployment)
def run_migrations():
    try:
        from alembic.config import Config
        from alembic import command
        alembic_cfg = Config("alembic.ini")
        command.upgrade(alembic_cfg, "head")
        print("✓ Database migrations completed successfully")
    except Exception as e:
        print(f"⚠ Migration error (may be OK if already up to date): {e}")

# Run migrations before app starts
if os.getenv("RUN_MIGRATIONS", "true").lower() == "true":
    run_migrations()

# Seed default data
try:
    from app.db.seed import seed
    seed()
    print("✓ Database seeded successfully")
except Exception as e:
    print(f"⚠ Seed error (may be OK if already seeded): {e}")

app = FastAPI(title="Stock Taker")
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    same_site="lax",
    https_only=settings.session_cookie_secure,
)

static_dir = Path(__file__).parent / "static"
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

app.include_router(auth.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")
app.include_router(roles.router, prefix="/api/v1")
app.include_router(categories.router, prefix="/api/v1")
app.include_router(warehouses.router, prefix="/api/v1")
app.include_router(metrics.router, prefix="/api/v1")
app.include_router(items.router, prefix="/api/v1")
app.include_router(entries.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
app.include_router(bootstrap.router, prefix="/api/v1")


@app.on_event("startup")
async def configure_broker() -> None:
    entry_event_broker.configure(queue_size=settings.entry_event_queue_size)
    entry_event_broker.set_loop(asyncio.get_running_loop())


@app.get("/healthz")
def health_check():
    """Health check endpoint for Render/Railway/load balancers."""
    return {"status": "ok"}


@app.get("/")
def root(request: Request):
    if "user_id" not in request.session:
        return RedirectResponse(url="/login")
    return RedirectResponse(url="/dashboard")


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    google_oauth_configured = bool(
        settings.google_client_id and 
        settings.google_client_secret and 
        settings.google_redirect_uri
    )
    return templates.TemplateResponse("login.html", {
        "request": request,
        "google_oauth_configured": google_oauth_configured,
        "open_signup": settings.open_signup,
    })


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("dashboard/index.html", {"request": request, "user": user})


@app.get("/add-item", response_class=HTMLResponse)
def add_item_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("add_item/index.html", {"request": request, "user": user})


@app.get("/raw-materials", response_class=HTMLResponse)
def raw_materials_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("raw_materials/index.html", {"request": request, "user": user})


@app.get("/semi-finished", response_class=HTMLResponse)
def semi_finished_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("semi_finished/index.html", {"request": request, "user": user})


@app.get("/finished-goods", response_class=HTMLResponse)
def finished_goods_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("finished_goods/index.html", {"request": request, "user": user})


@app.get("/manage-data", response_class=HTMLResponse)
def manage_data_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("manage_data/index.html", {"request": request, "user": user})


@app.get("/users", response_class=HTMLResponse)
def users_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("users/index.html", {"request": request, "user": user})


@app.get("/roles", response_class=HTMLResponse)
def roles_page(request: Request, user=Depends(get_current_user)):
    return templates.TemplateResponse("roles/index.html", {"request": request, "user": user})
