"""PRS standardization tab: upload a raw PRS "List of works" report (one row per
interested party) and get it back consolidated to one row per work, with every
party expanded horizontally into role-based column blocks.

  - POST /api/prs/preview   -> layout, validation results and a sample of rows
  - POST /api/prs/download  -> the consolidated .xlsx (variant=full|core) or a
                               .zip holding both (variant=both)
"""

import io
import zipfile

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)

from ..config import get_settings
from ..core.excel import MAX_BYTES
from ..core.http import content_disposition
from ..core.limiter import limiter
from ..core.prs import (
    PREVIEW_ROWS,
    PrsError,
    build,
    consolidate,
    group_summary,
    prepare,
    to_workbook,
)
from ..deps import get_current_user
from ..models import User
from ..schemas import PrsCheck, PrsGroup, PrsPreview

settings = get_settings()
router = APIRouter(prefix="/api/prs", tags=["prs"])

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_ZIP_MIME = "application/zip"
_SUFFIX = {"full": "_PRS_consolidated_full", "core": "_PRS_consolidated_core"}


async def _read(file: UploadFile) -> tuple[str, bytes]:
    """Read the upload, enforcing the shared 20 MB cap."""
    name = file.filename or "prs_report.xlsx"
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File exceeds the 20 MB limit."
        )
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file is empty.")
    return name, data


@router.post("/preview", response_model=PrsPreview)
@limiter.limit(settings.upload_rate_limit)
async def preview(
    request: Request,
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Consolidate the upload and return the resulting layout, the validation
    report and a sample of rows, so the user can confirm before downloading."""
    name, data = await _read(file)
    try:
        info = prepare(name, data)
        full = consolidate(info, "full")
    except PrsError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.message)

    built, checks = full["built"], full["checks"]
    core = build(info, "core")
    return PrsPreview(
        filename=name,
        work_key=info["key"],
        total_works=len(info["works"]),
        total_parties=info["total_parties"],
        source_rows=info["total_parties"] + info["duplicates"],
        duplicates_removed=info["duplicates"],
        work_columns=built["work_columns"],
        columns=built["columns"],
        core_columns=core["columns"],
        rows=built["rows"][:PREVIEW_ROWS],
        groups=[PrsGroup(**g) for g in group_summary(info)],
        checks=[PrsCheck(**c) for c in checks],
    )


@router.post("/download")
@limiter.limit(settings.upload_rate_limit)
async def download(
    request: Request,
    file: UploadFile = File(...),
    variant: str = Form("full"),
    _user: User = Depends(get_current_user),
):
    """Stream the consolidated workbook(s): the full field set, the core field
    set, or both together in a .zip."""
    if variant not in ("full", "core", "both"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "variant must be 'full', 'core' or 'both'.",
        )
    name, data = await _read(file)
    stem = (name.rsplit(".", 1)[0] or "prs_report")[:80]

    try:
        # One parse + transform pass; the variants only differ in party columns.
        info = prepare(name, data)
        books: list[tuple[str, bytes]] = []
        for want in (("full", "core") if variant == "both" else (variant,)):
            result = consolidate(info, want)
            books.append(
                (f"{stem}{_SUFFIX[want]}.xlsx", to_workbook(info, result["built"], result["checks"]))
            )
    except PrsError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.message)

    if len(books) == 1:
        filename, payload = books[0]
        media_type = _XLSX_MIME
    else:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for book_name, book in books:
                zf.writestr(book_name, book)
        filename, payload, media_type = f"{stem}_PRS_consolidated.zip", buf.getvalue(), _ZIP_MIME

    # A plain Response with an explicit Content-Length (same reasoning as the
    # standardize router: chunked streaming can be reset by the security
    # middleware and gives the client no total to draw a progress bar from).
    return Response(
        content=payload,
        media_type=media_type,
        headers={
            "Content-Disposition": content_disposition(filename, "prs_consolidated.xlsx"),
            "Content-Length": str(len(payload)),
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )
