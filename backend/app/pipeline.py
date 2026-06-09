"""Cleaning-pipeline hook.

Given a branch's source files, the pipeline runs the cleaning logic and writes ONE
`files` row with kind='cleaned'. The real cleaning engine is wired in later — this is
the integration seam. The current implementation is a clearly-marked passthrough stub
so the upload -> clean -> download -> share flow is exercisable end-to-end.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Branch, File
from .storage import StorageBackend


class CleaningPipeline:
    """Interface for the cleaning engine."""

    async def run(self, db: AsyncSession, storage: StorageBackend, branch: Branch) -> File:
        raise NotImplementedError


class StubPipeline(CleaningPipeline):
    """Placeholder: concatenates source bytes into a single 'cleaned' object.

    Replace `._clean()` with the real engine; everything else (storage write + DB row)
    stays the same.
    """

    async def run(self, db: AsyncSession, storage: StorageBackend, branch: Branch) -> File:
        rows = (
            await db.execute(
                select(File).where(
                    File.branch_id == branch.id,
                    File.kind == "source",
                    File.status == "available",
                )
            )
        ).scalars().all()
        if not rows:
            raise ValueError("Branch has no available source files to clean.")

        # Source text comes from the DB; only the cleaned output goes to Drive.
        sources = [f.content or "" for f in rows]
        cleaned_text = self._clean(sources)
        cleaned_bytes = cleaned_text.encode("utf-8")
        out_name = f"{branch.name.replace(' ', '_')}_cleaned.csv"
        key = await asyncio.to_thread(storage.put, cleaned_bytes, out_name, "text/csv")

        cleaned = File(
            branch_id=branch.id,
            kind="cleaned",
            storage_key=key,
            content=None,
            original_filename=out_name,
            mime_type="text/csv",
            size_bytes=len(cleaned_bytes),
            status="available",
        )
        db.add(cleaned)
        await db.flush()
        return cleaned

    @staticmethod
    def _clean(sources: list[str]) -> str:
        # TODO: wire the real cleaning engine here. Stub = pass through.
        return "\n".join(sources)


_pipeline: CleaningPipeline = StubPipeline()


def get_pipeline() -> CleaningPipeline:
    return _pipeline
