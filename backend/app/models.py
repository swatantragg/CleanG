import enum
from datetime import datetime

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class FileStatus(str, enum.Enum):
    uploaded = "uploaded"   # validated + rows extracted, mapping suggested
    mapped = "mapped"       # mapping confirmed by the user
    cleaned = "cleaned"     # cleaning engine has run
    committed = "committed"  # clean rows saved to the master records


class BranchStatus(str, enum.Enum):
    active = "active"
    archived = "archived"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    hashed_password: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role"), default=UserRole.user
    )
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    branches: Mapped[list["Branch"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Branch(Base):
    """A workspace created per cleaning request. Each new request = a new branch."""

    __tablename__ = "branches"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[BranchStatus] = mapped_column(
        Enum(BranchStatus, name="branch_status"), default=BranchStatus.active
    )
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    owner: Mapped["User"] = relationship(back_populates="branches")
    files: Mapped[list["UploadedFile"]] = relationship(
        back_populates="branch", cascade="all, delete-orphan"
    )


class MasterColumn(Base):
    """The canonical output schema, seeded from the master format workbook.

    The final cleaned sheet conforms to these columns, in this order.
    """

    __tablename__ = "master_columns"

    id: Mapped[int] = mapped_column(primary_key=True)
    position: Mapped[int] = mapped_column(Integer, unique=True)
    name: Mapped[str] = mapped_column(String(255))


class UploadedFile(Base):
    """An input file uploaded into a branch, plus its validation + mapping state."""

    __tablename__ = "uploaded_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    original_name: Mapped[str] = mapped_column(String(512))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sheet_name: Mapped[str] = mapped_column(String(255))
    header_row: Mapped[int] = mapped_column(Integer, default=1)
    n_columns: Mapped[int] = mapped_column(Integer)
    n_rows: Mapped[int] = mapped_column(Integer)
    headers: Mapped[list] = mapped_column(JSON)
    # The extracted rows themselves — we do NOT keep the original file on disk.
    data: Mapped[list] = mapped_column(JSON, default=list)
    # Master-centric mapping:
    #   [{master_column, position, input_header, extra_headers, confidence, method, needs_review}]
    # `extra_headers` lets several input columns feed one master column (merged at clean time).
    mapping: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    # Human review overlay. Cleaning is computed in memory from `data` + `mapping`;
    # only the cells a reviewer changed are persisted here, keyed by row index:
    #   {"<row_index>": {"<master_column>": "value", ...}}
    corrections: Mapped[dict] = mapped_column(JSON, default=dict)
    # Row indexes the reviewer dropped (excluded from output and the master save).
    dropped: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[FileStatus] = mapped_column(
        Enum(FileStatus, name="file_status"), default=FileStatus.uploaded
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    branch: Mapped["Branch"] = relationship(back_populates="files")


class MasterRecord(Base):
    """A committed, fully-clean record stored in the master dataset."""

    __tablename__ = "master_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id"))
    file_id: Mapped[int] = mapped_column(ForeignKey("uploaded_files.id"))
    data: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
