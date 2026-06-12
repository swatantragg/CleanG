import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from .. import settings
from ..db import get_db
from ..models import Branch, File, Preset, User
from .. import pipeline
from ..schemas import (
    BranchCreate, BranchRead, BranchUpdate, BulkResolveBody, CleanRequest, CleanResult,
    FileRead, ResolveBody,
)
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
            .where(File.branch_id == branch_id, File.kind != "staging")  # hide the review staging blob
            .options(defer(File.content), defer(File.content_bytes))  # never list blobs
            .order_by(File.kind, File.created_at)
        )
    ).scalars().all()
    return rows


async def _load_staging(db: AsyncSession, branch_id: int) -> tuple[File | None, dict | None]:
    row = (
        await db.execute(
            select(File).where(File.branch_id == branch_id, File.kind == "staging").limit(1)
        )
    ).scalars().first()
    if not row or row.content_bytes is None:
        return None, None
    return row, json.loads(row.content_bytes.decode("utf-8"))


async def _finalize(db: AsyncSession, branch: Branch, staging_row: File, staging: dict) -> File:
    storage = get_storage() if settings.STORAGE_BACKEND == "drive" else None
    result = await asyncio.to_thread(pipeline.apply_resolutions, staging)
    cleaned_bytes = await asyncio.to_thread(pipeline.render_csv, result)
    cleaned = await pipeline.store_cleaned(branch, cleaned_bytes, storage)
    db.add(cleaned)
    # Master is built — drop the sources and the staging blob (only the output is kept).
    await db.execute(
        delete(File).where(File.branch_id == branch.id, File.kind.in_(("source", "staging")))
    )
    await db.commit()
    await db.refresh(cleaned, attribute_names=["created_at"])
    return cleaned


@router.post("/{branch_id}/clean", response_model=CleanResult, status_code=201)
async def run_cleaning(
    branch_id: int,
    body: CleanRequest | None = None,
    user: User = CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Clean + standardize + merge the source files. High-confidence duplicates are merged
    automatically; uncertain ones are held for human review (status='review'). With no
    uncertain duplicates the cleaned master is produced immediately (status='completed')."""
    branch = await _owned(db, branch_id, user)
    if branch.status != "active":
        raise HTTPException(409, "Branch is not active.")

    body = body or CleanRequest()
    columns = list(body.columns or [])
    if body.preset_id is not None:
        preset = await db.get(Preset, body.preset_id)
        if not preset or (preset.owner_id is not None and preset.owner_id != user.id):
            raise HTTPException(400, "Preset not found.")
        columns = list((preset.config or {}).get("columns") or []) + columns

    spec = {"primary_key": body.primary_key, "columns": columns}

    srcs = (
        await db.execute(
            select(File).where(
                File.branch_id == branch.id, File.kind == "source", File.status == "available"
            )
        )
    ).scalars().all()
    source_files = [
        (f.original_filename, f.content_bytes if f.content_bytes is not None else (f.content or "").encode("utf-8"))
        for f in srcs
    ]
    if not source_files:
        raise HTTPException(400, "Branch has no source files to clean.")

    try:
        result, review = await asyncio.to_thread(pipeline.clean_and_detect, source_files, spec)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Re-running supersedes any earlier cleaned/staging artifact.
    await db.execute(
        delete(File).where(File.branch_id == branch.id, File.kind.in_(("cleaned", "staging")))
    )

    if review:
        result["review"] = review
        blob = json.dumps(result).encode("utf-8")
        db.add(File(
            branch_id=branch.id, kind="staging", storage_key="", content=None, content_bytes=blob,
            original_filename="staging.json", mime_type="application/json",
            size_bytes=len(blob), status="available",
        ))
        await db.commit()
        return CleanResult(status="review", review_count=len(review))

    cleaned_bytes = await asyncio.to_thread(pipeline.render_csv, result)
    storage = get_storage() if settings.STORAGE_BACKEND == "drive" else None
    cleaned = await pipeline.store_cleaned(branch, cleaned_bytes, storage)
    db.add(cleaned)
    await db.execute(delete(File).where(File.branch_id == branch.id, File.kind == "source"))
    await db.commit()
    await db.refresh(cleaned, attribute_names=["id", "created_at"])
    return CleanResult(status="completed", cleaned_file_id=cleaned.id)


_REVIEW_PAGE_MAX = 200  # hard cap so a single request never materializes the whole queue


@router.get("/{branch_id}/review")
async def get_review(
    branch_id: int,
    offset: int = 0,
    limit: int = 50,
    status: str | None = None,  # None=all, "pending", or "resolved"
    user: User = CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """A *page* of the records flagged for human review (heavy corruption / contradictory
    identity). The queue can hold 100k+ records, so counts are computed cheaply over the
    staged list but display values are rendered only for the requested slice."""
    await _owned(db, branch_id, user)
    _, staging = await _load_staging(db, branch_id)
    if not staging:
        return {"active": False, "pkDisplay": None, "columns": [], "items": [],
                "total": 0, "pending": 0, "resolved": 0, "offset": 0, "limit": limit}

    out_cols = staging["out_cols"]
    master = staging["master"]
    cols = [staging["pk_display"]] + [c["disp"] for c in out_cols]
    all_items = staging.get("review", [])

    # Staging from a pre-rewrite clean used duplicate *pairs* (a/b), not single records.
    # That shape can't be rendered here — tell the client to re-run cleaning instead of 500.
    if all_items and "pk" not in all_items[0]:
        return {"active": True, "stale": True, "pkDisplay": staging["pk_display"],
                "columns": cols, "items": [], "total": 0, "pending": 0, "resolved": 0,
                "offset": 0, "limit": limit}

    pending = sum(1 for it in all_items if it["status"] != "resolved")
    resolved = len(all_items) - pending

    if status == "pending":
        filtered = [it for it in all_items if it["status"] != "resolved"]
    elif status == "resolved":
        filtered = [it for it in all_items if it["status"] == "resolved"]
    else:
        filtered = all_items
    total = len(filtered)

    limit = max(1, min(limit, _REVIEW_PAGE_MAX))
    offset = max(0, min(offset, total))
    page = filtered[offset:offset + limit]

    def view(it: dict) -> dict:
        pk = it["pk"]
        rec = master.get(pk, {})
        values = {staging["pk_display"]: pk}
        values.update(pipeline.display_record(out_cols, rec))
        return {
            "id": it["id"], "status": it["status"], "action": it.get("action"),
            "pk": pk, "values": values, "issues": it.get("issues", []),
        }

    items = [view(it) for it in page]
    return {"active": True, "pkDisplay": staging["pk_display"], "columns": cols,
            "items": items, "total": total, "pending": pending, "resolved": resolved,
            "offset": offset, "limit": limit}


# NOTE: /review/bulk must be declared BEFORE /review/{item_id}, else "bulk" is parsed
# as item_id (an int) and the bulk route is never reached.
@router.post("/{branch_id}/review/bulk")
async def bulk_resolve_review(
    branch_id: int, body: BulkResolveBody,
    user: User = CurrentUser, db: AsyncSession = Depends(get_db),
):
    """Apply one decision to many records at once (multi-select). 'accept' writes each
    record's suggested fixes (field → suggestion); 'dismiss' keeps them as-is."""
    await _owned(db, branch_id, user)
    row, staging = await _load_staging(db, branch_id)
    if not staging:
        raise HTTPException(404, "No review in progress for this branch.")
    items = staging.get("review", [])
    if body.all_pending:
        targets = [it for it in items if it["status"] != "resolved"]
        if body.limit:                       # chunked progress: resolve only the next slice
            targets = targets[:body.limit]
    else:
        idset = set(body.ids)
        targets = [it for it in items if it["id"] in idset]
    for it in targets:
        it["status"] = "resolved"
        if body.action == "accept":
            fixes = {i["field"]: i["suggestion"] for i in it.get("issues", []) if i.get("suggestion")}
            it["action"] = "fix" if fixes else "dismiss"
            it["fixes"] = fixes
        elif body.action == "delete":
            it["action"] = "delete"
            it["fixes"] = {}
        else:
            it["action"] = "dismiss"
            it["fixes"] = {}
    blob = json.dumps(staging).encode("utf-8")
    row.content_bytes = blob
    row.size_bytes = len(blob)
    await db.commit()
    pending = sum(1 for it in items if it["status"] != "resolved")
    return {"ok": True, "resolved": len(targets), "pending": pending}


@router.post("/{branch_id}/review/{item_id}")
async def resolve_review(
    branch_id: int, item_id: int, body: ResolveBody,
    user: User = CurrentUser, db: AsyncSession = Depends(get_db),
):
    """Record the operator's decision on one flagged record."""
    await _owned(db, branch_id, user)
    row, staging = await _load_staging(db, branch_id)
    if not staging:
        raise HTTPException(404, "No review in progress for this branch.")
    item = next((it for it in staging.get("review", []) if it["id"] == item_id), None)
    if not item:
        raise HTTPException(404, "Review item not found.")
    item["status"] = "resolved"
    item["action"] = body.action
    item["fixes"] = body.fixes if body.action == "fix" else {}
    blob = json.dumps(staging).encode("utf-8")
    row.content_bytes = blob
    row.size_bytes = len(blob)
    await db.commit()
    pending = sum(1 for it in staging.get("review", []) if it["status"] != "resolved")
    return {"ok": True, "pending": pending}


@router.post("/{branch_id}/finalize", response_model=CleanResult, status_code=201)
async def finalize(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Apply every review decision and build the final cleaned master (Step 7).
    Unresolved pairs default to keeping both records."""
    branch = await _owned(db, branch_id, user)
    if branch.status != "active":
        raise HTTPException(409, "Branch is not active.")
    row, staging = await _load_staging(db, branch_id)
    if not staging:
        raise HTTPException(404, "No review in progress for this branch.")
    cleaned = await _finalize(db, branch, row, staging)
    return CleanResult(status="completed", cleaned_file_id=cleaned.id)


@router.post("/{branch_id}/skip", status_code=201)
async def skip_and_export(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Skip manual review: export two .xlsx files — the confidently-clean rows and the
    flagged (corrupted) rows separately — so the operator can handle corruption in Excel
    instead of on screen. Supersedes any earlier output and drops sources + staging."""
    branch = await _owned(db, branch_id, user)
    if branch.status != "active":
        raise HTTPException(409, "Branch is not active.")
    row, staging = await _load_staging(db, branch_id)
    if not staging:
        raise HTTPException(404, "No review in progress for this branch.")

    good_pks, corrupted_pks, issue_by_pk = pipeline.split_corrupted(staging)
    cleaned_bytes = await asyncio.to_thread(pipeline.render_xlsx, staging, good_pks)
    corrupted_bytes = await asyncio.to_thread(pipeline.render_xlsx, staging, corrupted_pks, issue_by_pk)

    storage = get_storage() if settings.STORAGE_BACKEND == "drive" else None
    cleaned = await pipeline.store_output(branch, cleaned_bytes, storage, kind="cleaned",
                                          suffix="cleaned.xlsx", mime=pipeline.XLSX_MIME)
    corrupted = await pipeline.store_output(branch, corrupted_bytes, storage, kind="corrupted",
                                            suffix="corrupted.xlsx", mime=pipeline.XLSX_MIME)
    # Supersede every prior artifact first, then persist the two new exports.
    await db.execute(
        delete(File).where(File.branch_id == branch.id,
                           File.kind.in_(("source", "staging", "cleaned", "corrupted")))
    )
    db.add_all([cleaned, corrupted])
    await db.commit()
    await db.refresh(cleaned, attribute_names=["id"])
    await db.refresh(corrupted, attribute_names=["id"])
    return {"status": "completed", "cleaned_file_id": cleaned.id, "corrupted_file_id": corrupted.id,
            "cleaned_count": len(good_pks), "corrupted_count": len(corrupted_pks)}


@router.delete("/{branch_id}/review", status_code=204)
async def cancel_review(branch_id: int, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """Discard the staged review and return to the wizard (sources are kept)."""
    await _owned(db, branch_id, user)
    await db.execute(delete(File).where(File.branch_id == branch_id, File.kind == "staging"))
    await db.commit()
