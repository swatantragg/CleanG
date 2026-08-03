"""File activity logging for the admin Activity view.

`log_file_activity` records that a user worked on a named file — who, which
file, where in the app, when. Nothing about *what* was done: the view exists to
answer "user1 worked on file1.xlsx".

Like the security audit log it is best-effort: a logging failure must never break
the operation it is recording. Repeats are collapsed within a short window so the
preview-then-download round trip on one file reads as a single entry instead of
two identical lines a second apart.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FileActivity, User

# Repeats of the same user + file + area inside this window update the existing
# entry instead of adding a new one.
DEDUPE_WINDOW = timedelta(minutes=30)


def log_file_activity(db: Session, user: User, filename: str, area: str) -> None:
    name = (filename or "").strip()[:512]
    if not name:
        return
    try:
        recent = db.scalar(
            select(FileActivity)
            .where(
                FileActivity.user_id == user.id,
                FileActivity.filename == name,
                FileActivity.area == area[:64],
                FileActivity.created_at >= datetime.now(timezone.utc) - DEDUPE_WINDOW,
            )
            .order_by(FileActivity.created_at.desc())
            .limit(1)
        )
        if recent is not None:
            recent.created_at = datetime.now(timezone.utc)
        else:
            db.add(
                FileActivity(
                    user_id=user.id,
                    user_name=(user.full_name or "")[:255],
                    user_email=(user.email or "")[:255],
                    filename=name,
                    area=area[:64],
                )
            )
        db.commit()
    except Exception:
        # Activity logging is best-effort — never let it break the real operation.
        db.rollback()
