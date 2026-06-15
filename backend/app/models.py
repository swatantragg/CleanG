"""ORM schema: users, the shared master records store with concurrency
control, the change-log audit trail, and the dedup skip log.

Music/custom data fields (the 29 fields + any dynamic columns) stay fully
nullable and live in the `data` JSON document on each master record.
The system/auth columns below are REQUIRED because login and concurrent
cleaning cannot work with null ids, versions, or timestamps."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, Boolean, Integer, DateTime, ForeignKey,
    Enum as SAEnum, JSON,
)

from .database import Base
from .db_types import GUID


def _new_uuid():
    return uuid.uuid4()


# ---- enumerations ----
class UserRole(str, enum.Enum):
    admin = "admin"
    cleaner = "cleaner"
    viewer = "viewer"


class RecordStatus(str, enum.Enum):
    raw = "raw"
    in_progress = "in_progress"
    cleaned = "cleaned"
    verified = "verified"


class SourceFormat(str, enum.Enum):
    SVF = "SVF"
    PDL = "PDL"


# ---- tables ----
class User(Base):
    __tablename__ = "users"

    id = Column(GUID, primary_key=True, default=_new_uuid)
    name = Column(String, nullable=True)
    email = Column(String, nullable=False, unique=True, index=True)
    # If using an external auth/OAuth provider, store provider_user_id here.
    password_hash = Column(String, nullable=False)
    role = Column(SAEnum(UserRole, name="user_role"), nullable=False, default=UserRole.cleaner)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    last_login_at = Column(DateTime(timezone=True), nullable=True)


class MasterRecord(Base):
    __tablename__ = "master_records"

    # Surrogate PK — ISRC is nullable and cannot be the key.
    id = Column(GUID, primary_key=True, default=_new_uuid)

    # Music data (29 fields) + custom fields — all nullable — as a JSON document.
    data = Column(JSON, nullable=False, default=dict)
    dedup_key = Column(String, nullable=True, index=True)

    # System / concurrency columns
    source_format = Column(SAEnum(SourceFormat, name="source_format"), nullable=True)
    status = Column(SAEnum(RecordStatus, name="record_status"), nullable=False, default=RecordStatus.raw)
    assigned_to = Column(GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    locked_by = Column(GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    locked_at = Column(DateTime(timezone=True), nullable=True)
    version = Column(Integer, nullable=False, default=0)  # optimistic concurrency
    created_by = Column(GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ChangeLog(Base):
    """Audit trail: one row per field change during cleaning."""
    __tablename__ = "change_log"

    id = Column(GUID, primary_key=True, default=_new_uuid)
    record_id = Column(GUID, ForeignKey("master_records.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(GUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    field_name = Column(String, nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    changed_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class DedupEntry(Base):
    """Candidates skipped on write because a matching master record existed."""
    __tablename__ = "dedup_log"

    id = Column(GUID, primary_key=True, default=_new_uuid)
    triggered_by = Column(GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    singer = Column(String, default="")
    isrc = Column(String, default="")
    match_key = Column(String, default="")
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
