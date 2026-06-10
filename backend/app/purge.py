"""Idempotent retention purge.

Selects active branches whose expires_at has passed, deletes their storage objects,
then marks files purged and the branch deleted. The branch ROW always survives as a
history record (never hard-deleted). Storage deletion happens OUTSIDE the DB
transaction — nothing is marked purged until storage confirms. If storage deletion
fails, the branch is flagged 'purge_failed' and retried on the next run.

Run manually:  python -m app.purge
Schedule via cron / systemd timer / k8s CronJob.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from .db import AsyncSessionLocal, is_configured
from .models import Branch, File
from .storage import get_storage


async def purge_branch(db: AsyncSession, storage, branch: Branch) -> str:
    """Purge one branch. Returns the resulting status string."""
    files = (
        await db.execute(
            select(File)
            .where(File.branch_id == branch.id, File.status == "available")
            .options(load_only(File.storage_key, File.status))  # bytes aren't needed to purge
        )
    ).scalars().all()

    # 1) Delete Drive objects first (only cleaned files have a storage_key;
    #    source files are text in the DB), outside any "purged" bookkeeping.
    try:
        for f in files:
            if f.storage_key:
                await asyncio.to_thread(storage.delete, f.storage_key)
    except Exception:
        branch.status = "purge_failed"
        await db.commit()
        return "purge_failed"

    # 2) Storage confirmed gone → mark rows purged and wipe stored data.
    now = datetime.now(timezone.utc)
    for f in files:
        f.status = "purged"
        f.purged_at = now
        f.storage_key = ""
        f.content = None
        f.content_bytes = None
    branch.status = "deleted"
    branch.purged_at = now
    if branch.deleted_at is None:
        branch.deleted_at = now
    await db.commit()
    return "deleted"


async def run_purge() -> dict:
    if not is_configured() or AsyncSessionLocal is None:
        raise RuntimeError("Database is not configured.")
    storage = get_storage()
    summary = {"scanned": 0, "deleted": 0, "purge_failed": 0}
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        due = (
            await db.execute(
                select(Branch).where(Branch.status == "active", Branch.expires_at < now)
            )
        ).scalars().all()
        summary["scanned"] = len(due)
        for branch in due:
            result = await purge_branch(db, storage, branch)
            summary[result] = summary.get(result, 0) + 1
    return summary


if __name__ == "__main__":
    print(asyncio.run(run_purge()))
