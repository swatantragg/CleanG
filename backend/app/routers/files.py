import asyncio
import io
import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from .. import settings
from ..db import get_db
from ..models import Branch, File, User
from ..schemas import FileRead, SignedUrlResponse
from ..security import CurrentUser, sign_download_token, verify_download_token
from ..storage import get_storage

router = APIRouter(tags=["files"])

# Only CSV or Excel sources are accepted, and a branch may hold one type only.
ALLOWED_EXTS = {".csv": "CSV", ".xlsx": "Excel"}


def _ext(name: str | None) -> str:
    return os.path.splitext(name or "")[1].lower()


@router.post("/branches/{branch_id}/files", response_model=FileRead, status_code=201)
async def upload_source(branch_id: int, file: UploadFile, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Source files keep their raw bytes in the DB — never sent to object storage."""
    branch = await db.get(Branch, branch_id)
    if not branch or branch.user_id != user.id:
        raise HTTPException(404, "Branch not found.")
    if branch.status != "active":
        raise HTTPException(409, "Branch is not active.")

    ext = _ext(file.filename)
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, "Only CSV or Excel (.xlsx) files are allowed.")

    # All sources in a branch must share one type.
    existing = (
        await db.execute(
            select(File)
            .where(File.branch_id == branch.id, File.kind == "source", File.status == "available")
            .options(load_only(File.original_filename))  # don't drag blobs over the wire
        )
    ).scalars().all()
    for prev in existing:
        prev_ext = _ext(prev.original_filename)
        if prev_ext in ALLOWED_EXTS and prev_ext != ext:
            raise HTTPException(
                409,
                f"This branch already holds {ALLOWED_EXTS[prev_ext]} files — "
                f"all source files must be the same type.",
            )

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file.")
    if len(data) > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File exceeds the upload size limit.")

    row = File(
        branch_id=branch.id, kind="source", storage_key="", content=None, content_bytes=data,
        original_filename=file.filename, mime_type=file.content_type,
        size_bytes=len(data), status="available",
    )
    db.add(row)
    await db.commit()
    # Refresh only the server-set column — never re-read the blob we just sent.
    await db.refresh(row, attribute_names=["created_at"])
    return row


@router.get("/files/{file_id}/download", response_model=SignedUrlResponse)
async def download(file_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Authorize, then mint a short-lived signed URL to the stream endpoint."""
    # Authorization needs metadata only — don't load the blob just to mint a URL.
    f = (
        await db.execute(
            select(File)
            .where(File.id == file_id)
            .options(load_only(File.branch_id, File.kind, File.status))
        )
    ).scalar_one_or_none()
    if not f:
        raise HTTPException(404, "File not found.")
    if f.status == "purged":
        raise HTTPException(410, "File has been purged.")

    branch = await db.get(Branch, f.branch_id)
    is_owner = branch and branch.user_id == user.id
    shared_cleaned = (
        f.kind == "cleaned" and branch and branch.visibility == "shared" and branch.status == "active"
    )
    if not (is_owner or shared_cleaned):
        raise HTTPException(403, "Not allowed to download this file.")

    ttl = settings.SIGNED_URL_TTL_SECONDS
    token = sign_download_token(f.id, ttl)
    url = f"{settings.PUBLIC_BASE_URL}{settings.API_PREFIX}/files/{f.id}/stream?token={token}"
    return SignedUrlResponse(url=url, expires_in=ttl)


@router.get("/files/{file_id}/stream")
async def stream(file_id: int, token: str, db: AsyncSession = Depends(get_db)):
    """Validate the short-lived token and stream the bytes. No standing auth header
    needed — the signed token is the capability."""
    tok_file_id = verify_download_token(token)
    if tok_file_id != file_id:
        raise HTTPException(401, "Token does not match file.")
    f = await db.get(File, file_id)
    if not f or f.status == "purged":
        raise HTTPException(410, "File is no longer available.")

    if f.storage_key:
        # cleaned file → Google Drive
        data = await asyncio.to_thread(get_storage().get, f.storage_key)
    elif f.content_bytes is not None:
        # source file (or locally-stored cleaned file) → raw bytes in the DB
        data = f.content_bytes
    else:
        # legacy rows stored decoded text
        data = (f.content or "").encode("utf-8")
    filename = f.original_filename or f"file-{f.id}"
    return StreamingResponse(
        io.BytesIO(data),
        media_type=f.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
