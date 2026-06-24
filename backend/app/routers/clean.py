import io
import json
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from ..core.cleaning import (
    FIELD_TYPES,
    FIX_LABELS,
    NAME_SEP,
    NAME_TYPES,
    TAG_LABELS,
    CleanRow,
    _dedup_norm,
    clean_dataset,
    mark_duplicates,
    revalidate,
)
from ..core.http import content_disposition
from ..core.master_store import find_conflicts, upsert_master_records
from ..database import get_db
from ..deps import get_current_user
from ..models import (
    MASTER_COLUMN_TO_ATTR,
    ActivityLog,
    Branch,
    FileStatus,
    UploadedFile,
    User,
    UserRole,
)
from ..schemas import (
    BulkFix,
    CleanRowOut,
    CleanSummary,
    ColumnProfile,
    CommitRequest,
    CommitResult,
    ConflictsResult,
    DataProfile,
    RemapPreview,
    ReviewOut,
    RowEdit,
    RowsAccept,
    RowsBatchEdit,
    TagGroup,
    UniqueValue,
    UniqueValuesOut,
    ValueRemap,
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


def _is_name_column(col: str) -> bool:
    """Name fields (Singer, Composer, ...) hold pipe-separated people, so their
    distinct/unique values are counted per individual name, not per whole cell."""
    return FIELD_TYPES.get(col, "text") in NAME_TYPES


def _value_pieces(col: str, value: str) -> list[str]:
    """The distinct units of a cell: each piped name for name fields, else the
    whole trimmed value. Empty cells contribute nothing."""
    v = (value or "").strip()
    if not v:
        return []
    if _is_name_column(col):
        return [p.strip() for p in v.split(NAME_SEP) if p.strip()]
    return [v]


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
        [f.mapping, f.corrections or {}, f.dropped or [], f.accepted or []],
        sort_keys=True, default=str,
    )


def _mark_corrected(
    base_values: dict, cleaned: dict, issues: list[dict], override: dict
) -> list[dict]:
    """Flag every cell a human changed (merge / inline edit / bulk set) so the
    Review grid highlights it as "Manually corrected".

    A cell is corrected when its final value differs from the value cleaning
    produced before the overlay. The marker carries the pre-correction value as
    `original`, so hovering shows what it was. Cells still in error keep their
    error flag (it already highlights and explains the problem); any cosmetic
    auto-fix flag on a corrected cell is superseded by this stronger marker.
    """
    edited = {
        col for col in override
        if (cleaned.get(col) or "") != (base_values.get(col) or "")
    }
    if not edited:
        return issues
    err_cols = {i["column"] for i in issues if i["action"] == "error"}
    kept = [i for i in issues if i["column"] not in edited or i["action"] == "error"]
    for col in edited:
        if col in err_cols:
            continue
        kept.append({
            "column": col,
            "action": "fixed",
            "tag": "corrected",
            "message": "Manually corrected in review.",
            "value": cleaned.get(col, ""),
            "original": base_values.get(col, ""),
            "cosmetic": False,
        })
    return kept


def _entry(f: UploadedFile) -> dict:
    """The cache entry for a file (rows + memoised summary/profile), built lazily."""
    sig = _signature(f)
    hit = _CACHE.get(f.id)
    if hit and hit["sig"] == sig:
        return hit

    base = clean_dataset(f.data, f.headers, f.mapping)
    corrections = f.corrections or {}
    dropped = set(f.dropped or [])
    accepted = set(f.accepted or [])

    rows: list[CleanRow] = []
    for r in base:
        if r.index in dropped:
            continue
        override = corrections.get(str(r.index))
        if override:
            cleaned, issues = revalidate({**r.values, **override})
            issues = _mark_corrected(r.values, cleaned, issues, override)
            r = CleanRow(index=r.index, values=cleaned, issues=issues)
        rows.append(r)

    mark_duplicates(rows)

    # "Keep as-is": clear error flags on accepted rows (values stay unchanged),
    # so the reviewer's deliberate keep moves the row into the clean set.
    if accepted:
        for r in rows:
            if r.index in accepted:
                r.issues = [i for i in r.issues if i["action"] != "error"]

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


def _accept_in_place(f: UploadedFile) -> None:
    """Apply the file's accepted-set to the cached rows WITHOUT re-cleaning.

    Accepting a row only clears its error flags (the values are unchanged) — which
    is exactly what `_entry` does for accepted rows. So instead of invalidating the
    cache and re-cleaning every row (expensive on large files), we mutate the hot
    cache in place: clear errors on the accepted rows, refresh the signature, and
    drop the memoised summary/profile so they recompute cheaply (no cleaning) on
    next access. Falls back to a normal lazy rebuild if the cache is cold."""
    entry = _CACHE.get(f.id)
    if not entry:
        return
    accepted = set(f.accepted or [])
    for r in entry["rows"]:
        if r.index in accepted:
            r.issues = [i for i in r.issues if i["action"] != "error"]
    entry["sig"] = _signature(f)
    entry["summary"] = None
    entry["profile"] = None


def _row_out(r: CleanRow) -> CleanRowOut:
    return CleanRowOut(
        row_index=r.index, status=r.status, values=r.values, issues=r.issues
    )


def _review_payload(
    f: UploadedFile,
    view: str,
    tag: str | None,
    page: int,
    page_size: int,
    include_profile: bool,
    tags: list[str] | None = None,
    sort: str | None = None,
    direction: str = "asc",
    contains_col: str | None = None,
    contains_val: str | None = None,
) -> "ReviewOut":
    """Build the full Review payload (summary + profile + page of rows). Shared by
    GET /review and the edit/accept mutations so they each return in one trip.

    Optional `tags` (match ANY), `contains_col`/`contains_val` (value filter) and
    `sort`/`direction` are applied server-side so they hold across pages."""
    rows = build_rows(f)
    filtered = _filter_rows(rows, view, tag, tags, contains_col, contains_val)
    filtered = _sort_rows(filtered, sort, direction)
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
    # Warm the quality profile too, while the "Run cleaning" progress bar is up,
    # so landing on Review serves rows + summary + profile from a hot cache.
    _get_profile(f)
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
    # Pipe-aware distinct: name fields count each individual name (Singer 1 |
    # Singer 2 -> 2), so the per-column "unique" badge reflects real people.
    distinct_split: dict[str, set] = {c: set() for c in columns}
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
                distinct_split[c].update(_value_pieces(c, v))
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
            unique=len(distinct_split[c]),
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
    rows: list[CleanRow],
    view: str | None,
    tag: str | None,
    tags: list[str] | None = None,
    contains_col: str | None = None,
    contains_val: str | None = None,
) -> list[CleanRow]:
    if view in ("clean", "error"):
        rows = [r for r in rows if r.status == view]
    if tag:
        rows = [r for r in rows if any(i.get("tag") == tag for i in r.issues)]
    if tags:
        wanted = set(tags)
        rows = [r for r in rows if any(i.get("tag") in wanted for i in r.issues)]
    if contains_col and contains_val:
        target = contains_val.strip().lower()
        rows = [
            r for r in rows
            if any(p.lower() == target for p in _value_pieces(contains_col, r.values.get(contains_col, "")))
            or target in (r.values.get(contains_col, "") or "").lower()
        ]
    return rows


def _sort_rows(rows: list[CleanRow], col: str | None, direction: str) -> list[CleanRow]:
    """Stable, case-insensitive sort by one column's value. No-op if no column."""
    if not col:
        return rows
    return sorted(
        rows,
        key=lambda r: (r.values.get(col, "") or "").strip().lower(),
        reverse=(direction == "desc"),
    )


def _split_csv(value: str | None) -> list[str]:
    """Split a comma-joined query param into a clean list (drops blanks)."""
    if not value:
        return []
    return [p.strip() for p in value.split(",") if p.strip()]


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
    tags: str | None = None,
    sort: str | None = None,
    dir: str = "asc",
    contains_col: str | None = None,
    contains_val: str | None = None,
    page: int = 0,
    page_size: int = 50,
    include_profile: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Everything the Review screen needs in ONE request: summary, quality
    profile, and the requested page of rows (filtered by view/tag).

    `tags` is a comma-joined list of cleaning/error tags (match ANY);
    `contains_col`/`contains_val` filter by a column value; `sort`/`dir` order
    the rows. All apply server-side so they hold across pages.

    Cleaning is computed once and memoised, so this is a single fast call no
    matter how the user pages or filters — and the big row blob is read at most
    once (on the first cache miss), never on a warm page."""
    f = _get_file_or_404(file_id, user, db)
    return _review_payload(
        f, view, tag, page, page_size, include_profile,
        tags=_split_csv(tags), sort=sort, direction=dir,
        contains_col=contains_col, contains_val=contains_val,
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


_UNIQUE_CAP = 1000  # bound the side-panel payload for very high-cardinality columns


@router.get("/api/files/{file_id}/columns/{column}/unique", response_model=UniqueValuesOut)
def column_unique_values(
    file_id: int,
    column: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The distinct values of one column (most-common first), pipe-split for name
    fields so each individual singer/composer is counted separately. Powers the
    per-column "Show unique values" side panel. Runs over the cached rows."""
    f = _get_file_or_404(file_id, user, db)
    if column not in _active_columns(f):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    counts: Counter = Counter()
    for r in build_rows(f):
        for piece in _value_pieces(column, r.values.get(column, "")):
            counts[piece] += 1
    return UniqueValuesOut(
        column=column,
        total_distinct=len(counts),
        values=[UniqueValue(value=v, count=n) for v, n in counts.most_common(_UNIQUE_CAP)],
    )


def _remap_cell(col: str, value: str, alias: dict[str, str]) -> str:
    """Rewrite one cell, replacing each matching piece via `alias` (keyed by the
    normalized piece). Name fields are split on NAME_SEP, each piece remapped,
    then re-joined de-duped with order preserved (so "Shreya Ghosal | Arijit" ->
    "Shreya Ghoshal | Arijit", and a cell holding both variants collapses to one).
    Non-name columns match/replace the whole value."""
    pieces = _value_pieces(col, value)
    if not pieces:
        return value
    out: list[str] = []
    for p in pieces:
        repl = alias.get(_dedup_norm(p), p)
        # The canonical value may itself be multi-name ("A | B"); split it too.
        for sub in (_value_pieces(col, repl) or [repl]):
            if sub not in out:
                out.append(sub)
    if _is_name_column(col):
        return NAME_SEP.join(out)
    return out[0] if out else ""


def _remap_alias(payload: ValueRemap) -> dict[str, str]:
    """The {normalized variant -> canonical} map for a remap request, dropping
    blanks and any variant that already equals the canonical value."""
    to = payload.to.strip()
    return {
        _dedup_norm(v): to
        for v in payload.from_values
        if _dedup_norm(v) and _dedup_norm(v) != _dedup_norm(to)
    }


@router.post(
    "/api/files/{file_id}/columns/{column}/remap/preview", response_model=RemapPreview
)
def remap_preview(
    file_id: int,
    column: str,
    payload: ValueRemap,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Dry run: how many rows a value-merge would rewrite — so the reviewer sees
    the blast radius and confirms before anything changes."""
    f = _get_file_or_404(file_id, user, db)
    if column not in _active_columns(f):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    alias = _remap_alias(payload)
    if not alias:
        return RemapPreview(affected_rows=0)
    affected = sum(
        1
        for r in build_rows(f)
        if _remap_cell(column, r.values.get(column, ""), alias) != r.values.get(column, "")
    )
    return RemapPreview(affected_rows=affected)


@router.post("/api/files/{file_id}/columns/{column}/remap", response_model=ReviewOut)
def remap_column_value(
    file_id: int,
    column: str,
    payload: ValueRemap,
    view: str = "all",
    tag: str | None = None,
    tags: str | None = None,
    sort: str | None = None,
    dir: str = "asc",
    contains_col: str | None = None,
    contains_val: str | None = None,
    page: int = 0,
    page_size: int = 50,
    include_profile: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Human-confirmed value merge: replace every `from_values` variant with `to`
    across the column. Piece-aware for pipe-separated name fields. Each rewrite is
    stored as a row correction — auditable, reversible (remap back), and picked up
    by review / export / commit just like an inline edit. Returns the refreshed
    Review payload so the grid updates in one round-trip."""
    f = _get_file_or_404(file_id, user, db)
    if column not in _active_columns(f):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    alias = _remap_alias(payload)
    if not alias:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nothing to remap.")

    corrections = dict(f.corrections or {})
    for r in build_rows(f):
        cur = r.values.get(column, "")
        new = _remap_cell(column, cur, alias)
        if new != cur:
            override = dict(corrections.get(str(r.index), {}))
            override[column] = new
            corrections[str(r.index)] = override
    f.corrections = corrections
    db.commit()
    _invalidate(file_id)
    return _review_payload(
        f, view, tag, page, page_size, include_profile,
        tags=_split_csv(tags), sort=sort, direction=dir,
        contains_col=contains_col, contains_val=contains_val,
    )


_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/api/files/{file_id}/export")
def export_rows(
    file_id: int,
    view: str = "error",
    tag: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Download the rows of a given view as an .xlsx workbook.

    Defaults to the flagged ("error") rows so a reviewer can pull every row that
    needs attention into Excel, each annotated with what's wrong. The sheet is
    built in memory and streamed — nothing is written to disk.
    """
    f = _get_file_or_404(file_id, user, db)
    rows = _filter_rows(build_rows(f), view, tag)
    cols = _active_columns(f)

    wb = Workbook()
    ws = wb.active
    ws.title = "Flagged rows" if view == "error" else "Rows"
    ws.append(["Row", *cols, "Issues"])
    for r in rows:
        issues = "; ".join(
            f"{i['column']}: {i.get('message') or i.get('tag')}"
            for i in r.issues
            if i.get("action") == "error"
        )
        ws.append([r.index + 1, *[r.values.get(c, "") for c in cols], issues])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    label = "flagged_rows" if view == "error" else f"{view}_rows"
    filename = f"{label}_file{file_id}.xlsx"
    return StreamingResponse(
        buf,
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": content_disposition(filename)},
    )


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


@router.put("/api/files/{file_id}/rows", response_model=ReviewOut)
def edit_rows(
    file_id: int,
    payload: RowsBatchEdit,
    view: str = "all",
    tag: str | None = None,
    tags: str | None = None,
    sort: str | None = None,
    dir: str = "asc",
    contains_col: str | None = None,
    contains_val: str | None = None,
    page: int = 0,
    page_size: int = 50,
    include_profile: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Apply many inline edits in one request and return the refreshed Review
    payload — so the grid updates in a single round-trip (no extra reload).

    Each edit is stored as a correction; rows that become fully clean afterwards
    drop out of the review queue automatically.
    """
    f = _get_file_or_404(file_id, user, db)
    corrections = dict(f.corrections or {})
    n = len(f.data)
    for idx_str, values in payload.edits.items():
        try:
            idx = int(idx_str)
        except (TypeError, ValueError):
            continue
        if not (0 <= idx < n):
            continue
        existing = dict(corrections.get(idx_str, {}))
        existing.update(values)
        corrections[idx_str] = existing
    f.corrections = corrections
    db.commit()
    _invalidate(file_id)
    return _review_payload(
        f, view, tag, page, page_size, include_profile,
        tags=_split_csv(tags), sort=sort, direction=dir,
        contains_col=contains_col, contains_val=contains_val,
    )


@router.post("/api/files/{file_id}/accept", response_model=ReviewOut)
def accept_rows(
    file_id: int,
    payload: RowsAccept,
    view: str = "all",
    tag: str | None = None,
    tags: str | None = None,
    sort: str | None = None,
    dir: str = "asc",
    contains_col: str | None = None,
    contains_val: str | None = None,
    page: int = 0,
    page_size: int = 50,
    include_profile: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Keep flagged rows as-is: clear their error flags without changing values.

    `rows` is empty + `tag` given -> accept every row carrying that error type."""
    f = _get_file_or_404(file_id, user, db)
    accepted = set(f.accepted or [])
    if payload.rows:
        accepted.update(i for i in payload.rows if 0 <= i < len(f.data))
    elif tag:
        accepted.update(
            r.index for r in build_rows(f)
            if any(i.get("tag") == tag for i in r.issues)
        )
    f.accepted = sorted(accepted)
    db.commit()
    # Fast path: update the cached rows in place instead of a full re-clean.
    _accept_in_place(f)
    return _review_payload(
        f, view, tag, page, page_size, include_profile,
        tags=_split_csv(tags), sort=sort, direction=dir,
        contains_col=contains_col, contains_val=contains_val,
    )


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


@router.post("/api/files/{file_id}/conflicts", response_model=ConflictsResult)
def check_conflicts(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Near-duplicates between this file's clean rows and the master dataset.

    A conflict is a clean row that all-but-matches an already-stored record
    (e.g. same singer / album / ISRC / UPC but a different composer or
    publisher). The frontend stacks each pair for cross-verification and asks the
    reviewer which is correct before the save proceeds. An empty list means the
    save can run straight through.
    """
    f = _get_file_or_404(file_id, user, db)
    clean = [r for r in build_rows(f) if r.status == "clean"]
    return ConflictsResult(
        conflicts=find_conflicts(db, clean),
        columns=list(MASTER_COLUMN_TO_ATTR),
    )


@router.post("/api/files/{file_id}/commit", response_model=CommitResult)
def commit_clean(
    file_id: int,
    payload: CommitRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save all clean rows into the master dataset. Rows with errors are skipped.

    Cleaned rows land in the structured `master_data` table (one queryable
    column per master field), de-duplicated against everything already stored:
    an identical recording is not saved twice, and a row that matches except for
    its Label / Publisher / Distributor updates the existing record to the latest
    owner. Near-duplicates the reviewer flagged via `/conflicts` are applied per
    their decision (`resolutions`). Each save is recorded in the activity log.
    """
    f = _get_file_or_404(file_id, user, db)
    rows = build_rows(f)
    clean = [r for r in rows if r.status == "clean"]
    errors = len(rows) - len(clean)

    resolutions = {
        int(idx): {"decision": res.decision, "master_id": res.master_id}
        for idx, res in (payload.resolutions if payload else {}).items()
    }
    counts = upsert_master_records(db, f.branch_id, f.id, clean, resolutions)
    db.add(ActivityLog(
        branch_id=f.branch_id,
        file_id=f.id,
        action="commit",
        inserted=counts["inserted"],
        updated=counts["updated"],
        duplicates=counts["duplicates"],
        skipped_errors=errors,
    ))
    f.status = FileStatus.committed
    db.commit()
    return CommitResult(
        committed=counts["inserted"] + counts["updated"],
        skipped_errors=errors,
        inserted=counts["inserted"],
        updated=counts["updated"],
        duplicates=counts["duplicates"],
        skipped_conflicts=counts["skipped_conflicts"],
    )
