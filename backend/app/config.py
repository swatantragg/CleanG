from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Placeholder values shipped in .env.example. Booting with any of these in a
# real deployment is a critical risk (forgeable tokens / known admin password),
# so startup is aborted if they are detected.
_PLACEHOLDER_SECRETS = {
    "",
    "change-me-to-a-long-random-secret",
    "change-me-admin-password",
    "12345678",
}

# --- Daily report: hardcoded settings (NOT environment-configurable) --------
# Only the SMTP connection details live in .env; everything about WHEN the
# report runs and WHO receives it is fixed here.
REPORT_RECIPIENTS: list[str] = [
    "rahul.musicrightsmanagement@gmail.com",
    "swatantra.goongoonalo@gmail.com",
    "sherley@musicrightsmanagementindia.com",
    "devi@musicrightsmanagementindia.com",
    "vishal@musicrightsmanagementindia.com",
]
REPORT_ENABLED: bool = True
REPORT_HOUR: int = 10            # 10:30 = 10:30 AM ...
REPORT_MINUTE: int = 30
REPORT_TIMEZONE: str = "Asia/Kolkata"  # ... India time
# Gmail on port 587 uses STARTTLS (not implicit SSL).
SMTP_USE_TLS: bool = True
SMTP_USE_SSL: bool = False


class Settings(BaseSettings):
    """Application configuration loaded from environment / .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    secret_key: str
    access_token_expire_minutes: int = 60  # short-lived session token
    algorithm: str = "HS256"

    admin_email: str = "admin@mrmcleanser.com"
    admin_password: str
    admin_name: str = "Administrator"

    cors_origins: str = "http://localhost:5173"

    # Session cookie hardening. `cookie_secure` MUST stay true in production
    # (cookie only sent over HTTPS); set COOKIE_SECURE=false only for local
    # plain-HTTP development. `strict` SameSite is the default — this is a
    # same-origin SPA with no cross-site redirect flows, so it costs nothing and
    # closes the cross-site request surface further than `lax`.
    cookie_secure: bool = True
    cookie_samesite: str = "strict"
    cookie_name: str = "mrm_session"

    # CSRF double-submit token. A readable (non-httpOnly) cookie is set at login;
    # the SPA echoes it back in the header on every state-changing request, and
    # the server requires the two to match. A cross-site attacker can ride the
    # session cookie but cannot read the CSRF cookie (same-origin policy) to forge
    # the header.
    csrf_cookie_name: str = "mrm_csrf"
    csrf_header_name: str = "X-CSRF-Token"

    # Brute-force protection on the login endpoint.
    login_rate_limit: str = "10/minute"
    max_failed_logins: int = 5
    lockout_minutes: int = 15

    # Shared rate-limit storage. Default is per-process memory (fine for a single
    # worker / local dev); set REDIS_URL in production so limits hold across
    # workers and replicas. e.g. redis://redis:6379/0
    redis_url: str = ""

    # Throttles for expensive endpoints (uploads, exports, standardize, commit).
    heavy_rate_limit: str = "30/minute"
    upload_rate_limit: str = "20/minute"

    # Host header allowlist (TrustedHostMiddleware). Comma-separated. Leave as "*"
    # to disable the check; set to your real hostnames in production.
    trusted_hosts: str = "*"

    # --- SMTP for the daily report -----------------------------------------
    # Only the SMTP connection details come from the environment (.env); the
    # report recipients + schedule are hardcoded below. The digest is sent only
    # when SMTP is fully configured; otherwise the scheduler logs a warning and
    # skips (the app still boots normally).
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    # Envelope/From header. Defaults to SMTP_USER when blank. May include a
    # display name, e.g. "MRM Hub <rahul.musicrightsmanagement@gmail.com>".
    smtp_from: str = ""

    @property
    def smtp_sender(self) -> str:
        return self.smtp_from or self.smtp_user

    @property
    def report_recipient_list(self) -> list[str]:
        return list(REPORT_RECIPIENTS)

    @property
    def smtp_configured(self) -> bool:
        """True only when there is enough to actually send a mail."""
        return bool(self.smtp_host and self.smtp_sender and REPORT_RECIPIENTS)

    @property
    def trusted_host_list(self) -> list[str]:
        return [h.strip() for h in self.trusted_hosts.split(",") if h.strip()]

    @property
    def rate_limit_storage_uri(self) -> str:
        return self.redis_url or "memory://"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @model_validator(mode="after")
    def _reject_placeholder_secrets(self) -> "Settings":
        if self.secret_key in _PLACEHOLDER_SECRETS or len(self.secret_key) < 32:
            raise ValueError(
                "SECRET_KEY is unset, a known placeholder, or too short. "
                "Generate a strong value, e.g. `python -c \"import secrets; "
                "print(secrets.token_urlsafe(64))\"`, and set it in the environment."
            )
        if self.admin_password in _PLACEHOLDER_SECRETS or len(self.admin_password) < 12:
            raise ValueError(
                "ADMIN_PASSWORD is unset, a known placeholder, or shorter than 12 "
                "characters. Set a strong bootstrap admin password in the environment."
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
