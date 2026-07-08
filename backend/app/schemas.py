import re
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import BranchStatus, FileStatus, UserRole

# Bounded free-text aliases — cap stored string lengths to prevent storage abuse.
ShortText = Annotated[str, Field(min_length=1, max_length=255)]
LongText = Annotated[str, Field(max_length=2000)]

_PASSWORD_MIN = 8


def validate_password_strength(value: str) -> str:
    """Reject weak passwords: >=8 chars with upper, lower and digit."""
    if len(value) < _PASSWORD_MIN:
        raise ValueError(f"Password must be at least {_PASSWORD_MIN} characters long.")
    if len(value) > 128:
        raise ValueError("Password must be at most 128 characters long.")
    if not re.search(r"[a-z]", value):
        raise ValueError("Password must contain a lowercase letter.")
    if not re.search(r"[A-Z]", value):
        raise ValueError("Password must contain an uppercase letter.")
    if not re.search(r"\d", value):
        raise ValueError("Password must contain a digit.")
    return value


# ---- Auth ----
class LoginRequest(BaseModel):
    email: EmailStr
    # Bounded but NOT strength-checked: existing accounts must still log in.
    password: Annotated[str, Field(min_length=1, max_length=128)]


class ChangePassword(BaseModel):
    current_password: Annotated[str, Field(min_length=1, max_length=128)]
    new_password: str

    _check_password = field_validator("new_password")(validate_password_strength)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    action: str
    user_id: int | None
    email: str | None
    ip: str | None
    user_agent: str | None
    detail: str | None
    created_at: datetime


# ---- Users ----
class UserCreate(BaseModel):
    email: EmailStr
    full_name: ShortText
    password: str
    role: UserRole = UserRole.user

    _check_password = field_validator("password")(validate_password_strength)


class UserUpdate(BaseModel):
    """Admin edit: role and/or active state."""

    role: UserRole | None = None
    is_active: bool | None = None


class PasswordReset(BaseModel):
    password: str

    _check_password = field_validator("password")(validate_password_strength)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    full_name: str
    role: UserRole
    is_active: bool
    must_change_password: bool = False
    created_at: datetime


# ---- Branches ----
class BranchCreate(BaseModel):
    name: ShortText
    description: LongText | None = None


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
    custom: bool = False
    # Physical master_data column name for custom columns; None for built-ins.
    attr: str | None = None


class MasterDataPage(BaseModel):
    """A page of stored master records, projected to the requested columns."""

    columns: list[str]
    rows: list[dict]
    total: int


class ActivityLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    branch_id: int
    file_id: int
    action: str
    inserted: int
    updated: int
    duplicates: int
    skipped_errors: int
    created_at: datetime


# ---- Export ----
class ExportPreset(BaseModel):
    key: str  # PDL | SVF
    label: str
    columns: list[str]  # the preset's base columns, in order
    custom_columns: list[str]  # master columns NOT in the preset (appendable)


class FilterField(BaseModel):
    key: str  # identifier sent back in `filters` (equals the label)
    label: str  # what the user sees (e.g. "Artist Name")
    columns: list[str]  # master columns it searches (OR, contains-match)


class SuggestionOut(BaseModel):
    value: str  # a single value as it appears in the data
    count: int  # how many records carry it (incl. inside multi-value cells)


class ExportOptions(BaseModel):
    presets: list[ExportPreset]
    all_columns: list[str]  # every master column, in order (for fully-custom export)
    filter_fields: list[FilterField]
    total_records: int


# Bounds for the filter map shared by export/verify: master schema is ~30 fields,
# and a handful of values per field is normal — cap generously but finitely so a
# crafted body can't blow up memory or fan out into thousands of SQL conditions.
FilterMap = Annotated[
    dict[str, Annotated[list[ShortText], Field(max_length=100)]],
    Field(max_length=50),
]


class ExportRequest(BaseModel):
    # Final ordered list of master columns to export (preset + extras, or custom).
    columns: Annotated[list[ShortText], Field(min_length=1, max_length=100)]
    # Pre-filter: master column -> accepted values (OR within a field, AND across).
    filters: FilterMap = {}
    sheet_name: Annotated[str, Field(max_length=100)] | None = None


# The most rows one preview request may return. The master dataset is unbounded,
# so "All" in the UI means "as many as this" — enough to scroll a whole branch's
# worth of records, small enough that neither the query nor the browser stalls.
PREVIEW_MAX_ROWS = 2000


class PreviewRequest(BaseModel):
    """A read-only, paginated look at the (optionally filtered) master data."""

    filters: FilterMap = {}
    # Columns to show; empty = every master column, in canonical order.
    columns: Annotated[list[ShortText], Field(max_length=100)] = []
    limit: Annotated[int, Field(ge=1, le=PREVIEW_MAX_ROWS)] = 50
    offset: Annotated[int, Field(ge=0)] = 0


class VerifyRequest(BaseModel):
    filters: FilterMap = {}


class VerifyValue(BaseModel):
    column: str
    value: str
    available: bool
    count: int


class VerifyResult(BaseModel):
    available: bool  # every entered value exists AND the combined filter matches rows
    total: int  # rows matching ALL the entered filters together
    values: list[VerifyValue]
    message: str


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
    constants: dict[str, str] = {}
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

    assignments: Annotated[dict[str, str | None], Field(max_length=500)]
    extra: Annotated[
        dict[str, Annotated[list[ShortText], Field(max_length=100)]],
        Field(max_length=500),
    ] = {}


class AddMasterColumn(BaseModel):
    """Promote an unmapped input column into the master schema.

    `input_header` is an existing header in the file; `name` is the master column
    name to create (defaults to the header). The column is registered in the
    master schema (as a custom column unless its name already exists) and wired
    into this file's mapping so its values flow through to the master data.
    """

    input_header: ShortText
    name: ShortText | None = None


class PreviewOut(BaseModel):
    """A live look at the cleaned output, rows shaped to the master format."""

    columns: list[str]
    rows: list[list[str]]
    total_rows: int


# ---- Standardize ----
class StandardizeMapping(BaseModel):
    """How one master column was filled during standardization."""

    master_column: str
    sources: list[str]  # input columns feeding it (merged with " | " when >1)
    matched: bool  # False -> nothing mapped here, the column comes out blank


class StandardizePreview(BaseModel):
    """Preview of a standardized file: the resolved column mapping plus a sample
    of the master-formatted rows. The full file is fetched via the download
    endpoint."""

    columns: list[str]  # the full master schema, in order
    mapping: list[StandardizeMapping]
    rows: list[dict]  # sample rows, keyed by master column
    total_rows: int
    matched_columns: int  # master columns that got a source
    filename: str


# ---- Cleaning / review ----
class TagGroup(BaseModel):
    tag: str
    label: str
    count: int


class CleanSummary(BaseModel):
    total: int
    clean: int
    auto_clean: int = 0  # clean rows the tool fixed on its own
    manual_clean: int = 0  # clean rows a reviewer edited or kept as-is
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
    unique: int  # distinct count, pipe-aware for name fields (Singer 1 | Singer 2 -> 2)
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


class UniqueValue(BaseModel):
    value: str
    count: int  # how many rows carry it (incl. inside pipe-separated name cells)


class UniqueValuesOut(BaseModel):
    """The distinct values of one column, pipe-split for name fields. Powers the
    per-column "Show unique values" side panel in Review."""

    column: str
    total_distinct: int  # full distinct count (before any cap)
    values: list[UniqueValue]  # most-common first, capped


class CleanRowOut(BaseModel):
    # Rows are computed in memory, identified by their position in the file.
    row_index: int
    status: str
    values: dict
    issues: list
    # How a human moved this row into the clean set: "edited" (values changed),
    # "kept" (accepted as-is), or None when the tool cleaned it on its own.
    manual_kind: str | None = None


class ReviewOut(BaseModel):
    """Single-request payload for the Review screen: summary + quality profile
    + the requested page of rows."""

    summary: CleanSummary
    profile: DataProfile | None = None
    rows: list[CleanRowOut]
    total: int
    page: int
    page_size: int


# One row's edited cells: at most one value per master column (~30), each bounded.
RowValues = Annotated[
    dict[str, Annotated[str, Field(max_length=2000)]], Field(max_length=200)
]


class RowEdit(BaseModel):
    values: RowValues


class RowsBatchEdit(BaseModel):
    """Apply several reviewers' edits at once: {row_index: {column: value}}.

    Capped so a single request can't carry an unbounded payload (one entry per
    row, bounded cells per row)."""

    edits: Annotated[dict[str, RowValues], Field(max_length=100_000)]


class RowsAccept(BaseModel):
    """Keep rows as-is (clear their flags). Empty `rows` + a `tag` query param
    means: accept every row carrying that error type."""

    rows: Annotated[list[int], Field(max_length=1_000_000)] = []


class RowsRevert(BaseModel):
    """Undo the manual clean on rows: drop their "keep as-is" acceptance and any
    reviewer corrections, so they fall back to Needs review. Empty `rows` +
    `select_all=true` means: revert every row in the current filtered view."""

    rows: Annotated[list[int], Field(max_length=1_000_000)] = []


class BulkFix(BaseModel):
    tag: str
    column: str | None = None
    action: str  # "set" | "drop"
    value: str | None = None


class ColumnFill(BaseModel):
    """Set (or clear, when blank) a whole-column constant. The value is broadcast
    into every EMPTY cell of the column; an empty value removes the constant."""

    value: Annotated[str, Field(max_length=2000)] = ""


class ValueRemap(BaseModel):
    """Human-confirmed merge of column value variants into one canonical value.

    `from_values` are the variants to replace (matched per-piece for pipe-separated
    name fields, normalized so casing/whitespace don't matter); `to` is the
    canonical value to keep. Many variants -> one `to` is supported.
    """

    from_values: Annotated[list[ShortText], Field(min_length=1, max_length=1000)]
    to: ShortText


class RemapPreview(BaseModel):
    """Dry-run result: how many rows a remap would rewrite (before applying)."""

    affected_rows: int


class ConflictPair(BaseModel):
    """One cleaned row that nearly matches an existing master record, paired with
    that record so the reviewer can cross-verify and decide which is correct."""

    row_index: int
    master_id: int
    differences: list[str]  # master columns whose values differ
    cleaned: dict  # {master column: value} for the row in this upload
    master: dict   # {master column: value} for the stored record


class ConflictsResult(BaseModel):
    conflicts: list[ConflictPair]
    columns: list[str]  # master columns, in display order


class ConflictResolution(BaseModel):
    decision: str  # "cleaned" | "master" | "both"
    master_id: int | None = None


class CommitRequest(BaseModel):
    """Optional body for the commit: the reviewer's call on each near-duplicate,
    keyed by row index. Absent rows take the normal dedup path."""

    resolutions: Annotated[dict[str, ConflictResolution], Field(max_length=100_000)] = {}


class CommitResult(BaseModel):
    committed: int  # inserted + updated (records actually written this save)
    skipped_errors: int
    inserted: int = 0  # brand-new records added to the master dataset
    updated: int = 0  # existing records refreshed to a new owner (label/publisher)
    duplicates: int = 0  # already present, identical — not stored again
    skipped_conflicts: int = 0  # near-duplicates the reviewer kept as the master
