"""ORM models — mapped 1:1 to the canonical Postgres schema.

Column names, types, constraints, FK ondelete, and indexes match the SQL exactly.
The DB owns updated_at via BEFORE UPDATE triggers (created in the Alembic migration);
models declare server defaults so a fresh insert matches the DB.
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

_TS = DateTime(timezone=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())

    branches: Mapped[List["Branch"]] = relationship(back_populates="user")
    presets: Mapped[List["Preset"]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class Preset(Base):
    __tablename__ = "presets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    owner_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    is_shared: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())

    owner: Mapped[Optional["User"]] = relationship(back_populates="presets")
    branches: Mapped[List["Branch"]] = relationship(back_populates="preset")


class Branch(Base):
    __tablename__ = "branches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('active','expired','deleted','purge_failed')", name="branches_status_check"
        ),
        CheckConstraint("visibility IN ('private','shared')", name="branches_visibility_check"),
        Index("branches_user_id_idx", "user_id"),
        Index("branches_preset_id_idx", "preset_id"),
        Index("branches_expiry_idx", "expires_at", postgresql_where=text("status = 'active'")),
        Index("branches_shared_idx", "visibility", postgresql_where=text("status = 'active'")),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    preset_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("presets.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    visibility: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'shared'"))
    created_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(
        _TS, nullable=False, server_default=text("now() + INTERVAL '7 days'")
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(_TS, nullable=True)
    purged_at: Mapped[Optional[datetime]] = mapped_column(_TS, nullable=True)

    user: Mapped["User"] = relationship(back_populates="branches")
    preset: Mapped[Optional["Preset"]] = relationship(back_populates="branches")
    files: Mapped[List["File"]] = relationship(
        back_populates="branch", cascade="all, delete-orphan"
    )


class File(Base):
    __tablename__ = "files"
    __table_args__ = (
        CheckConstraint("kind IN ('source','cleaned','corrupted','staging')", name="files_kind_check"),
        CheckConstraint("status IN ('available','purged')", name="files_status_check"),
        Index("files_branch_id_idx", "branch_id"),
        Index("files_branch_kind_idx", "branch_id", "kind"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    branch_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("branches.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Source files are stored as TEXT in the DB (storage_key = ''); cleaned files
    # are stored in Drive (storage_key = Drive file id, content = NULL).
    storage_key: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Raw bytes for source uploads (and locally-stored cleaned output). Binary-safe,
    # unlike the legacy TEXT `content` column which cannot hold NUL bytes (e.g. .xlsx).
    content_bytes: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    original_filename: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    mime_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'available'"))
    created_at: Mapped[datetime] = mapped_column(_TS, nullable=False, server_default=func.now())
    purged_at: Mapped[Optional[datetime]] = mapped_column(_TS, nullable=True)

    branch: Mapped["Branch"] = relationship(back_populates="files")
