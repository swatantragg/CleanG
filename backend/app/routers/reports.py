"""Daily report mail (super admin only): start/stop the scheduled send, choose
who receives it, and trigger it on demand."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import REPORT_HOUR, REPORT_MINUTE, REPORT_TIMEZONE, get_settings
from ..core.audit import log_event
from ..core.report_settings import report_enabled, set_report_enabled
from ..core.scheduler import next_run_time, send_daily_report
from ..database import get_db
from ..deps import require_super_admin
from ..models import ReportRecipient, User
from ..schemas import (
    ReportRecipientCreate,
    ReportRecipientOut,
    ReportRecipientUpdate,
    ReportSettingsOut,
    ReportSettingsUpdate,
)

router = APIRouter(prefix="/api/reports", tags=["reports"])


def _settings_out(db: Session) -> ReportSettingsOut:
    settings = get_settings()
    return ReportSettingsOut(
        enabled=report_enabled(db),
        smtp_configured=settings.smtp_configured,
        sender=settings.smtp_sender,
        schedule=f"{REPORT_HOUR:02d}:{REPORT_MINUTE:02d}",
        timezone=REPORT_TIMEZONE,
        next_run=next_run_time(),
        recipients=db.scalars(select(ReportRecipient).order_by(ReportRecipient.id)).all(),
    )


def _get_recipient_or_404(recipient_id: int, db: Session) -> ReportRecipient:
    recipient = db.get(ReportRecipient, recipient_id)
    if recipient is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recipient not found")
    return recipient


@router.get("/settings", response_model=ReportSettingsOut)
def get_report_settings(
    db: Session = Depends(get_db),
    _super: User = Depends(require_super_admin),
):
    return _settings_out(db)


@router.patch("/settings", response_model=ReportSettingsOut)
def update_report_settings(
    request: Request,
    payload: ReportSettingsUpdate,
    db: Session = Depends(get_db),
    super_admin: User = Depends(require_super_admin),
):
    """Start or stop the scheduled daily send."""
    set_report_enabled(db, payload.enabled)
    db.commit()
    log_event(db, request, "report_started" if payload.enabled else "report_stopped",
              user=super_admin)
    return _settings_out(db)


@router.post("/recipients", response_model=ReportRecipientOut,
             status_code=status.HTTP_201_CREATED)
def add_recipient(
    request: Request,
    payload: ReportRecipientCreate,
    db: Session = Depends(get_db),
    super_admin: User = Depends(require_super_admin),
):
    email = payload.email.strip().lower()
    exists = db.scalar(
        select(ReportRecipient).where(func.lower(ReportRecipient.email) == email)
    )
    if exists is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This email is already on the list.")
    recipient = ReportRecipient(email=email, enabled=True)
    db.add(recipient)
    db.commit()
    db.refresh(recipient)
    log_event(db, request, "report_recipient_added", user=super_admin, detail=email)
    return recipient


@router.patch("/recipients/{recipient_id}", response_model=ReportRecipientOut)
def toggle_recipient(
    request: Request,
    recipient_id: int,
    payload: ReportRecipientUpdate,
    db: Session = Depends(get_db),
    super_admin: User = Depends(require_super_admin),
):
    recipient = _get_recipient_or_404(recipient_id, db)
    recipient.enabled = payload.enabled
    db.commit()
    db.refresh(recipient)
    log_event(db, request, "report_recipient_updated", user=super_admin,
              detail=f"{recipient.email}: {'on' if recipient.enabled else 'off'}")
    return recipient


@router.delete("/recipients/{recipient_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_recipient(
    request: Request,
    recipient_id: int,
    db: Session = Depends(get_db),
    super_admin: User = Depends(require_super_admin),
):
    recipient = _get_recipient_or_404(recipient_id, db)
    email = recipient.email
    db.delete(recipient)
    db.commit()
    log_event(db, request, "report_recipient_removed", user=super_admin, detail=email)


@router.post("/daily/send")
def send_daily_report_now(
    request: Request,
    db: Session = Depends(get_db),
    super_admin: User = Depends(require_super_admin),
):
    """Build and email the daily report immediately (for testing the schedule).
    Sends even while the scheduled run is stopped."""
    try:
        result = send_daily_report()
    except RuntimeError as e:
        # Configuration problem (SMTP not set, nobody switched on) — say so.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"Failed to send report: {e}"
        )
    log_event(
        db, request, "report_sent", user=super_admin,
        detail=f"{result['files']} files -> {', '.join(result['recipients'])}",
    )
    return result
