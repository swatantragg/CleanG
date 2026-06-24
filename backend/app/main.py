import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from openpyxl import load_workbook
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select, text
from starlette.responses import Response

from .config import get_settings
from .core.limiter import limiter
from .database import Base, SessionLocal, engine
from .models import MasterColumn, User, UserRole
from .routers import auth, branches, clean, files, master, standardize, users
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
    # Cleaned rows are no longer persisted — drop the legacy table so its stale
    # rows can't block file/branch deletion via the old foreign key.
    db.execute(text("DROP TABLE IF EXISTS cleaned_rows"))
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
                )
            )
            db.commit()
        _seed_master_columns(db)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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


@app.get("/api/health")
def health():
    return {"status": "ok"}
