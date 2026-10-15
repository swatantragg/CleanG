from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.audit import log_event
from ..core.csrf import issue_csrf_token
from ..core.limiter import limiter
from ..database import get_db
from ..deps import get_authenticated_user, user_out
from ..models import User
from ..schemas import ChangePassword, LoginRequest, UserOut
from ..security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    hash_password,
    verify_password,
)

settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    max_age = settings.access_token_expire_minutes * 60
    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )
    # The CSRF companion cookie is deliberately readable by JS (not httpOnly) so
    # the SPA can echo it back in the request header. Pairing the session cookie
    # with a value an attacker's page cannot read is what defeats CSRF.
    response.set_cookie(
        key=settings.csrf_cookie_name,
        value=issue_csrf_token(),
        max_age=max_age,
        httponly=False,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    for key in (settings.cookie_name, settings.csrf_cookie_name):
        response.delete_cookie(
            key=key,
            secure=settings.cookie_secure,
            samesite=settings.cookie_samesite,
            path="/",
        )


@router.post("/login", response_model=UserOut)
@limiter.limit(settings.login_rate_limit)
def login(
    request: Request,
    response: Response,
    payload: LoginRequest,
    db: Session = Depends(get_db),
):
    """Authenticate and issue a session as an httpOnly cookie.

    The token is never exposed to JavaScript (cookie is httpOnly), and repeated
    failures lock the account for a cooldown window to blunt brute force. The
    endpoint is also IP rate-limited via slowapi.
    """
    # A generic error for every auth failure — never reveal whether the email
    # exists, the password was wrong, or the account is disabled/locked.
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Incorrect email or password",
    )
    now = datetime.now(timezone.utc)
    user = db.scalar(select(User).where(User.email == payload.email))

    if user is None:
        # Spend the same bcrypt work as a real verify against a fixed dummy hash,
        # so response time can't reveal whether the email exists (no enumeration).
        verify_password(payload.password, DUMMY_PASSWORD_HASH)
        log_event(db, request, "login_failed", email=payload.email,
                  detail="unknown email")
        raise invalid

    if user.locked_until is not None and user.locked_until > now:
        log_event(db, request, "login_blocked", user=user, detail="account locked")
        raise invalid

    if not verify_password(payload.password, user.hashed_password):
        user.failed_logins += 1
        locked = user.failed_logins >= settings.max_failed_logins
        if locked:
            user.locked_until = now + timedelta(minutes=settings.lockout_minutes)
            user.failed_logins = 0
        db.commit()
        log_event(db, request, "login_locked" if locked else "login_failed",
                  user=user, detail="bad password")
        raise invalid

    if not user.is_active:
        log_event(db, request, "login_blocked", user=user, detail="inactive account")
        raise invalid

    # Success — reset the lockout counters and issue the cookie.
    user.failed_logins = 0
    user.locked_until = None
    db.commit()
    log_event(db, request, "login_success", user=user)

    token = create_access_token(str(user.id), user.token_version)
    _set_session_cookie(response, token)
    return user_out(user, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_authenticated_user),
):
    """Revoke the current session everywhere and clear the cookie."""
    current_user.token_version += 1
    db.commit()
    log_event(db, request, "logout", user=current_user)
    _clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_authenticated_user)):
    return user_out(current_user, current_user)


@router.post("/change-password", response_model=UserOut)
def change_password(
    request: Request,
    response: Response,
    payload: ChangePassword,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_authenticated_user),
):
    """Self-service password change. Requires the current password, enforces the
    strength policy on the new one, clears any forced-rotation flag, and revokes
    all other sessions (then re-issues a fresh one for this device).

    Reachable while a forced change is pending — it's how the user gets unblocked.
    """
    if not verify_password(payload.current_password, current_user.hashed_password):
        log_event(db, request, "password_change_failed", user=current_user,
                  detail="wrong current password")
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Current password is incorrect."
        )
    if verify_password(payload.new_password, current_user.hashed_password):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "New password must be different from the current one.",
        )
    current_user.hashed_password = hash_password(payload.new_password)
    current_user.must_change_password = False
    # Revoke every existing session, including this one's old token...
    current_user.token_version += 1
    db.commit()
    log_event(db, request, "password_changed", user=current_user)
    # ...then mint a new session so the user stays logged in on this device.
    token = create_access_token(str(current_user.id), current_user.token_version)
    _set_session_cookie(response, token)
    return user_out(current_user, current_user)
