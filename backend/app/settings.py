"""Env-driven settings. No external deps — reads os.environ / .env if present."""
import os
from urllib.parse import quote_plus


def _load_dotenv() -> None:
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())


_load_dotenv()


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


# ---- HTTP ----
CORS_ORIGINS = [o.strip() for o in _env("CORS_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174").split(",") if o.strip()]
API_PREFIX = "/api"
# Absolute base used to build signed download URLs (no trailing slash).
PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")

# ---- Database (PostgreSQL, async driver) ----
POSTGRES_USER = _env("POSTGRES_USER")
POSTGRES_PASSWORD = _env("POSTGRES_PASSWORD")
POSTGRES_HOST = _env("POSTGRES_HOST")
POSTGRES_PORT = _env("POSTGRES_PORT", "5432") or "5432"
POSTGRES_DB = _env("POSTGRES_DB")
_DATABASE_URL = _env("DATABASE_URL")


def database_url(driver: str = "asyncpg") -> str | None:
    """SQLAlchemy URL for the given driver, or None when DB is unconfigured.

    `driver` is "asyncpg" for the app/Alembic async engine, "psycopg2" only if a
    sync engine is ever needed.
    """
    if _DATABASE_URL:
        # Normalize the driver on an explicit override.
        url = _DATABASE_URL
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", f"postgresql+{driver}://", 1)
        return url
    if POSTGRES_USER and POSTGRES_HOST and POSTGRES_DB:
        pw = quote_plus(POSTGRES_PASSWORD)
        return f"postgresql+{driver}://{POSTGRES_USER}:{pw}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    return None


# ---- Auth (JWT + argon2) ----
JWT_SECRET = _env("JWT_SECRET")  # REQUIRED in production; blank disables token issue
JWT_ALG = "HS256"
ACCESS_TOKEN_TTL_MINUTES = int(_env("ACCESS_TOKEN_TTL_MINUTES", "720") or "720")

# ---- Storage / signed downloads ----
# Only the CLEANED output is stored in object storage (Google Drive).
# Source files are stored as text in Postgres.
SIGNED_URL_TTL_SECONDS = int(_env("SIGNED_URL_TTL_SECONDS", "300") or "300")
GOOGLE_APPLICATION_CREDENTIALS = _env("GOOGLE_APPLICATION_CREDENTIALS")  # path to service-account JSON file
GOOGLE_DRIVE_FOLDER_ID = _env("GOOGLE_DRIVE_FOLDER_ID")  # parent folder id for the cleaned files

# Branch retention
BRANCH_TTL_DAYS = int(_env("BRANCH_TTL_DAYS", "7") or "7")
MAX_UPLOAD_BYTES = int(_env("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)) or str(20 * 1024 * 1024))
