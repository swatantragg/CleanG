"""Pydantic v2 request/response DTOs. UserRead never exposes password_hash."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class BranchStatus(str, Enum):
    active = "active"
    expired = "expired"
    deleted = "deleted"
    purge_failed = "purge_failed"


class Visibility(str, Enum):
    private = "private"
    shared = "shared"


class FileKind(str, Enum):
    source = "source"
    cleaned = "cleaned"


class FileStatus(str, Enum):
    available = "available"
    purged = "purged"


_orm = ConfigDict(from_attributes=True)


# ---- auth / users ----
class UserCreate(BaseModel):
    name: str = Field(min_length=1)
    email: EmailStr
    password: str = Field(min_length=8)


class UserRead(BaseModel):
    model_config = _orm
    id: int
    name: str
    email: str
    created_at: datetime
    updated_at: datetime


class LoginBody(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


# ---- presets ----
class PresetCreate(BaseModel):
    name: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)
    is_shared: bool = False


class PresetUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    is_shared: Optional[bool] = None


class PresetRead(BaseModel):
    model_config = _orm
    id: int
    owner_id: Optional[int]
    name: str
    config: dict[str, Any]
    is_shared: bool
    created_at: datetime
    updated_at: datetime


# ---- branches ----
class BranchCreate(BaseModel):
    name: str = Field(min_length=1)
    preset_id: Optional[int] = None
    visibility: Visibility = Visibility.shared


class BranchUpdate(BaseModel):
    name: Optional[str] = None
    visibility: Optional[Visibility] = None
    preset_id: Optional[int] = None


class BranchRead(BaseModel):
    model_config = _orm
    id: int
    user_id: int
    preset_id: Optional[int]
    name: str
    status: BranchStatus
    visibility: Visibility
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    deleted_at: Optional[datetime]
    purged_at: Optional[datetime]


class CleanRequest(BaseModel):
    """Cleaning spec chosen in the wizard: a primary key plus either a preset or a
    custom set of output columns. All optional so a bare POST still runs (passthrough)."""
    primary_key: Optional[str] = None
    preset_id: Optional[int] = None
    columns: Optional[list[str]] = None  # custom mode: output columns besides the primary key


class BranchWithOwner(BranchRead):
    owner_name: Optional[str] = None
    cleaned_file_id: Optional[int] = None
    cleaned_filename: Optional[str] = None
    cleaned_size_bytes: Optional[int] = None


# ---- files ----
class FileRead(BaseModel):
    model_config = _orm
    id: int
    branch_id: int
    kind: FileKind
    original_filename: Optional[str]
    mime_type: Optional[str]
    size_bytes: Optional[int]
    status: FileStatus
    created_at: datetime
    purged_at: Optional[datetime]
    # storage_key is intentionally NOT exposed.


class SignedUrlResponse(BaseModel):
    url: str
    expires_in: int
