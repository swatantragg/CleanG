from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from .models import BranchStatus, FileStatus, UserRole


# ---- Auth ----
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ---- Users ----
class UserCreate(BaseModel):
    email: EmailStr
    full_name: str
    password: str
    role: UserRole = UserRole.user


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    full_name: str
    role: UserRole
    is_active: bool
    created_at: datetime


# ---- Branches ----
class BranchCreate(BaseModel):
    name: str
    description: str | None = None


class BranchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    status: BranchStatus
    owner_id: int
    created_at: datetime
    # Lightweight roll-ups so the dashboard can render rich cards without N+1
    # requests. `progress` is the furthest workflow step any file has reached
    # (0 none · 1 uploaded · 2 mapped · 3 cleaned · 4 committed).
    file_count: int = 0
    progress: int = 0


# ---- Master schema ----
class MasterColumnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    position: int
    name: str


# ---- Mapping / uploaded files ----
class MappingItem(BaseModel):
    master_column: str
    position: int
    input_header: str | None
    # Additional input columns feeding the SAME master column. When present, all
    # sources are merged into one value during cleaning (pipe-separated for names
    # like Singer 1 / Singer 2 / Singer 3 -> Singer).
    extra_headers: list[str] = []
    confidence: float
    method: str  # exact | synonym | fuzzy | unmatched | manual
    needs_review: bool


class FileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    branch_id: int
    original_name: str
    size_bytes: int
    sheet_name: str
    n_columns: int
    n_rows: int
    headers: list[str]
    mapping: list[MappingItem]
    warnings: list[str]
    status: FileStatus
    created_at: datetime


class WorkspaceOut(BaseModel):
    """Everything the branch workspace needs in one request: the branch plus its
    current file (or null). The file's big row blob is never included."""

    branch: BranchOut
    file: FileOut | None = None


class MappingUpdate(BaseModel):
    """User-confirmed mapping.

    `assignments` is the primary input header per master column (or null).
    `extra` holds any additional input columns feeding the same master column,
    so several input columns can be directed into one master column.
    """

    assignments: dict[str, str | None]
    extra: dict[str, list[str]] = {}


class PreviewOut(BaseModel):
    """A live look at the cleaned output, rows shaped to the master format."""

    columns: list[str]
    rows: list[list[str]]
    total_rows: int


# ---- Cleaning / review ----
class TagGroup(BaseModel):
    tag: str
    label: str
    count: int


class CleanSummary(BaseModel):
    total: int
    clean: int
    errors: int
    auto_fixed: int  # number of cells auto-corrected
    tags: list[TagGroup]  # error types (needs review), grouped
    fix_tags: list[TagGroup] = []  # kinds of cleaning applied, grouped
    columns: list[str]  # active master columns, in order


class ColumnProfile(BaseModel):
    name: str
    filled: int
    blank: int
    distinct: int
    fixed: int  # cells meaningfully auto-corrected in this column
    normalized: int  # cells only tidied (whitespace/case/unicode)
    errors: int  # cells still flagged in this column
    completeness: float  # 0..1
    top_values: list[list]  # [[value, count], ...] for the most common values


class DataProfile(BaseModel):
    score: int  # 0..100 overall data-quality score
    grade: str  # A+ .. F
    total_rows: int
    clean_rows: int
    total_cells: int
    clean_cells: int
    fixed_cells: int  # meaningful corrections
    normalized_cells: int  # cosmetic-only tidy-ups
    error_cells: int
    blank_cells: int
    row_strip: list[int]  # per-row (possibly downsampled) worst status: 0 ok, 1 fixed, 2 error
    strip_scale: int  # how many real rows each strip entry represents (1 = no downsampling)
    columns: list[ColumnProfile]


class CleanRowOut(BaseModel):
    # Rows are computed in memory, identified by their position in the file.
    row_index: int
    status: str
    values: dict
    issues: list


class ReviewOut(BaseModel):
    """Single-request payload for the Review screen: summary + quality profile
    + the requested page of rows."""

    summary: CleanSummary
    profile: DataProfile | None = None
    rows: list[CleanRowOut]
    total: int
    page: int
    page_size: int


class RowEdit(BaseModel):
    values: dict[str, str]


class BulkFix(BaseModel):
    tag: str
    column: str | None = None
    action: str  # "set" | "drop"
    value: str | None = None


class CommitResult(BaseModel):
    committed: int
    skipped_errors: int
