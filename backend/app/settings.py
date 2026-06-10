"""Env-driven settings. No external deps — reads os.environ / .env if present."""
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


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
# Single source of truth: DATABASE_URL (e.g. a managed Postgres like Neon), so the
# whole team works against the same data. There is no local POSTGRES_* fallback.
_DATABASE_URL = _env("DATABASE_URL")

# libpq-only query params that the asyncpg driver does not accept — stripped from
# the URL. SSL intent is re-applied via asyncpg_connect_args() instead.
_LIBPQ_ONLY_QS = {"sslmode", "channel_binding", "gssencmode"}


def database_url(driver: str = "asyncpg") -> str | None:
    """SQLAlchemy URL for the given driver, or None when DATABASE_URL is unset.

    `driver` is "asyncpg" for the app/Alembic async engine, "psycopg2" only if a
    sync engine is ever needed.
    """
    if not _DATABASE_URL:
        return None
    url = _DATABASE_URL
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            url = url.replace(prefix, f"postgresql+{driver}://", 1)
            break
    parts = urlsplit(url)
    qs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in _LIBPQ_ONLY_QS]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(qs), parts.fragment))


def _ssl_required() -> bool:
    if not _DATABASE_URL:
        return False
    qs = dict(parse_qsl(urlsplit(_DATABASE_URL).query))
    # Neon and most managed Postgres default to requiring TLS.
    return qs.get("sslmode", "require").lower() not in ("disable", "allow", "prefer")


def asyncpg_connect_args() -> dict:
    """Extra connect args for the asyncpg engine (TLS, since libpq params are stripped)."""
    return {"ssl": True} if _ssl_required() else {}


# ---- Auth (JWT + argon2) ----
JWT_SECRET = _env("JWT_SECRET")  # REQUIRED in production; blank disables token issue
JWT_ALG = "HS256"
ACCESS_TOKEN_TTL_MINUTES = int(_env("ACCESS_TOKEN_TTL_MINUTES", "720") or "720")

# ---- Storage / signed downloads ----
# Only the CLEANED output is stored in object storage (Google Drive).
# Source files are stored as text in Postgres.
SIGNED_URL_TTL_SECONDS = int(_env("SIGNED_URL_TTL_SECONDS", "300") or "300")
# "local" → cleaned output stays in Postgres (no external creds; dev default).
# "drive" → cleaned output goes to Google Drive (needs the vars below).
STORAGE_BACKEND = _env("STORAGE_BACKEND", "local").lower() or "local"
GOOGLE_APPLICATION_CREDENTIALS = _env("GOOGLE_APPLICATION_CREDENTIALS")  # path to service-account JSON file
GOOGLE_DRIVE_FOLDER_ID = _env("GOOGLE_DRIVE_FOLDER_ID")  # parent folder id for the cleaned files

# Branch retention
BRANCH_TTL_DAYS = int(_env("BRANCH_TTL_DAYS", "7") or "7")
MAX_UPLOAD_BYTES = int(_env("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)) or str(20 * 1024 * 1024))
