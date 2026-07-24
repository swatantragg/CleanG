"""Reverse PRS tab: upload a one-row-per-work sheet (Composer 1, Lyricist 1,
Singer 1, …) and get back the MLC Bulk Work workbook, one row per writer.

  - POST /api/mlc/preview   -> mapping, validation results and a sample of rows
  - POST /api/mlc/download  -> the MLC Bulk Work .xlsx, or a .zip of one complete
                               workbook per 300-row part when it doesn't fit in one
"""

import io
import zipfile

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.activity import log_file_activity
from ..core.excel import MAX_BYTES
from ..core.http import content_disposition
from ..core.limiter import limiter
from ..core.mlc import (
    PREVIEW_ROWS,
    ROLE_AUTHOR,
    ROLE_COMBINED,
    ROLE_COMPOSER,
    MlcError,
    convert,
    source_mapping,
    to_workbooks,
    unmapped_columns,
)
from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import MlcMapping, MlcPreview, PrsCheck

settings = get_settings()
router = APIRouter(prefix="/api/mlc", tags=["mlc"])

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_ZIP_MIME = "application/zip"
_SUFFIX = "_MLC_bulk_work"


async def _read(file: UploadFile) -> tuple[str, bytes]:
    """Read the upload, enforcing the shared 20 MB cap."""
    name = file.filename or "works.xlsx"
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File exceeds the 20 MB limit."
        )
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file is empty.")
    return name, data


@router.post("/preview", response_model=MlcPreview)
@limiter.limit(settings.upload_rate_limit)
async def preview(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Expand the upload and return the column mapping, the validation report and
    a sample of rows, so the user can confirm before downloading."""
    name, data = await _read(file)
    try:
        result = convert(name, data)
    except MlcError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.message)

    info, built = result["info"], result["built"]
    log_file_activity(db, user, name, "Reverse PRS")
    return MlcPreview(
        filename=name,
        total_works=built["works"],
        total_writers=len(built["rows"]),
        composers=built["writer_counts"][ROLE_COMPOSER],
        lyricists=built["writer_counts"][ROLE_AUTHOR],
        combined=built["writer_counts"][ROLE_COMBINED],
        source_rows=len(info["rows"]),
        part_rows=[len(part) for part in built["parts"]],
        columns=built["columns"],
        rows=built["rows"][:PREVIEW_ROWS],
        mapping=[MlcMapping(**m) for m in source_mapping(info)],
        unmapped_columns=unmapped_columns(info),
        checks=[PrsCheck(**c) for c in result["checks"]],
    )


@router.post("/download")
@limiter.limit(settings.upload_rate_limit)
async def download(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stream the MLC Bulk Work workbook built from the upload — or, when the
    output runs past the 300-row file limit, a .zip holding one complete workbook
    per part (a song is never split between two of them)."""
    name, data = await _read(file)
    stem = (name.rsplit(".", 1)[0] or "works")[:80] + _SUFFIX
    try:
        result = convert(name, data)
        books = to_workbooks(result["built"], stem)
    except MlcError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.message)

    log_file_activity(db, user, name, "Reverse PRS")

    if len(books) == 1:
        filename, payload = books[0]
        media_type, fallback = _XLSX_MIME, "mlc_bulk_work.xlsx"
    else:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for book_name, book in books:
                zf.writestr(book_name, book)
        filename, payload = f"{stem}.zip", buf.getvalue()
        media_type, fallback = _ZIP_MIME, "mlc_bulk_work.zip"

    # A plain Response with an explicit Content-Length (same reasoning as the PRS
    # router: chunked streaming can be reset by the security middleware and gives
    # the client no total to draw a progress bar from).
    return Response(
        content=payload,
        media_type=media_type,
        headers={
            "Content-Disposition": content_disposition(filename, fallback),
            "Content-Length": str(len(payload)),
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )
