import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings

settings = get_settings()


def _normalize_url(url: str) -> str:
    """Use the psycopg3 driver for plain postgres URLs (e.g. Neon strings)."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    return url


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# Connection resilience. Without a connect_timeout, a single database blip makes
# every connection attempt hang indefinitely — including the one in the startup
# lifespan — which leaves the API "up" but wedged (permanent 502) long after the
# database has recovered. A bounded timeout turns that into a fast, retryable
# error instead. All values are env-overridable so they can be tuned per deploy.
_CONNECT_TIMEOUT = _int_env("DB_CONNECT_TIMEOUT", 10)

# pool_pre_ping keeps Neon's serverless connections healthy across idle periods.
# The pool is bounded so a burst of concurrent requests can't open unbounded
# connections and exhaust the (shared) database's connection limit.
engine = create_engine(
    _normalize_url(settings.database_url),
    pool_pre_ping=True,
    pool_recycle=300,
    pool_size=_int_env("DB_POOL_SIZE", 5),
    max_overflow=_int_env("DB_MAX_OVERFLOW", 10),
    pool_timeout=_int_env("DB_POOL_TIMEOUT", 30),
    connect_args={
        "connect_timeout": _CONNECT_TIMEOUT,
        # Server-side guard: auto-close a connection left idle inside a
        # transaction (a leaked session from a crashed worker) so it can't hold a
        # slot forever and exhaust the database's connection limit.
        "options": "-c idle_in_transaction_session_timeout="
        + str(_int_env("DB_IDLE_TX_TIMEOUT_MS", 60000)),
    },
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency that yields a database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
