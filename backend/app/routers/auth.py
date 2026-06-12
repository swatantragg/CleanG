from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import User
from ..schemas import LoginBody, TokenResponse, UserCreate, UserRead
from ..security import CurrentUser, create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

# Reserved / throwaway domains that produced the dummy accounts (x.com, example.*,
# RFC-2606 test domains). Registrations here are rejected so junk data can't seed the DB.
_BLOCKED_EMAIL_DOMAINS = {
    "x.com", "example.com", "example.org", "example.net",
    "test.com", "test", "localhost", "invalid", "mailinator.com",
}


def _reject_throwaway(email: str) -> None:
    domain = email.rsplit("@", 1)[-1].lower()
    if domain in _BLOCKED_EMAIL_DOMAINS:
        raise HTTPException(422, "Please register with a real email address.")


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(body: UserCreate, db: AsyncSession = Depends(get_db)):
    _reject_throwaway(str(body.email))
    exists = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if exists:
        raise HTTPException(409, "An account with this email already exists.")
    user = User(name=body.name.strip(), email=str(body.email), password_hash=hash_password(body.password))
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return TokenResponse(access_token=create_access_token(user.id), user=UserRead.model_validate(user))


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginBody, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Invalid email or password.")
    return TokenResponse(access_token=create_access_token(user.id), user=UserRead.model_validate(user))


@router.get("/me", response_model=UserRead)
async def me(user: User = CurrentUser):
    return user
