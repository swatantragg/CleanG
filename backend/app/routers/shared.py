from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from ..db import get_db
from ..models import Branch, File, User
from ..schemas import BranchWithOwner
from ..security import CurrentUser

router = APIRouter(prefix="/shared-branches", tags=["shared"])


@router.get("", response_model=list[BranchWithOwner])
async def list_shared_branches(user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Branches the caller can read from OTHER users: shared + active only.
    Each row carries its downloadable cleaned-file reference (if any)."""
    rows = (
        await db.execute(
            select(Branch, User.name)
            .join(User, User.id == Branch.user_id)
            .where(
                Branch.visibility == "shared",
                Branch.status == "active",
                Branch.user_id != user.id,
            )
            .order_by(Branch.created_at.desc())
        )
    ).all()
    if not rows:
        return []

    branch_ids = [b.id for b, _ in rows]
    cleaned = (
        await db.execute(
            select(File)
            .where(File.branch_id.in_(branch_ids), File.kind == "cleaned", File.status == "available")
            .options(load_only(File.branch_id, File.original_filename, File.size_bytes))
        )
    ).scalars().all()
    by_branch = {f.branch_id: f for f in cleaned}

    out = []
    for branch, owner_name in rows:
        item = BranchWithOwner.model_validate(branch)
        item.owner_name = owner_name
        f = by_branch.get(branch.id)
        if f:
            item.cleaned_file_id = f.id
            item.cleaned_filename = f.original_filename
            item.cleaned_size_bytes = f.size_bytes
        out.append(item)
    return out
