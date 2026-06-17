import json
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from ..core.cleaning import (
    FIX_LABELS,
    TAG_LABELS,
    CleanRow,
    clean_dataset,
    mark_duplicates,
    revalidate,
)
from ..database import get_db
from ..deps import get_current_user
from ..models import (
    Branch,
    FileStatus,
    MasterRecord,
    UploadedFile,
    User,
    UserRole,
)
from ..schemas import (
    BulkFix,
    CleanRowOut,
    CleanSummary,
    ColumnProfile,
    CommitResult,
    DataProfile,
    ReviewOut,
    RowEdit,
    TagGroup,
)

# The dataset heatmap ribbon is capped at this many pixels; larger files are
# downsampled (each pixel takes the worst status of the rows it represents) so
# the payload stays small no matter how big the upload is.
_MAX_STRIP = 1800


def _grade(score: int) -> str:
    table = [
        (97, "A+"), (93, "A"), (90, "A-"),
        (87, "B+"), (83, "B"), (80, "B-"),
        (77, "C+"), (73, "C"), (70, "C-"),
        (60, "D"),
    ]
    for cutoff, letter in table:
        if score >= cutoff:
            return letter
    return "F"

router = APIRouter(tags=["clean"])


def _get_file_or_404(file_id: int, user: User, db: Session) -> UploadedFile:
    # Defer the big `data` blob: review endpoints only touch it on a cache miss
    # (via build_rows), so a warm cache serves the page with no large read.
    f = db.scalars(
        select(UploadedFile)
        .where(UploadedFile.id == file_id)
        .options(defer(UploadedFile.data))
    ).first()
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    branch = db.get(Branch, f.branch_id)
    if user.role != UserRole.admin and branch.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your branch")
    return f


def _active_columns(f: UploadedFile) -> list[str]:
    return [m["master_column"] for m in f.mapping if m.get("input_header")]


# --------------------------------------------------------------------------
# In-memory cleaning
#
# Cleaning is a pure function of the file's raw `data` + `mapping`, with the
# reviewer's `corrections`/`dropped` overlaid on top. We never persist the
# cleaned rows — they're recomputed on demand (milliseconds) and memoised
# per-process so repeated review requests don't re-clean from scratch.
# --------------------------------------------------------------------------
# Per-process cache: keyed by file id, holds the cleaned rows AND the derived
# summary/profile so repeated review/paging requests (and the clean -> review
# hand-off) never re-clean or re-aggregate. All three are pure functions of the
# file's signature, so a single signature check keeps them consistent.
_CACHE: dict[int, dict] = {}
_CACHE_LIMIT = 16


def _signature(f: UploadedFile) -> str:
    # `data` is immutable after upload, so only the overlay + mapping vary.
    return json.dumps(
        [f.mapping, f.corrections or {}, f.dropped or []],
        sort_keys=True, default=str,
    )


def _entry(f: UploadedFile) -> dict:
    """The cache entry for a file (rows + memoised summary/profile), built lazily."""
    sig = _signature(f)
    hit = _CACHE.get(f.id)
    if hit and hit["sig"] == sig:
        return hit

    base = clean_dataset(f.data, f.headers, f.mapping)
    corrections = f.corrections or {}
    dropped = set(f.dropped or [])

    rows: list[CleanRow] = []
    for r in base:
        if r.index in dropped:
            continue
        override = corrections.get(str(r.index))
        if override:
            cleaned, issues = revalidate({**r.values, **override})
            r = CleanRow(index=r.index, values=cleaned, issues=issues)
        rows.append(r)

    mark_duplicates(rows)

    if len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    entry = {"sig": sig, "rows": rows, "summary": None, "profile": None}
    _CACHE[f.id] = entry
    return entry


def build_rows(f: UploadedFile) -> list[CleanRow]:
    """The cleaned, corrected, duplicate-checked rows for a file (cached)."""
    return _entry(f)["rows"]


def _get_summary(f: UploadedFile) -> "CleanSummary":
    e = _entry(f)
    if e["summary"] is None:
        e["summary"] = _summary(f, e["rows"])
    return e["summary"]


def _get_profile(f: UploadedFile) -> "DataProfile":
    e = _entry(f)
    if e["profile"] is None:
        e["profile"] = _build_profile(_active_columns(f), e["rows"])
    return e["profile"]


def _invalidate(file_id: int) -> None:
    _CACHE.pop(file_id, None)


def _row_out(r: CleanRow) -> CleanRowOut:
    return CleanRowOut(
        row_index=r.index, status=r.status, values=r.values, issues=r.issues
    )


def _summary(f: UploadedFile, rows: list[CleanRow]) -> CleanSummary:
    tags: Counter = Counter()
    fix_tags: Counter = Counter()
    auto_fixed = 0
    clean = 0
    for r in rows:
        if r.status == "clean":
            clean += 1
        for i in r.issues:
            if i["action"] == "error":
                tags[i["tag"]] += 1
            elif i["action"] == "fixed":
                auto_fixed += 1
                fix_tags[i.get("tag") or "trimmed"] += 1
    return CleanSummary(
        total=len(rows),
        clean=clean,
        errors=len(rows) - clean,
        auto_fixed=auto_fixed,
        tags=[
            TagGroup(tag=t, label=TAG_LABELS.get(t, t), count=c)
            for t, c in tags.most_common()
        ],
        fix_tags=[
            TagGroup(tag=t, label=FIX_LABELS.get(t, t), count=c)
            for t, c in fix_tags.most_common()
        ],
        columns=_active_columns(f),
    )


@router.post("/api/files/{file_id}/clean", response_model=CleanSummary)
def run_clean(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark the file as cleaned and return a fresh summary.

    Cleaning itself is computed in memory — nothing is written to the database
    here beyond flipping the file's status.
    """
    f = _get_file_or_404(file_id, user, db)
    if not _active_columns(f):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Map at least one column before cleaning.",
        )
    # Cleaning is a pure function of the file's signature, so a warm cache is
    # reused (no forced re-clean). The signature changes if the mapping did.
    summary = _get_summary(f)
    if f.status not in (FileStatus.cleaned, FileStatus.committed):
        f.status = FileStatus.cleaned
        db.commit()
    return summary


@router.get("/api/files/{file_id}/clean/summary", response_model=CleanSummary)
def clean_summary(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    f = _get_file_or_404(file_id, user, db)
    return _get_summary(f)


def _build_profile(columns: list[str], rows: list[CleanRow]) -> DataProfile:
    """Profile the cleaned dataset: an overall quality score, a per-row health
    ribbon, and per-column completeness/quality stats. Pure data engineering —
    everything is derived from the in-memory cleaned rows."""
    # Per-column accumulators.
    filled = {c: 0 for c in columns}
    fixed = {c: 0 for c in columns}
    normalized = {c: 0 for c in columns}
    errors = {c: 0 for c in columns}
    distinct: dict[str, set] = {c: set() for c in columns}
    counters: dict[str, Counter] = {c: Counter() for c in columns}

    # Per-row worst status (0 ok, 1 fixed, 2 error) for the heatmap ribbon.
    # Cosmetic-only normalization stays green — only meaningful corrections amber.
    worst: list[int] = []
    clean_rows = 0
    fixed_cells = 0
    normalized_cells = 0
    error_cells = 0

    for r in rows:
        if r.status == "clean":
            clean_rows += 1
        row_worst = 0
        for c in columns:
            v = (r.values.get(c) or "").strip()
            if v:
                filled[c] += 1
                distinct[c].add(v)
                counters[c][v] += 1
        for issue in r.issues:
            col = issue.get("column")
            if col not in filled:
                continue
            if issue["action"] == "error":
                errors[col] += 1
                error_cells += 1
                row_worst = 2
            elif issue["action"] == "fixed":
                if issue.get("cosmetic"):
                    normalized[col] += 1
                    normalized_cells += 1
                else:
                    fixed[col] += 1
                    fixed_cells += 1
                    row_worst = max(row_worst, 1)
        worst.append(row_worst)

    total_rows = len(rows)
    n_cols = max(1, len(columns))
    total_cells = total_rows * n_cols
    filled_cells = sum(filled.values())
    blank_cells = total_cells - filled_cells
    clean_cells = max(0, total_cells - error_cells - fixed_cells)  # normalized counts as clean

    # Quality score blends cell correctness, row cleanliness and completeness.
    if total_cells == 0:
        score = 0
    else:
        cell_quality = 1 - error_cells / total_cells
        row_quality = clean_rows / total_rows if total_rows else 1
        completeness = filled_cells / total_cells
        score = round(100 * (0.5 * cell_quality + 0.3 * row_quality + 0.2 * completeness))
        score = max(0, min(100, score))

    # Downsample the ribbon if the file is large.
    scale = 1
    strip = worst
    if len(worst) > _MAX_STRIP:
        scale = (len(worst) + _MAX_STRIP - 1) // _MAX_STRIP
        strip = [
            max(worst[i : i + scale]) for i in range(0, len(worst), scale)
        ]

    col_profiles = [
        ColumnProfile(
            name=c,
            filled=filled[c],
            blank=total_rows - filled[c],
            distinct=len(distinct[c]),
            fixed=fixed[c],
            normalized=normalized[c],
            errors=errors[c],
            completeness=round(filled[c] / total_rows, 4) if total_rows else 0.0,
            top_values=[[v, n] for v, n in counters[c].most_common(5)],
        )
        for c in columns
    ]

    return DataProfile(
        score=score,
        grade=_grade(score),
        total_rows=total_rows,
        clean_rows=clean_rows,
        total_cells=total_cells,
        clean_cells=clean_cells,
        fixed_cells=fixed_cells,
        normalized_cells=normalized_cells,
        error_cells=error_cells,
        blank_cells=blank_cells,
        row_strip=strip,
        strip_scale=scale,
        columns=col_profiles,
    )


def _filter_rows(
    rows: list[CleanRow], view: str | None, tag: str | None
) -> list[CleanRow]:
    if view in ("clean", "error"):
        rows = [r for r in rows if r.status == view]
    if tag:
        rows = [r for r in rows if any(i.get("tag") == tag for i in r.issues)]
    return rows


@router.get("/api/files/{file_id}/clean/profile", response_model=DataProfile)
def clean_profile(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    f = _get_file_or_404(file_id, user, db)
    return _get_profile(f)


@router.get("/api/files/{file_id}/review", response_model=ReviewOut)
def review(
    file_id: int,
    view: str = "all",
    tag: str | None = None,
    page: int = 0,
    page_size: int = 50,
    include_profile: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Everything the Review screen needs in ONE request: summary, quality
    profile, and the requested page of rows (filtered by view/tag).

    Cleaning is computed once and memoised, so this is a single fast call no
    matter how the user pages or filters — and the big row blob is read at most
    once (on the first cache miss), never on a warm page."""
    f = _get_file_or_404(file_id, user, db)
    rows = build_rows(f)

    filtered = _filter_rows(rows, view, tag)
    total = len(filtered)
    page = max(0, page)
    page_rows = filtered[page * page_size : page * page_size + page_size]

    return ReviewOut(
        summary=_get_summary(f),
        profile=_get_profile(f) if include_profile else None,
        rows=[_row_out(r) for r in page_rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/api/files/{file_id}/clean/rows", response_model=list[CleanRowOut])
def clean_rows(
    file_id: int,
    status_filter: str | None = None,
    tag: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List cleaned rows, optionally filtered by status (clean|error) or error tag.

    All filtering/paging happens in memory over the cached cleaned rows, so it's
    instant regardless of file size.
    """
    f = _get_file_or_404(file_id, user, db)
    rows = _filter_rows(build_rows(f), status_filter, tag)
    return [_row_out(r) for r in rows[offset : offset + limit]]


@router.put("/api/files/{file_id}/rows/{row_index}", response_model=CleanRowOut)
def edit_row(
    file_id: int,
    row_index: int,
    payload: RowEdit,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Human edit: store the changed cells as a correction and re-clean the row."""
    f = _get_file_or_404(file_id, user, db)
    if not (0 <= row_index < len(f.data)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Row not found")

    corrections = dict(f.corrections or {})
    existing = dict(corrections.get(str(row_index), {}))
    existing.update(payload.values)
    corrections[str(row_index)] = existing
    f.corrections = corrections
    db.commit()
    _invalidate(file_id)

    for r in build_rows(f):
        if r.index == row_index:
            return _row_out(r)
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Row not found")


@router.post("/api/files/{file_id}/clean/bulk", response_model=CleanSummary)
def bulk_fix(
    file_id: int,
    payload: BulkFix,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Resolve a whole class of errors at once (by tag).

    action="set"  -> set the flagged cells to `value` on every row carrying `tag`.
    action="drop" -> exclude every row carrying `tag` from the output.
    """
    f = _get_file_or_404(file_id, user, db)
    rows = build_rows(f)
    affected = [r for r in rows if any(i.get("tag") == payload.tag for i in r.issues)]

    if payload.action == "drop":
        dropped = set(f.dropped or [])
        dropped.update(r.index for r in affected)
        f.dropped = sorted(dropped)
    elif payload.action == "set":
        corrections = dict(f.corrections or {})
        for r in affected:
            override = dict(corrections.get(str(r.index), {}))
            if payload.column:
                override[payload.column] = payload.value or ""
            else:
                # Set every cell in this row that carries the tag — this correctly
                # handles tags that span multiple columns (e.g. two date columns).
                for i in r.issues:
                    if i.get("tag") == payload.tag:
                        override[i["column"]] = payload.value or ""
            corrections[str(r.index)] = override
        f.corrections = corrections
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown action.")

    db.commit()
    _invalidate(file_id)
    return _get_summary(f)


@router.post("/api/files/{file_id}/commit", response_model=CommitResult)
def commit_clean(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save all clean rows into the master dataset. Rows with errors are skipped.

    This is the only point at which cleaned data is written to the database.
    """
    f = _get_file_or_404(file_id, user, db)
    rows = build_rows(f)
    clean = [r for r in rows if r.status == "clean"]
    errors = len(rows) - len(clean)

    db.add_all(
        MasterRecord(branch_id=f.branch_id, file_id=f.id, data=r.values) for r in clean
    )
    f.status = FileStatus.committed
    db.commit()
    return CommitResult(committed=len(clean), skipped_errors=errors)
