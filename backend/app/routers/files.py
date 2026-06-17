import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from ..core.excel import MAX_BYTES, ExcelValidationError, read_and_validate
from ..core.matching import suggest_mapping
from ..database import get_db
from ..deps import get_current_user
from ..models import Branch, FileStatus, MasterColumn, UploadedFile, User, UserRole
from ..schemas import BranchOut, FileOut, MappingUpdate, PreviewOut, WorkspaceOut

router = APIRouter(tags=["files"])


def _get_branch_or_404(branch_id: int, user: User, db: Session) -> Branch:
    branch = db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Branch not found")
    if user.role != UserRole.admin and branch.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your branch")
    return branch


def _get_file_or_404(file_id: int, user: User, db: Session) -> UploadedFile:
    f = db.get(UploadedFile, file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    _get_branch_or_404(f.branch_id, user, db)
    return f


def _master_column_names(db: Session) -> list[str]:
    return list(
        db.scalars(select(MasterColumn.name).order_by(MasterColumn.position)).all()
    )


@router.get("/api/branches/{branch_id}/files", response_model=list[FileOut])
def list_files(
    branch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _get_branch_or_404(branch_id, user, db)
    # `FileOut` never returns the extracted rows, so don't pay to load that
    # (potentially huge) JSON blob just to list a branch's files.
    return db.scalars(
        select(UploadedFile)
        .where(UploadedFile.branch_id == branch_id)
        .order_by(UploadedFile.created_at.desc())
        .options(defer(UploadedFile.data))
    ).all()


@router.get("/api/branches/{branch_id}/workspace", response_model=WorkspaceOut)
def workspace(
    branch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Branch + its current file in a single round-trip.

    The workspace page used to make two separate requests (and pull the whole
    branch list just to find one). This serves both from one DB session, with
    the file's heavy row blob deferred, so opening a branch is one fast call.
    """
    branch = _get_branch_or_404(branch_id, user, db)
    f = db.scalars(
        select(UploadedFile)
        .where(UploadedFile.branch_id == branch_id)
        .order_by(UploadedFile.created_at.desc())
        .options(defer(UploadedFile.data))
        .limit(1)
    ).first()
    return WorkspaceOut(
        branch=BranchOut.model_validate(branch),
        file=FileOut.model_validate(f) if f is not None else None,
    )


@router.post(
    "/api/branches/{branch_id}/files",
    response_model=FileOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_file(
    branch_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload + validate an input file, then auto-suggest the master mapping."""
    _get_branch_or_404(branch_id, user, db)

    name = file.filename or "upload.xlsx"
    if not name.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Only .xlsx files are supported.",
        )

    # Read with a hard size cap (20 MB) so we never buffer a huge file.
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "File exceeds the 20 MB limit.",
        )
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file is empty.")

    # Validate + extract rows entirely in memory — the file itself is NOT stored.
    try:
        info = read_and_validate(io.BytesIO(data))
    except ExcelValidationError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code, "message": exc.message},
        )

    # Auto-map against the master schema, profiling column contents so the
    # matcher can confirm/drive matches from the data, not just the headers.
    suggestion = suggest_mapping(info.headers, _master_column_names(db), info.rows)

    uploaded = UploadedFile(
        branch_id=branch_id,
        original_name=name,
        size_bytes=len(data),
        sheet_name=info.sheet_name,
        header_row=info.header_row,
        n_columns=info.n_columns,
        n_rows=info.n_rows,
        headers=info.headers,
        data=info.rows,
        mapping=suggestion["mappings"],
        warnings=info.warnings,
        status=FileStatus.uploaded,
    )
    db.add(uploaded)
    db.commit()
    db.refresh(uploaded)
    return uploaded


@router.get("/api/files/{file_id}", response_model=FileOut)
def get_file(
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _get_file_or_404(file_id, user, db)


@router.get("/api/files/{file_id}/preview", response_model=PreviewOut)
def preview_output(
    file_id: int,
    rows: int = 8,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Show the first rows transformed into the master format using the mapping."""
    f = _get_file_or_404(file_id, user, db)
    rows = max(1, min(rows, 50))

    header_index = {h: i for i, h in enumerate(f.headers)}
    master_cols = [m["master_column"] for m in f.mapping]
    # Each master column may pull from one or several input columns (primary +
    # extras). Pre-resolve the source indexes once per column.
    source_indexes = [
        [
            header_index[h]
            for h in ([m.get("input_header")] + (m.get("extra_headers") or []))
            if h and h in header_index
        ]
        for m in f.mapping
    ]

    def _cell(r, idxs):
        vals = [str(r[i]) for i in idxs if i < len(r) and str(r[i]).strip()]
        return " | ".join(dict.fromkeys(vals)) if vals else ""

    out_rows = [[_cell(r, idxs) for idxs in source_indexes] for r in f.data[:rows]]
    return PreviewOut(columns=master_cols, rows=out_rows, total_rows=f.n_rows)


@router.put("/api/files/{file_id}/mapping", response_model=FileOut)
def update_mapping(
    file_id: int,
    payload: MappingUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save the user-confirmed mapping (master column -> input header)."""
    f = _get_file_or_404(file_id, user, db)
    valid_headers = set(f.headers)

    def _check(header: str | None) -> None:
        if header is not None and header not in valid_headers:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"'{header}' is not a header in this file.",
            )

    new_mapping = []
    for item in f.mapping:
        master = item["master_column"]
        touched = master in payload.assignments or master in payload.extra
        if touched:
            chosen = payload.assignments.get(master, item.get("input_header"))
            _check(chosen)
            # Extra sources: validate, drop blanks/the primary, de-duplicate.
            extras: list[str] = []
            for h in payload.extra.get(master, []):
                _check(h)
                if h and h != chosen and h not in extras:
                    extras.append(h)
            # If no primary was chosen but extras exist, promote the first extra.
            if not chosen and extras:
                chosen = extras.pop(0)
            item = {
                **item,
                "input_header": chosen,
                "extra_headers": extras,
                "method": "manual" if chosen else "unmatched",
                "confidence": 1.0 if chosen else 0.0,
                "needs_review": False,
            }
        new_mapping.append(item)

    f.mapping = new_mapping
    f.status = FileStatus.mapped
    db.commit()
    db.refresh(f)
    return f
