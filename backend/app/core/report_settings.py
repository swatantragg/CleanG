"""Daily-report switches stored in the database (managed from the Mail tab).

Two things live here: whether the scheduled send runs at all, and who receives
it. Both used to be hardcoded in config.py; that list now only seeds the table
once, so a super admin's later edits (including removing every address) stick.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import REPORT_ENABLED, REPORT_RECIPIENTS
from ..models import AppSetting, ReportRecipient

REPORT_ENABLED_KEY = "report_enabled"
# Marks the one-time seed from config.REPORT_RECIPIENTS as done.
RECIPIENTS_SEEDED_KEY = "report_recipients_seeded"


def _get(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row is not None else None


def _set(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value


def report_enabled(db: Session) -> bool:
    value = _get(db, REPORT_ENABLED_KEY)
    return REPORT_ENABLED if value is None else value == "true"


def set_report_enabled(db: Session, enabled: bool) -> None:
    _set(db, REPORT_ENABLED_KEY, "true" if enabled else "false")


def enabled_recipients(db: Session) -> list[str]:
    return list(
        db.scalars(
            select(ReportRecipient.email)
            .where(ReportRecipient.enabled.is_(True))
            .order_by(ReportRecipient.id)
        )
    )


def seed_report_settings(db: Session) -> None:
    """Copy the hardcoded recipient list into the table, exactly once."""
    if _get(db, RECIPIENTS_SEEDED_KEY) is not None:
        return
    existing = {e.lower() for e in db.scalars(select(ReportRecipient.email))}
    for email in REPORT_RECIPIENTS:
        if email.lower() not in existing:
            db.add(ReportRecipient(email=email.lower(), enabled=True))
    _set(db, RECIPIENTS_SEEDED_KEY, "true")
    db.commit()
