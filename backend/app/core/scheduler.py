"""Daily-report scheduler.

A single APScheduler background job fires every day at the configured time
(default 10:30 Asia/Kolkata), builds the report and emails it. The job is
wrapped so any failure (SMTP down, etc.) is logged but never propagates.

`send_daily_report()` is also called directly by the manual /api/reports endpoint
so the report can be triggered on demand for testing.
"""

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from ..config import (
    REPORT_ENABLED,
    REPORT_HOUR,
    REPORT_MINUTE,
    REPORT_TIMEZONE,
    get_settings,
)
from ..database import SessionLocal
from .mailer import send_email
from .report import build_report_rows, render_report
from .report_settings import enabled_recipients, report_enabled

log = logging.getLogger("mrm.report")

_scheduler: BackgroundScheduler | None = None


def send_daily_report() -> dict:
    """Build the report from a fresh DB session and email it to every recipient
    switched on in the Mail tab. Returns a summary."""
    db = SessionLocal()
    try:
        recipients = enabled_recipients(db)
        rows = build_report_rows(db)
    finally:
        db.close()
    subject, text_body, html_body = render_report(rows)
    recipients = send_email(subject, html_body, text_body, recipients)
    return {"files": len(rows), "recipients": recipients, "subject": subject}


def _safe_send() -> None:
    try:
        # The job always stays scheduled; a super admin starts/stops the mail by
        # flipping this switch, checked fresh at every run.
        db = SessionLocal()
        try:
            enabled = report_enabled(db)
        finally:
            db.close()
        if not enabled:
            log.info("Daily report skipped: stopped from the Mail tab.")
            return
        result = send_daily_report()
        log.info("Daily report sent: %s", result)
    except Exception:
        log.exception("Daily report failed to send")


def next_run_time():
    """When the scheduled send fires next, or None if the scheduler is off."""
    if _scheduler is None:
        return None
    job = _scheduler.get_job("daily_report")
    return job.next_run_time if job is not None else None


def start_scheduler() -> None:
    global _scheduler
    if not REPORT_ENABLED:
        log.info("Daily report disabled.")
        return
    if not get_settings().smtp_configured:
        log.warning(
            "Daily report scheduler started but SMTP is not configured — "
            "set SMTP_HOST / SMTP_USER / SMTP_PASS in the environment to enable "
            "delivery."
        )
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone=REPORT_TIMEZONE)
    _scheduler.add_job(
        _safe_send,
        CronTrigger(hour=REPORT_HOUR, minute=REPORT_MINUTE, timezone=REPORT_TIMEZONE),
        id="daily_report",
        replace_existing=True,
        misfire_grace_time=3600,  # still send if the worker was briefly down
        coalesce=True,
    )
    _scheduler.start()
    log.info(
        "Daily report scheduled for %02d:%02d %s",
        REPORT_HOUR,
        REPORT_MINUTE,
        REPORT_TIMEZONE,
    )


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
