"""Standalone "Standardize" tab: upload a messy file, get it reshaped into the
canonical 30-column master format (proper column allocation, multi-column merge,
value standardization) — no cleaning queue, no flagging.

Two endpoints share the same engine:
  - POST /api/standardize/preview  -> the resolved mapping + a sample of rows
  - POST /api/standardize/download -> the full standardized .xlsx
"""

import io

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from openpyxl import Workbook

from ..core.excel import MAX_BYTES
from ..core.http import content_disposition
from ..core.standardize import (
    StandardizeError,
    load_table,
    mapping_summary,
    standardize,
)
from ..deps import get_current_user
from ..models import User
from ..schemas import StandardizeMapping, StandardizePreview

router = APIRouter(prefix="/api/standardize", tags=["standardize"])

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_PREVIEW_ROWS = 20


async def _read_table(file: UploadFile) -> tuple[str, list, list]:
    """Read + parse an uploaded file, enforcing the shared size cap."""
    name = file.filename or "upload.csv"
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "File exceeds the 20 MB limit.",
        )
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The file is empty.")
    try:
        headers, rows = load_table(name, data)
    except StandardizeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, exc.message)
    return name, headers, rows


@router.post("/preview", response_model=StandardizePreview)
async def preview(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Standardize the upload and return the column mapping plus a sample of the
    master-formatted rows, so the user can confirm the allocation before
    downloading the full file."""
    name, headers, rows = await _read_table(file)
    result = standardize(headers, rows)
    summary = mapping_summary(result["mapping"])
    return StandardizePreview(
        columns=result["columns"],
        mapping=[StandardizeMapping(**m) for m in summary],
        rows=result["rows"][:_PREVIEW_ROWS],
        total_rows=len(result["rows"]),
        matched_columns=sum(1 for m in summary if m["matched"]),
        filename=name,
    )


@router.post("/download")
async def download(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Standardize the upload and stream the full result as an .xlsx workbook in
    the master format."""
    name, headers, rows = await _read_table(file)
    result = standardize(headers, rows)
    columns = result["columns"]

    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Standardized")
    ws.append(columns)
    for row in result["rows"]:
        ws.append([row.get(c, "") for c in columns])

    buf = io.BytesIO()
    wb.save(buf)
    payload = buf.getvalue()
    stem = name.rsplit(".", 1)[0] or "standardized"
    filename = f"{stem}_standardized.xlsx"
    # A plain Response with an explicit Content-Length (the workbook is already
    # fully in memory) — not a chunked StreamingResponse, which the security
    # middleware can reset mid-stream (surfacing as a browser NetworkError) and
    # which gives the client no total size to draw a download progress bar from.
    return Response(
        content=payload,
        media_type=_XLSX_MIME,
        headers={
            "Content-Disposition": content_disposition(filename, "standardized.xlsx"),
            "Content-Length": str(len(payload)),
            # Let the browser read the filename header on cross-origin setups.
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )
