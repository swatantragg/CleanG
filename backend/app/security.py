"""Password hashing (argon2), JWT access tokens, signed download tokens, and the
current-user dependency. Raw passwords are never stored or logged."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import settings
from .db import get_db
from .models import User

_ph = PasswordHasher()

# Distinct audiences so an access token can't be replayed as a download token.
_AUD_ACCESS = "access"
_AUD_DOWNLOAD = "download"


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, raw)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def _require_secret() -> str:
    if not settings.JWT_SECRET:
        raise HTTPException(500, "JWT_SECRET is not configured on the server.")
    return settings.JWT_SECRET


def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "aud": _AUD_ACCESS,
        "iat": now,
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_TTL_MINUTES),
    }
    return jwt.encode(payload, _require_secret(), algorithm=settings.JWT_ALG)


def sign_download_token(file_id: int, ttl_seconds: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "fid": file_id,
        "aud": _AUD_DOWNLOAD,
        "iat": now,
        "exp": now + timedelta(seconds=ttl_seconds),
    }
    return jwt.encode(payload, _require_secret(), algorithm=settings.JWT_ALG)


def verify_download_token(token: str) -> int:
    try:
        payload = jwt.decode(token, _require_secret(), algorithms=[settings.JWT_ALG], audience=_AUD_DOWNLOAD)
        return int(payload["fid"])
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired download token.")


def _decode_access(token: str) -> int:
    try:
        payload = jwt.decode(token, _require_secret(), algorithms=[settings.JWT_ALG], audience=_AUD_ACCESS)
        return int(payload["sub"])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token.")


async def current_user(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token.")
    user_id = _decode_access(authorization.split(" ", 1)[1].strip())
    user: Optional[User] = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account no longer exists.")
    return user


CurrentUser = Depends(current_user)
