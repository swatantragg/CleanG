from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import User, UserRole
from .security import decode_access_token

settings = get_settings()

# auto_error=False: a missing Authorization header is fine because the token is
# normally delivered via the httpOnly session cookie instead.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login", auto_error=False)


def _extract_token(request: Request, bearer: str | None) -> str | None:
    # Prefer the httpOnly cookie (not reachable from JS, so XSS can't exfiltrate
    # it); fall back to a Bearer header for API/script clients.
    cookie = request.cookies.get(settings.cookie_name)
    return cookie or bearer


def get_authenticated_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the session to a live, active user. Does NOT enforce the
    password-change gate — used by the few self-service auth endpoints (me,
    logout, change-password) that must stay reachable while a change is pending."""
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    raw = _extract_token(request, token)
    if raw is None:
        raise credentials_error

    payload = decode_access_token(raw)
    if payload is None or "sub" not in payload:
        raise credentials_error

    try:
        user = db.get(User, int(payload["sub"]))
    except (TypeError, ValueError):
        raise credentials_error
    if user is None or not user.is_active:
        raise credentials_error
    # Reject tokens minted before the user's current version (revoked sessions).
    if payload.get("ver", 0) != user.token_version:
        raise credentials_error
    return user


def get_current_user(user: User = Depends(get_authenticated_user)) -> User:
    """The standard guard for application routes: a valid session AND no pending
    forced password change. While `must_change_password` is set, every protected
    route returns 403 `password_change_required` so the SPA can route the user
    straight to the change-password screen and nowhere else."""
    if user.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="password_change_required",
        )
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return current_user


# Roles that see and work on EVERY branch, not just their own. An admin has the
# full app (incl. user management); a super user is scoped to branches only — this
# helper is exactly the "any branch" privilege the two share.
BRANCH_ADMIN_ROLES = (UserRole.admin, UserRole.superuser)


def can_access_all_branches(user: User) -> bool:
    """True for admins and super users, who may view, edit and delete any branch;
    a plain user is limited to the branches they own."""
    return user.role in BRANCH_ADMIN_ROLES
