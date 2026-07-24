from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import log_event
from ..database import get_db
from ..deps import require_admin
from ..models import AuditEvent, FileActivity, User
from ..schemas import (
    AuditEventOut,
    FileActivityOut,
    PasswordReset,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..security import hash_password

router = APIRouter(prefix="/api/users", tags=["users"])


def _get_user_or_404(user_id: int, db: Session) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    return db.scalars(select(User).order_by(User.created_at.desc())).all()


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    request: Request,
    payload: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only: provision an account. There is no public registration."""
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this email already exists",
        )
    user = User(
        email=payload.email,
        full_name=payload.full_name,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        # The admin set this initial password, so the new user must pick their own.
        must_change_password=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_event(db, request, "user_created", user=admin,
              detail=f"created {user.email} (role={user.role.value}, id={user.id})")
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    request: Request,
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only: change a user's role or active state.

    Disabling an account (or any change) bumps `token_version`, which revokes
    every outstanding session for that user immediately.
    """
    user = _get_user_or_404(user_id, db)
    if user.id == admin.id and payload.is_active is False:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account."
        )
    changes = []
    if payload.role is not None and payload.role != user.role:
        changes.append(f"role {user.role.value}->{payload.role.value}")
        user.role = payload.role
    if payload.is_active is not None and payload.is_active != user.is_active:
        changes.append(f"active {user.is_active}->{payload.is_active}")
        user.is_active = payload.is_active
        if payload.is_active is False:
            user.token_version += 1
    db.commit()
    db.refresh(user)
    if changes:
        log_event(db, request, "user_updated", user=admin,
                  detail=f"{user.email} (id={user.id}): {', '.join(changes)}")
    return user


@router.post("/{user_id}/reset-password", response_model=UserOut)
def reset_password(
    request: Request,
    user_id: int,
    payload: PasswordReset,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only: set a new password and revoke the user's existing sessions."""
    user = _get_user_or_404(user_id, db)
    user.hashed_password = hash_password(payload.password)
    # The admin chose this password, so force the user to set their own next login.
    user.must_change_password = True
    # Invalidate any token issued before the reset, and clear any lockout.
    user.token_version += 1
    user.failed_logins = 0
    user.locked_until = None
    db.commit()
    db.refresh(user)
    log_event(db, request, "password_reset", user=admin,
              detail=f"reset password for {user.email} (id={user.id})")
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    request: Request,
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Admin-only: permanently delete a user account.

    A user with committed data (owns branches that already wrote to the master
    set) cannot be hard-deleted without losing that audit chain, so the FK
    blocks it — deactivate those accounts instead. Security audit rows are kept
    but detached (user_id -> NULL) so the trail survives the deletion.
    """
    user = _get_user_or_404(user_id, db)
    if user.id == admin.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot delete your own account."
        )
    email = user.email
    # Preserve the security audit trail but detach it from the row being removed.
    db.execute(
        update(AuditEvent).where(AuditEvent.user_id == user.id).values(user_id=None)
    )
    try:
        db.delete(user)  # cascades to the user's branches + their uploaded files
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This user owns branches with committed data and can't be deleted. "
            "Deactivate the account instead.",
        )
    log_event(
        db, request, "user_deleted", user=admin,
        detail=f"deleted {email} (id={user_id})",
    )


@router.get("/activity", response_model=list[FileActivityOut])
def file_activity(
    limit: int = Query(200, ge=1, le=1000),
    user_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Admin-only: which files each user worked on, most recent first.

    Optionally narrowed to one user. It reports the file and the area of the app
    only — never what was done to the data.
    """
    query = select(FileActivity).order_by(FileActivity.created_at.desc()).limit(limit)
    if user_id is not None:
        query = query.where(FileActivity.user_id == user_id)
    return db.scalars(query).all()


@router.get("/audit", response_model=list[AuditEventOut])
def audit_events(
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Admin-only: the security audit trail (logins, lockouts, user changes,
    password resets), most recent first."""
    return db.scalars(
        select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)
    ).all()
