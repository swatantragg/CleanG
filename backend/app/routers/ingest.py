"""File ingest: validate (type, size, non-empty), parse, and auto-map columns."""
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException

from ..config import settings
from ..core.parser import parse_upload
from ..core.schema import BUILTINS, SYNS
from ..core.normalize import norm
from ..deps import get_current_user

router = APIRouter(prefix="/ingest", tags=["ingest"])


def _auto_map(headers):
    """Best-effort mapping + per-field suggestion list from header synonyms."""
    mapping, suggestions = {}, {}
    for f in BUILTINS:
        syn = SYNS.get(f["key"], [])
        matches = [h for h in headers if norm(h) in syn]
        suggestions[f["key"]] = matches
        if matches:
            mapping[f["key"]] = matches
    return mapping, suggestions


@router.post("")
async def ingest(file: UploadFile = File(...), _=Depends(get_current_user)):
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    # --- file testing factors ---
    if ext not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Only CSV or Excel files are allowed (.csv, .tsv, .xlsx, .xls)")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(400, "The file is empty — upload a file with data")
    if len(content) > settings.MAX_UPLOAD_BYTES:
        limit_mb = settings.MAX_UPLOAD_BYTES / 1024 / 1024
        got_mb = len(content) / 1024 / 1024
        raise HTTPException(400, f"File exceeds the {limit_mb:.0f} MB limit (got {got_mb:.1f} MB)")

    try:
        headers, rows = parse_upload(filename, content, ext)
    except Exception as exc:
        raise HTTPException(400, f"Could not read the file: {exc}")

    if not headers:
        raise HTTPException(400, "The file has no header row")
    if not rows:
        raise HTTPException(400, "The file has headers but no data rows")

    mapping, suggestions = _auto_map(headers)
    return {
        "headers": headers,
        "rows": rows,
        "fileName": filename,
        "fields": [dict(b) for b in BUILTINS],
        "mapping": mapping,
        "suggestions": suggestions,
    }
