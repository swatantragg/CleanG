"""Seed system presets (owner_id IS NULL, is_shared = true) from config_data.

Idempotent: inserts a system preset only when one with the same name doesn't exist.
Called best-effort on startup.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config_data import PRESETS
from .models import Preset


async def seed_system_presets(db: AsyncSession) -> int:
    existing = set(
        (
            await db.execute(select(Preset.name).where(Preset.owner_id.is_(None)))
        ).scalars().all()
    )
    added = 0
    for name, definition in PRESETS.items():
        if name in existing:
            continue
        db.add(
            Preset(
                owner_id=None,
                name=name,
                config=definition or {},  # "Custom" preset stores {} for a free-form build
                is_shared=True,
            )
        )
        added += 1
    if added:
        await db.commit()
    return added
