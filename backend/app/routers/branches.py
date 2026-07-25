from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import can_access_all_branches, get_current_user
from ..models import (
    ActivityLog,
    Branch,
    FileStatus,
    MasterData,
    MasterRecord,
    UploadedFile,
    User,
)
from ..schemas import BranchCreate, BranchOut

router = APIRouter(prefix="/api/branches", tags=["branches"])

# Furthest workflow step a file's status represents.
_STATUS_RANK = {
    FileStatus.uploaded: 1,
    FileStatus.mapped: 2,
    FileStatus.cleaned: 3,
    FileStatus.committed: 4,
}


def _get_branch_or_404(branch_id: int, user: User, db: Session) -> Branch:
    branch = db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Branch not found")
    if not can_access_all_branches(user) and branch.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your branch")
    return branch


def _rollups(branch_ids: list[int], db: Session) -> dict[int, tuple[int, int]]:
    """{branch_id: (file_count, progress)} in a single lightweight query.

    Only the branch id + status columns are read (never the big row blob), so
    this stays cheap no matter how many files a branch holds.
    """
    if not branch_ids:
        return {}
    rows = db.execute(
        select(UploadedFile.branch_id, UploadedFile.status).where(
            UploadedFile.branch_id.in_(branch_ids)
        )
    ).all()
    out: dict[int, tuple[int, int]] = {}
    for bid, st in rows:
        count, progress = out.get(bid, (0, 0))
        out[bid] = (count + 1, max(progress, _STATUS_RANK.get(st, 0)))
    return out


def _to_out(branch: Branch, rollups: dict[int, tuple[int, int]]) -> BranchOut:
    count, progress = rollups.get(branch.id, (0, 0))
    return BranchOut(
        id=branch.id,
        name=branch.name,
        description=branch.description,
        status=branch.status,
        owner_id=branch.owner_id,
        created_at=branch.created_at,
        file_count=count,
        progress=progress,
    )


@router.get("", response_model=list[BranchOut])
def list_branches(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Admins see all branches; regular users see only their own.

    Each branch carries its file count + furthest progress so the dashboard
    renders rich cards from a single request (two cheap queries, no N+1).
    """
    stmt = select(Branch).order_by(Branch.created_at.desc())
    if not can_access_all_branches(current_user):
        stmt = stmt.where(Branch.owner_id == current_user.id)
    branches = db.scalars(stmt).all()
    rollups = _rollups([b.id for b in branches], db)
    return [_to_out(b, rollups) for b in branches]


@router.get("/{branch_id}", response_model=BranchOut)
def get_branch(
    branch_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fetch a single branch — lets the workspace load without pulling the whole
    branch list just to find one by id."""
    branch = _get_branch_or_404(branch_id, current_user, db)
    return _to_out(branch, _rollups([branch.id], db))


@router.post("", response_model=BranchOut, status_code=status.HTTP_201_CREATED)
def create_branch(
    payload: BranchCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new branch (one per cleaning request)."""
    branch = Branch(
        name=payload.name,
        description=payload.description,
        owner_id=current_user.id,
    )
    db.add(branch)
    db.commit()
    db.refresh(branch)
    return _to_out(branch, {})


@router.delete("/{branch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_branch(
    branch_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete a branch and everything stored under it. Admins and super
    users only (a plain user can't delete even their own).

    The committed master records, audit log and uploaded files all reference the
    branch via foreign keys without a DB-level cascade, so they're removed first
    (by branch_id) before the branch row itself.
    """
    if not can_access_all_branches(current_user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only an administrator or super user can delete a branch.",
        )
    branch = db.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Branch not found")

    db.execute(delete(MasterData).where(MasterData.branch_id == branch_id))
    db.execute(delete(MasterRecord).where(MasterRecord.branch_id == branch_id))
    db.execute(delete(ActivityLog).where(ActivityLog.branch_id == branch_id))
    db.execute(delete(UploadedFile).where(UploadedFile.branch_id == branch_id))
    db.delete(branch)
    db.commit()
