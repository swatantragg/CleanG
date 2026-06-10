from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from .. import settings
from ..db import get_db
from ..models import Branch, File, Preset, User
from ..pipeline import get_pipeline
from ..schemas import BranchCreate, BranchRead, BranchUpdate, CleanRequest, FileRead
from ..security import CurrentUser
from ..storage import get_storage

router = APIRouter(prefix="/branches", tags=["branches"])


async def _owned(db: AsyncSession, branch_id: int, user: User) -> Branch:
    branch = await db.get(Branch, branch_id)
    if not branch or branch.user_id != user.id:
        raise HTTPException(404, "Branch not found.")
    return branch


async def _validate_preset(db: AsyncSession, preset_id: int | None, user: User) -> None:
    if preset_id is None:
        return
    preset = await db.get(Preset, preset_id)
    if not preset or (preset.owner_id is not None and preset.owner_id != user.id):
        raise HTTPException(400, "Preset not found.")


@router.post("", response_model=BranchRead, status_code=201)
async def create_branch(body: BranchCreate, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    await _validate_preset(db, body.preset_id, user)
    branch = Branch(
        user_id=user.id, preset_id=body.preset_id, name=body.name.strip(),
        visibility=body.visibility.value, status="active",
    )
    db.add(branch)
    await db.commit()
    await db.refresh(branch)
    return branch


@router.get("", response_model=list[BranchRead])
async def list_my_branches(user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(Branch).where(Branch.user_id == user.id).order_by(Branch.created_at.desc())
        )
    ).scalars().all()
    return rows


@router.get("/{branch_id}", response_model=BranchRead)
async def get_branch(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    return await _owned(db, branch_id, user)


@router.patch("/{branch_id}", response_model=BranchRead)
async def update_branch(branch_id: int, body: BranchUpdate, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    branch = await _owned(db, branch_id, user)
    if branch.status != "active":
        raise HTTPException(409, "Only active branches can be edited.")
    if body.name is not None:
        branch.name = body.name.strip()
    if body.visibility is not None:
        branch.visibility = body.visibility.value
    if body.preset_id is not None:
        await _validate_preset(db, body.preset_id, user)
        branch.preset_id = body.preset_id
    await db.commit()
    await db.refresh(branch)
    return branch


@router.delete("/{branch_id}", response_model=BranchRead)
async def soft_delete_branch(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Soft delete — the row survives as history; storage is wiped by the purge job."""
    branch = await _owned(db, branch_id, user)
    if branch.status not in ("active", "expired"):
        return branch  # already deleted / purge_failed — idempotent
    branch.status = "deleted"
    branch.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(branch)
    return branch


@router.get("/{branch_id}/files", response_model=list[FileRead])
async def list_branch_files(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    await _owned(db, branch_id, user)
    rows = (
        await db.execute(
            select(File)
            .where(File.branch_id == branch_id)
            .options(defer(File.content), defer(File.content_bytes))  # never list blobs
            .order_by(File.kind, File.created_at)
        )
    ).scalars().all()
    return rows


@router.post("/{branch_id}/clean", response_model=FileRead, status_code=201)
async def run_cleaning(
    branch_id: int,
    body: CleanRequest | None = None,
    user: User = CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Run the cleaning pipeline over the branch's source files → one cleaned file.

    The request carries a primary key plus either a preset id (output columns taken
    from the preset's config) or an explicit custom column list.
    """
    branch = await _owned(db, branch_id, user)
    if branch.status != "active":
        raise HTTPException(409, "Branch is not active.")

    body = body or CleanRequest()
    columns = list(body.columns or [])
    if body.preset_id is not None:
        preset = await db.get(Preset, body.preset_id)
        if not preset or (preset.owner_id is not None and preset.owner_id != user.id):
            raise HTTPException(400, "Preset not found.")
        preset_cols = (preset.config or {}).get("columns") or []
        columns = list(preset_cols) + columns

    spec = {"primary_key": body.primary_key, "preset_id": body.preset_id, "columns": columns}
    storage = get_storage() if settings.STORAGE_BACKEND == "drive" else None
    try:
        cleaned = await get_pipeline().run(db, storage, branch, spec)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await db.commit()
    # Don't re-read the cleaned blob just to serialize metadata.
    await db.refresh(cleaned, attribute_names=["created_at"])
    return cleaned
