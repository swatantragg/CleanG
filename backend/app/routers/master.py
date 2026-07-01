import io

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import distinct, func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.audit import log_event
from ..core.http import content_disposition
from ..core.limiter import limiter
from ..core.master_store import record_to_dict
from ..core.presets import (
    ALL_COLUMNS,
    FILTER_FIELD_COLUMNS,
    FILTER_FIELDS,
    NAME_SEP,
    preset_payload,
)
from ..database import get_db
from ..deps import get_current_user
from ..models import (
    MASTER_COLUMN_TO_ATTR,
    ActivityLog,
    Branch,
    MasterColumn,
    MasterData,
    User,
    UserRole,
)
from ..schemas import (
    ActivityLogOut,
    ExportOptions,
    ExportPreset,
    ExportRequest,
    FilterField,
    MasterColumnOut,
    MasterDataPage,
    PreviewRequest,
    SuggestionOut,
    VerifyRequest,
    VerifyResult,
    VerifyValue,
)


def _field_columns(key: str) -> list:
    """The MasterData column objects a filter field searches.

    `key` is a filter-field label (e.g. "Artist Name" -> Lead Artist + Singer),
    or a raw master column name as a fallback."""
    names = FILTER_FIELD_COLUMNS.get(key)
    if names is None:
        if key in MASTER_COLUMN_TO_ATTR:
            names = [key]
        else:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown filter field: {key!r}"
            )
    return [getattr(MasterData, MASTER_COLUMN_TO_ATTR[n]) for n in names]


def _value_match(key: str, value: str):
    """A condition: ANY of the field's columns CONTAINS `value` (case-insensitive).

    Contains-matching is what makes a single name find a multi-name cell such as
    "Sonu Nigam | Shaan", and ignores case/spacing differences."""
    return or_(*(c.ilike(f"%{value}%") for c in _field_columns(key)))


def _scope(stmt, user: User):
    """Restrict a MasterData query to the records a user may see.

    Admins see every committed record; a regular user only sees records whose
    owning branch belongs to them. Without this, any authenticated user could
    read/export the entire master dataset across all tenants.
    """
    if user.role != UserRole.admin:
        owned = select(Branch.id).where(Branch.owner_id == user.id)
        stmt = stmt.where(MasterData.branch_id.in_(owned))
    return stmt


def _scoped_count(db: Session, user: User, *conditions) -> int:
    stmt = select(func.count()).select_from(MasterData)
    for cond in conditions:
        stmt = stmt.where(cond)
    return db.scalar(_scope(stmt, user)) or 0


def _filtered_query(filters: dict[str, list[str]], user: User):
    """A MasterData SELECT narrowed by `filters` (OR within a field, AND across),
    scoped to the records `user` is allowed to see."""
    stmt = _scope(select(MasterData), user)
    for field, values in filters.items():
        vals = [v for v in values if v.strip()]
        if not vals:
            continue
        stmt = stmt.where(or_(*(_value_match(field, v) for v in vals)))
    return stmt

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _custom_column_names(db: Session) -> list[str]:
    """User-added custom column names, in schema order. Their values are NOT
    stored in a dedicated MasterData attribute but inside the `extras` JSON bag,
    so they're resolved from there on read/export."""
    return list(db.scalars(
        select(MasterColumn.name)
        .where(MasterColumn.custom.is_(True))
        .order_by(MasterColumn.position)
    ).all())

settings = get_settings()
router = APIRouter(prefix="/api/master", tags=["master"])


@router.get("/columns", response_model=list[MasterColumnOut])
def master_columns(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """The canonical output schema every cleaned file is mapped onto."""
    return db.scalars(select(MasterColumn).order_by(MasterColumn.position)).all()


@router.get("/data", response_model=MasterDataPage)
def master_data(
    fields: str | None = Query(
        None, description="Comma-separated master column names to extract (default: all)."
    ),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Extract stored master records, optionally projected to just the fields
    asked for — the structured table makes any field a cheap column read."""
    # Built-in schema plus any user-added custom columns (their values live in
    # each record's `extras` bag and are resolved by `record_to_dict`).
    custom_cols = list(db.scalars(
        select(MasterColumn.name)
        .where(MasterColumn.custom.is_(True))
        .order_by(MasterColumn.position)
    ).all())
    known = list(MASTER_COLUMN_TO_ATTR) + [
        c for c in custom_cols if c not in MASTER_COLUMN_TO_ATTR
    ]
    columns = None
    if fields:
        wanted = [c.strip() for c in fields.split(",") if c.strip()]
        columns = [c for c in wanted if c in known]
    projection = columns or known
    total = _scoped_count(db, user)
    recs = db.scalars(
        _scope(select(MasterData), user)
        .order_by(MasterData.id)
        .offset(offset)
        .limit(limit)
    ).all()
    return MasterDataPage(
        columns=projection,
        rows=[record_to_dict(r, projection) for r in recs],
        total=total,
    )


@router.get("/export/options", response_model=ExportOptions)
def export_options(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Everything the Export tab needs: presets (with their appendable custom
    columns), the full column list for a fully-custom export, and the fields the
    user can pre-filter on.

    User-added custom columns (stored in each record's `extras` bag) are folded in
    too: they extend the fully-custom column list AND become appendable extras on
    every preset (PDL / SVF), so any extra column captured at upload can be
    exported alongside the built-in schema."""
    total = _scoped_count(db, user)
    custom_cols = _custom_column_names(db)
    all_columns = list(ALL_COLUMNS) + [c for c in custom_cols if c not in ALL_COLUMNS]
    presets = []
    for p in preset_payload():
        appendable = list(p["custom_columns"]) + [
            c for c in custom_cols
            if c not in p["columns"] and c not in p["custom_columns"]
        ]
        presets.append(ExportPreset(
            key=p["key"], label=p["label"], columns=p["columns"],
            custom_columns=appendable,
        ))
    return ExportOptions(
        presets=presets,
        all_columns=all_columns,
        filter_fields=[
            FilterField(key=label, label=label, columns=cols)
            for label, cols in FILTER_FIELDS
        ],
        total_records=total,
    )


@router.get("/suggest", response_model=list[SuggestionOut])
def suggest_values(
    field: str = Query(..., description="Filter field (label) to suggest values for."),
    q: str = Query("", description="Substring the user has typed so far."),
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Autocomplete: individual values that exist in the master data for `field`,
    each with its record count.

    Multi-name cells ("Sonu Nigam | Shaan") are split so each performer is
    suggested on its own, and matches are searched across every column the field
    covers (e.g. Artist Name -> Lead Artist + Singer). The count (which includes
    rows where the name shares a cell with others) makes spelling variants like
    "Shreya Ghosal" vs "Shreya Ghoshal" visible, so none of an artist's songs get
    missed — add every relevant variant and the filter ORs them together."""
    ql = q.strip().lower()
    found: dict[str, str] = {}  # lower -> display, dedup while preserving casing
    for col in _field_columns(field):
        stmt = _scope(select(distinct(col)), user).where(col != "")
        if ql:
            stmt = stmt.where(func.lower(col).like(f"%{ql}%"))
        for cell in db.scalars(stmt.limit(400)):
            for part in str(cell).split(NAME_SEP):
                part = part.strip()
                if not part:
                    continue
                if ql and ql not in part.lower():
                    continue
                found.setdefault(part.lower(), part)
        if len(found) >= limit * 4:
            break

    names = sorted(found.values(), key=str.lower)[:limit]
    out = [
        SuggestionOut(
            value=n,
            count=_scoped_count(db, user, _value_match(field, n)),
        )
        for n in names
    ]
    # Most common spelling first — it's the one the user most likely wants.
    out.sort(key=lambda s: (-s.count, s.value.lower()))
    return out


@router.post("/preview", response_model=MasterDataPage)
def preview_master(
    payload: PreviewRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """A read-only, paginated view of the (optionally filtered) master data.

    Same filtering semantics as export, but returns rows as JSON for on-screen
    display instead of streaming an xlsx. Purely a read — nothing is modified."""
    if payload.columns:
        cols = [c for c in payload.columns if c in MASTER_COLUMN_TO_ATTR]
    else:
        cols = list(MASTER_COLUMN_TO_ATTR)
    if not cols:
        cols = list(MASTER_COLUMN_TO_ATTR)

    base = _filtered_query(payload.filters, user)
    total = db.scalar(
        select(func.count()).select_from(base.subquery())
    ) or 0
    recs = db.scalars(
        base.order_by(MasterData.id).offset(payload.offset).limit(payload.limit)
    ).all()
    return MasterDataPage(
        columns=cols,
        rows=[record_to_dict(r, cols) for r in recs],
        total=total,
    )


@router.post("/verify", response_model=VerifyResult)
def verify_filters(
    payload: VerifyRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Check whether the entered filter values exist in the master data before
    letting the user proceed to pick a preset / export.

    Each entered value is checked individually (does it occur at all?), and the
    combined filter is counted (do any rows match everything together?)."""
    values: list[VerifyValue] = []
    all_values_present = True

    for field, vals in payload.filters.items():
        for v in vals:
            if not v.strip():
                continue
            count = _scoped_count(db, user, _value_match(field, v))
            values.append(
                VerifyValue(column=field, value=v, available=count > 0, count=count)
            )
            if count == 0:
                all_values_present = False

    if not values:
        return VerifyResult(
            available=False, total=0, values=[],
            message="Enter at least one value to verify.",
        )

    total = db.scalar(
        select(func.count()).select_from(
            _filtered_query(payload.filters, user).subquery()
        )
    ) or 0

    if not all_values_present:
        missing = [
            f"“{x.value}” ({x.column})"
            for x in values if not x.available
        ]
        message = f"Not found in the master data: {', '.join(missing)}."
        available = False
    elif total == 0:
        message = "Each value exists, but no record matches all the filters together."
        available = False
    else:
        message = f"{total} record{'s' if total != 1 else ''} match your filters."
        available = True

    return VerifyResult(available=available, total=total, values=values, message=message)


@router.post("/export")
@limiter.limit(settings.heavy_rate_limit)
def export_master(
    request: Request,
    payload: ExportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stream the selected columns of the (optionally filtered) master data as xlsx."""
    if not payload.columns:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Select at least one column to export."
        )
    # Validate + resolve every requested column up front. Built-in columns read
    # from a real MasterData attribute; user-added custom columns read from the
    # record's `extras` JSON bag. Anything else is rejected.
    custom = set(_custom_column_names(db))
    cols: list[tuple[str, str, bool]] = []  # (column, key, from_extras)
    for c in payload.columns:
        attr = MASTER_COLUMN_TO_ATTR.get(c)
        if attr is not None:
            cols.append((c, attr, False))
        elif c in custom:
            cols.append((c, c, True))
        else:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown column: {c!r}"
            )
    stmt = _filtered_query(payload.filters, user).order_by(MasterData.id)

    wb = Workbook()
    ws = wb.active
    ws.title = (payload.sheet_name or "Master data")[:31]
    ws.append([c for c, _, _ in cols])
    n = 0
    for rec in db.scalars(stmt):
        extras = rec.extras or {}
        ws.append([
            (extras.get(key, "") if from_extras else getattr(rec, key)) or ""
            for _, key, from_extras in cols
        ])
        n += 1

    log_event(db, request, "master_export", user=user,
              detail=f"{n} record(s), {len(cols)} column(s)")
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"{(payload.sheet_name or 'master_export').replace(' ', '_')}.xlsx"
    return StreamingResponse(
        buf,
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": content_disposition(filename, "master_export.xlsx")},
    )


@router.get("/activity", response_model=list[ActivityLogOut])
def activity_log(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Per-branch audit of every save into the master dataset. Admins see all;
    regular users see only activity from their own branches."""
    stmt = select(ActivityLog).order_by(ActivityLog.created_at.desc()).limit(limit)
    if user.role != UserRole.admin:
        owned = select(Branch.id).where(Branch.owner_id == user.id)
        stmt = stmt.where(ActivityLog.branch_id.in_(owned))
    return db.scalars(stmt).all()
