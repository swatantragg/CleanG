"""Cleaning pipeline.

Given a branch's source files (CSV or XLSX), a primary key, and an output-column
selection (from a preset or a custom pick), the pipeline parses every file, merges
rows across files on the primary key, and writes ONE cleaned CSV (kind='cleaned').

Column names are matched case-insensitively (e.g. "ISRC" == "isrc"), so files that
label the same field differently still line up.
"""
from __future__ import annotations

import asyncio
import csv
import io
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import settings
from .models import Branch, File
from .storage import StorageBackend


def _norm(s) -> str:
    return " ".join(str(s).split()).lower()


def _parse(filename: str | None, data: bytes) -> tuple[list[str], list[list[str]]]:
    """Return (headers, rows) for a CSV or XLSX file. rows are aligned to headers."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".xlsx":
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        ws = wb[wb.sheetnames[0]]
        rows_iter = ws.iter_rows(values_only=True)
        try:
            header = list(next(rows_iter))
        except StopIteration:
            wb.close()
            return [], []
        headers = [("" if c is None else str(c)).strip() for c in header]
        body = [["" if c is None else str(c) for c in row] for row in rows_iter]
        wb.close()
        return headers, body

    # CSV (and anything else) — decode and read.
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader]
    if not all_rows:
        return [], []
    headers = [c.strip() for c in all_rows[0]]
    return headers, all_rows[1:]


class CleaningPipeline:
    """Interface for the cleaning engine."""

    async def run(self, db: AsyncSession, storage: StorageBackend | None, branch: Branch, spec: dict) -> File:
        raise NotImplementedError


class MergePipeline(CleaningPipeline):
    """Parse → merge on primary key → select output columns → one cleaned CSV."""

    async def run(self, db: AsyncSession, storage: StorageBackend | None, branch: Branch, spec: dict) -> File:
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

        parsed = []
        for f in rows:
            data = f.content_bytes if f.content_bytes is not None else (f.content or "").encode("utf-8")
            headers, body = _parse(f.original_filename, data)
            if headers:
                parsed.append((headers, body))
        if not parsed:
            raise ValueError("Could not read any columns from the source files.")

        # Representative original-cased name for each normalized column (first seen).
        display: dict[str, str] = {}
        for headers, _ in parsed:
            for h in headers:
                display.setdefault(_norm(h), h)

        pk_norm = _norm(spec.get("primary_key") or "")
        if not pk_norm or pk_norm not in display:
            raise ValueError("The selected primary key is not present in the files.")

        requested = [_norm(c) for c in (spec.get("columns") or [])]
        # de-dup, drop the pk, keep only columns that actually exist somewhere
        seen, out_cols = set(), []
        for c in requested:
            if c and c != pk_norm and c in display and c not in seen:
                seen.add(c)
                out_cols.append(c)

        merged: dict[str, dict[str, str]] = {}
        order: list[str] = []
        for headers, body in parsed:
            idx = {_norm(h): i for i, h in enumerate(headers)}
            if pk_norm not in idx:
                continue  # this file can't be merged on the chosen key
            pki = idx[pk_norm]
            for row in body:
                key = (row[pki] if pki < len(row) else "").strip()
                if not key:
                    continue
                if key not in merged:
                    merged[key] = {}
                    order.append(key)
                rec = merged[key]
                for c in out_cols:
                    if c in idx:
                        i = idx[c]
                        val = (row[i] if i < len(row) else "") or ""
                        if val and not rec.get(c):
                            rec[c] = val

        out = io.StringIO()
        w = csv.writer(out)
        w.writerow([display[pk_norm]] + [display[c] for c in out_cols])
        for key in order:
            rec = merged[key]
            w.writerow([key] + [rec.get(c, "") for c in out_cols])
        cleaned_bytes = out.getvalue().encode("utf-8")

        out_name = f"{branch.name.replace(' ', '_')}_cleaned.csv"
        if settings.STORAGE_BACKEND == "drive":
            if storage is None:
                raise ValueError("Drive storage is not configured.")
            key = await asyncio.to_thread(storage.put, cleaned_bytes, out_name, "text/csv")
            cleaned = File(
                branch_id=branch.id, kind="cleaned", storage_key=key, content=None,
                content_bytes=None, original_filename=out_name, mime_type="text/csv",
                size_bytes=len(cleaned_bytes), status="available",
            )
        else:
            cleaned = File(
                branch_id=branch.id, kind="cleaned", storage_key="", content=None,
                content_bytes=cleaned_bytes, original_filename=out_name, mime_type="text/csv",
                size_bytes=len(cleaned_bytes), status="available",
            )

        db.add(cleaned)
        await db.flush()
        return cleaned


_pipeline: CleaningPipeline = MergePipeline()


def get_pipeline() -> CleaningPipeline:
    return _pipeline
