# Stock Taker

Converted from the single-file HTML application into a FastAPI + PostgreSQL backend with a split frontend using Jinja templates and static assets. The project implements RBAC, per-user data isolation, and dashboard sharing controls.

## Requirements

- Python 3.11+
- PostgreSQL 14+

## Setup

1. Create a virtual environment and install dependencies:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Configure environment variables:

   ```bash
   cp .env.example .env
   # edit DATABASE_URL and SESSION_SECRET as needed (SESSION_SECRET must be >= 32 chars)
   # set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_SUPERUSER_EMAIL
   # leave SESSION_COOKIE_SECURE=true in production so session cookies are HTTPS-only
   ```

3. Run migrations and seed default data:

   ```bash
   alembic upgrade head
   python -m app.db.seed
   ```

4. Start the development server:

   ```bash
   uvicorn app.main:app --reload
   ```

The application now relies on Google OAuth for authentication. Define `GOOGLE_SUPERUSER_EMAIL` with the Gmail account that should
bootstrap the workspace. That superuser can invite additional Gmail accounts from **Users → Invite User**, and invited users join
by pasting their invitation code on the login screen before completing Google sign-in.

### Updating Tailwind styles

The application no longer pulls Tailwind CSS from a CDN so that the UI works on networks without external internet access. If you
change template markup and need to rebuild the bundled stylesheet, run:

```bash
npx tailwindcss@3.4.10 -i app/static/css/tailwind-input.css -o app/static/css/tailwind.css --minify
```

The Tailwind configuration lives in `tailwind.config.js`.
