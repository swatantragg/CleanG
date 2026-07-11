import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from openpyxl import load_workbook
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select, text
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import Response

from .config import get_settings
from .core.csrf import csrf_protect
from .core.dynamic_columns import make_attr, quote_ident, sync_custom_columns
from .core.limiter import limiter
from .core.scheduler import shutdown_scheduler, start_scheduler
from .database import Base, SessionLocal, engine
from .models import MasterColumn, User, UserRole
from .routers import auth, branches, clean, files, master, reports, standardize, users
from .security import hash_password

settings = get_settings()

MASTER_FILE = os.path.join(os.path.dirname(__file__), "data", "master_output_format.xlsx")


def _seed_master_columns(db) -> None:
    """Load the canonical output schema from the bundled master workbook."""
    if db.scalar(select(MasterColumn).limit(1)) is not None:
        return
    wb = load_workbook(MASTER_FILE, data_only=True)
    ws = wb.active
    position = 0
    for cell in ws[1]:
        value = cell.value
        if value is None or str(value).strip() == "":
            continue
        position += 1
        db.add(MasterColumn(position=position, name=str(value).strip()))
    db.commit()


def _migrate(db) -> None:
    """Add the review-overlay columns to pre-existing tables (idempotent).

    `create_all` only creates missing tables, never alters existing ones, so the
    `corrections`/`dropped` columns are added here for databases created before
    cleaning moved fully in-memory.
    """
    db.execute(text(
        "ALTER TABLE uploaded_files "
        "ADD COLUMN IF NOT EXISTS corrections JSONB NOT NULL DEFAULT '{}'::jsonb"
    ))
    db.execute(text(
        "ALTER TABLE uploaded_files "
        "ADD COLUMN IF NOT EXISTS dropped JSONB NOT NULL DEFAULT '[]'::jsonb"
    ))
    db.execute(text(
        "ALTER TABLE uploaded_files "
        "ADD COLUMN IF NOT EXISTS accepted JSONB NOT NULL DEFAULT '[]'::jsonb"
    ))
    db.execute(text(
        "ALTER TABLE uploaded_files "
        "ADD COLUMN IF NOT EXISTS constants JSONB NOT NULL DEFAULT '{}'::jsonb"
    ))
    # Merge-origin marks for review cells (tagged "Merged value" vs a hand edit).
    db.execute(text(
        "ALTER TABLE uploaded_files "
        "ADD COLUMN IF NOT EXISTS merged_cells JSONB NOT NULL DEFAULT '{}'::jsonb"
    ))
    # Forced-password-rotation flag, added for databases created before it existed.
    db.execute(text(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE"
    ))
    # Custom (user-added) master columns: a flag + physical column name on the
    # schema table. Their values are now REAL columns on master_data.
    db.execute(text(
        "ALTER TABLE master_columns "
        "ADD COLUMN IF NOT EXISTS custom BOOLEAN NOT NULL DEFAULT FALSE"
    ))
    db.execute(text(
        "ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS attr VARCHAR"
    ))
    db.commit()
    # Promote any legacy `extras` JSON values into real columns, then retire the
    # bag entirely (idempotent: a no-op on databases without the legacy column).
    _migrate_custom_columns(db)
    db.execute(text("ALTER TABLE master_data DROP COLUMN IF EXISTS extras"))
    # Cleaned rows are no longer persisted — drop the legacy table so its stale
    # rows can't block file/branch deletion via the old foreign key.
    db.execute(text("DROP TABLE IF EXISTS cleaned_rows"))
    db.commit()


def _migrate_custom_columns(db) -> None:
    """Back-fill custom columns from the legacy `master_data.extras` JSON bag into
    dedicated real columns. Idempotent and safe on fresh databases.

    For each custom master column: ensure it has a physical `attr`, add the real
    column (metadata-only with its default), and copy any value that lived in the
    `extras` bag into it. Identifiers are regex-validated and quoted.
    """
    has_extras = db.scalar(text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'master_data' AND column_name = 'extras'"
    ))
    rows = db.execute(text(
        "SELECT id, name, attr FROM master_columns WHERE custom = TRUE"
    )).all()
    taken = {r.attr for r in rows if r.attr}
    for r in rows:
        attr = r.attr
        if not attr:
            attr = make_attr(r.name, taken)
            taken.add(attr)
            db.execute(
                text("UPDATE master_columns SET attr = :a WHERE id = :i"),
                {"a": attr, "i": r.id},
            )
        db.execute(text(
            f"ALTER TABLE master_data ADD COLUMN IF NOT EXISTS "
            f"{quote_ident(attr)} VARCHAR NOT NULL DEFAULT ''"
        ))
        if has_extras:
            db.execute(
                text(
                    f"UPDATE master_data SET {quote_ident(attr)} = extras ->> :n "
                    "WHERE extras ->> :n IS NOT NULL"
                ),
                {"n": r.name},
            )
    db.commit()


def init_db() -> None:
    """Create tables and seed the bootstrap admin + master schema if missing."""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        _migrate(db)
        has_user = db.scalar(select(User).limit(1))
        if has_user is None:
            db.add(
                User(
                    email=settings.admin_email,
                    full_name=settings.admin_name,
                    hashed_password=hash_password(settings.admin_password),
                    role=UserRole.admin,
                    # The bootstrap password comes from the environment and is
                    # known to whoever deployed it — force a change on first login.
                    must_change_password=True,
                )
            )
            db.commit()
        _seed_master_columns(db)
        # Attach every custom column to the ORM mapper so this process can
        # read/write them like built-ins from the first request.
        sync_custom_columns(db)
    finally:
        db.close()


async def _init_db_with_retry() -> None:
    """Run init_db(), retrying a transient database outage instead of wedging.

    A short database blip at boot used to hang the startup lifespan forever (no
    connect timeout), leaving the API permanently returning 502 even after the
    database recovered — a manual restart was the only way out. With a bounded
    connect timeout, each attempt now fails fast; we retry with backoff so a brief
    outage is ridden out in-process, and only a sustained outage lets the process
    exit so the orchestrator (restart: unless-stopped) restarts it cleanly.
    """
    import asyncio
    import logging

    from sqlalchemy.exc import DBAPIError, OperationalError

    log = logging.getLogger("uvicorn.error")
    attempts = int(os.getenv("DB_INIT_ATTEMPTS", "8"))
    for i in range(1, attempts + 1):
        try:
            await asyncio.to_thread(init_db)
            return
        except (OperationalError, DBAPIError) as exc:
            if i == attempts:
                log.error("Database unreachable after %d attempts; giving up so "
                          "the orchestrator can restart the process.", attempts)
                raise
            delay = min(2.0 * 2 ** (i - 1), 20.0)
            log.warning("init_db attempt %d/%d failed (%s); retrying in %.0fs",
                        i, attempts, type(exc).__name__, delay)
            await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _init_db_with_retry()
    start_scheduler()  # daily report email (10:30 IST by default)
    try:
        yield
    finally:
        shutdown_scheduler()


def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> Response:
    return Response(
        '{"detail":"Too many requests. Please slow down and try again."}',
        status_code=429,
        media_type="application/json",
    )


app = FastAPI(title="MRM Cleanser API", version="0.1.0", lifespan=lifespan)

# Rate limiting (slowapi): the limiter is shared via app.core.limiter so routers
# can decorate individual endpoints (e.g. login) with @limiter.limit(...).
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

# Reject requests with an unexpected Host header (host-header poisoning) unless
# the allowlist is left as the "*" wildcard (local dev / not yet configured).
if "*" not in settings.trusted_host_list:
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.trusted_host_list
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # The CSRF token travels in this header, so it must be allowed cross-origin.
    allow_headers=["Authorization", "Content-Type", settings.csrf_header_name],
)

# CSRF double-submit enforcement for cookie-authenticated, state-changing calls.
app.middleware("http")(csrf_protect)


_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    # API responses never need to be embedded or to load remote resources.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    # Ignored over plain HTTP; enforced once the app is served behind TLS.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for key, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(branches.router)
app.include_router(master.router)
app.include_router(files.router)
app.include_router(clean.router)
app.include_router(standardize.router)
app.include_router(reports.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
