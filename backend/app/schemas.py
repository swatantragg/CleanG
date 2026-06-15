"""Pydantic request/response models."""
from typing import Any, Optional

from pydantic import BaseModel, field_validator

from .models import UserRole


# ---- auth ----
class SignupIn(BaseModel):
    email: str
    password: str
    name: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters")
        return v


class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    role: UserRole
    name: Optional[str] = None


class UserOut(BaseModel):
    id: str
    email: str
    role: UserRole
    name: Optional[str] = None
    is_active: bool


# ---- pipeline ----
class CleanIn(BaseModel):
    rawRows: list[dict[str, Any]]
    fields: list[dict[str, Any]]
    mapping: dict[str, list[str]]


class ValidateIn(BaseModel):
    records: list[dict[str, Any]]


class UploadIn(BaseModel):
    records: list[dict[str, Any]]
    source_format: Optional[str] = None  # 'SVF' | 'PDL'


class ApproveIn(BaseModel):
    record: dict[str, Any]


class ExtractIn(BaseModel):
    preset: str
    extra: list[str] = []
    fields: list[dict[str, Any]]


# ---- concurrency ----
class SaveIn(BaseModel):
    version: int                       # version the client loaded (optimistic check)
    changes: dict[str, Any]            # field_name -> new value
    status: Optional[str] = None       # optional new status
