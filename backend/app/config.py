"""Application settings. Secrets (DB URL, JWT secret) come strictly from the
environment / .env — never hardcoded. The .env file is authoritative so a
stray global env var cannot override it."""
import os


def _load_dotenv():
    path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            # .env wins over inherited shell env (assign, don't setdefault).
            os.environ[key.strip()] = value.strip()


_load_dotenv()


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(
            f"Missing required environment variable '{name}'. "
            f"Set it in backend/.env (see .env.example)."
        )
    return val


def _split_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


class Settings:
    # --- secrets: required, env-only ---
    DATABASE_URL = _require("DATABASE_URL")
    JWT_SECRET = _require("JWT_SECRET")

    # --- auth ---
    ALGORITHM = "HS256"
    ACCESS_TOKEN_TTL_MINUTES = int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "720"))

    # --- uploads ---
    MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
    ALLOWED_EXTENSIONS = {"csv", "tsv", "xlsx", "xls"}

    # --- concurrency ---
    LOCK_TTL_MINUTES = int(os.getenv("LOCK_TTL_MINUTES", "15"))  # stale-lock expiry

    # --- server / cors ---
    CORS_ORIGINS = _split_csv(os.getenv("CORS_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174"))
    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", "8000"))


settings = Settings()
