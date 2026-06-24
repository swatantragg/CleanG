"""Persisting cleaned rows into the structured master dataset, with dedup.

A recording is stored exactly once. Re-uploading the same row from another
branch does NOT add a new row (no storage bloat). The one allowed difference is
ownership: a song can be sold to a different Label / Publisher / Distributor, so
when every identity field matches but an ownership field changed, the existing
row is updated in place to the latest owner instead of being duplicated.
"""

import hashlib
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import MASTER_COLUMN_TO_ATTR, MasterData

# Ownership/rights fields that may legitimately change while the recording stays
# the same record — these are excluded from the identity hash and, when they
# differ on an otherwise-identical row, drive an in-place "store the latest" update.
OWNERSHIP_FIELDS = ("Label", "Publisher", "Distributor")

# Excluded from the identity fingerprint: the serial Record # (a per-file
# position, not part of a recording's identity) plus the ownership fields.
_IDENTITY_EXCLUDE = {"Record #", *OWNERSHIP_FIELDS}

# Master columns that take part in the identity hash, in a fixed order.
_IDENTITY_COLUMNS = [c for c in MASTER_COLUMN_TO_ATTR if c not in _IDENTITY_EXCLUDE]


def _norm(v) -> str:
    return re.sub(r"\s+", " ", str(v or "").strip()).lower()


def fingerprint(values: dict) -> str:
    """Stable identity hash for a cleaned row (ownership + serial excluded)."""
    payload = "".join(f"{c}{_norm(values.get(c))}" for c in _IDENTITY_COLUMNS)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _row_attrs(values: dict) -> dict:
    """Map a cleaned row (keyed by master column name) onto MasterData attrs."""
    return {
        attr: (values.get(col) or "")
        for col, attr in MASTER_COLUMN_TO_ATTR.items()
    }


def _ownership_differs(existing: MasterData, values: dict) -> bool:
    for col in OWNERSHIP_FIELDS:
        attr = MASTER_COLUMN_TO_ATTR.get(col)
        if attr is None:
            continue  # field not part of this schema (e.g. Publisher)
        if _norm(getattr(existing, attr)) != _norm(values.get(col)):
            return True
    return False


# Fetch existing records in chunks so the IN(...) parameter list stays sane on
# very large saves (a single huge IN clause can be rejected / slow).
_FETCH_CHUNK = 1000


def upsert_master_records(
    db: Session,
    branch_id: int,
    file_id: int,
    rows: list,
    resolutions: dict[int, dict] | None = None,
) -> dict:
    """Store clean rows into `master_data`, de-duplicating against what's there.

    `rows` are clean `CleanRow`-like objects (each carrying `.index` and
    `.values`). `resolutions` (optional) maps a row index -> a near-duplicate
    decision the user made on the review screen (see `find_conflicts`):
    `{"decision": "cleaned" | "master" | "both", "master_id": int}`.
      - "master"  -> the existing record wins; the cleaned row is NOT stored.
      - "cleaned" -> the existing record is overwritten with the cleaned values.
      - "both"    -> the cleaned row is stored as a brand-new record.
    Rows without a resolution take the normal dedup / ownership path.

    Returns counts: {inserted, updated, duplicates, skipped_conflicts}.
    `duplicates` are rows whose identity AND ownership already match an existing
    record (nothing stored); `skipped_conflicts` are rows the user resolved in
    favour of the existing master record.

    Bulk by design: existing records are read in a couple of queries (not one
    per row), so a multi-thousand-row save is a handful of round-trips rather
    than thousands — what was previously timing out the request.
    """
    resolutions = resolutions or {}
    inserted = updated = duplicates = skipped_conflicts = 0

    # Fingerprint every row once, then load all already-stored matches up front.
    fps = [fingerprint(r.values) for r in rows]
    unique_fps = list(dict.fromkeys(fps))
    existing: dict[str, MasterData] = {}
    for i in range(0, len(unique_fps), _FETCH_CHUNK):
        chunk = unique_fps[i : i + _FETCH_CHUNK]
        for m in db.scalars(
            select(MasterData).where(MasterData.fingerprint.in_(chunk))
        ):
            existing[m.fingerprint] = m

    pending: dict[str, MasterData] = {}  # new rows created in this batch
    for r, fp in zip(rows, fps):
        values = r.values
        decision = resolutions.get(r.index)
        if decision is not None:
            choice = decision.get("decision")
            if choice == "master":
                # Existing record wins — leave the master data untouched.
                skipped_conflicts += 1
                continue
            if choice == "cleaned":
                # Overwrite the matched record in place with the cleaned values.
                master = (
                    db.get(MasterData, decision.get("master_id"))
                    if decision.get("master_id")
                    else None
                )
                clash = existing.get(fp) or pending.get(fp)
                if master is not None and (clash is None or clash is master):
                    for attr, val in _row_attrs(values).items():
                        setattr(master, attr, val)
                    master.fingerprint = fp
                    master.branch_id = branch_id
                    master.file_id = file_id
                    existing[fp] = master
                    updated += 1
                    continue
                if clash is not None:
                    # Another row already carries this identity — don't duplicate.
                    duplicates += 1
                    continue
                # The matched record vanished — fall through and insert as new.
            # "both" (or a stale match) -> normal insert/dedup path below.

        target = existing.get(fp) or pending.get(fp)
        if target is None:
            obj = MasterData(
                branch_id=branch_id,
                file_id=file_id,
                fingerprint=fp,
                **_row_attrs(values),
            )
            pending[fp] = obj
            inserted += 1
        elif _ownership_differs(target, values):
            # Same recording, new owner -> keep the latest values (and source refs).
            for attr, val in _row_attrs(values).items():
                setattr(target, attr, val)
            target.branch_id = branch_id
            target.file_id = file_id
            updated += 1
        else:
            duplicates += 1

    db.add_all(pending.values())  # one batched INSERT, committed by the caller
    return {
        "inserted": inserted,
        "updated": updated,
        "duplicates": duplicates,
        "skipped_conflicts": skipped_conflicts,
    }


# --------------------------------------------------------------------------
# Near-duplicate detection
# --------------------------------------------------------------------------
# A cleaned row is "the same recording" as a stored one when they share a strong
# identity anchor, tried strongest-first: a global ISRC, else UPC + Track Name,
# else Track + Album + Artist. When such a row matches an anchor but is NOT an
# exact identity match (some field differs), it's surfaced to the reviewer rather
# than silently stored — these are the rows `find_conflicts` returns.


def _ng(values: dict, col: str) -> str:
    return _norm(values.get(col))


def _anchor_query(values: dict) -> tuple[str, str] | None:
    """The (MasterData attribute, normalized value) to bulk-fetch candidates by,
    or None when the row lacks any usable identity anchor."""
    isrc = _ng(values, "ISRC")
    if isrc:
        return ("isrc", isrc)
    if _ng(values, "UPC") and _ng(values, "Track Name"):
        return ("upc", _ng(values, "UPC"))
    if (
        _ng(values, "Track Name")
        and _ng(values, "Album Name")
        and (_ng(values, "Singer") or _ng(values, "Lead Artist"))
    ):
        return ("track_name", _ng(values, "Track Name"))
    return None


def _is_same_recording(m: MasterData, values: dict, attr: str) -> bool:
    """Confirm a bulk-fetched candidate truly shares the cleaned row's anchor."""
    if attr == "isrc":
        return _norm(m.isrc) == _ng(values, "ISRC")
    if attr == "upc":
        return _norm(m.upc) == _ng(values, "UPC") and _norm(m.track_name) == _ng(
            values, "Track Name"
        )
    return (
        _norm(m.track_name) == _ng(values, "Track Name")
        and _norm(m.album_name) == _ng(values, "Album Name")
        and (
            _norm(m.singer) == _ng(values, "Singer")
            or _norm(m.lead_artist) == _ng(values, "Lead Artist")
        )
    )


def _values_to_dict(values: dict) -> dict:
    """A cleaned row projected onto every master column (missing -> "")."""
    return {col: (values.get(col) or "") for col in MASTER_COLUMN_TO_ATTR}


def _differences(m: MasterData, values: dict) -> list[str]:
    """Master columns whose value differs between a stored record and a clean row
    (the serial Record # is positional, not identity, so it's ignored)."""
    diffs = []
    for col, attr in MASTER_COLUMN_TO_ATTR.items():
        if col == "Record #":
            continue
        if _norm(getattr(m, attr)) != _norm(values.get(col)):
            diffs.append(col)
    return diffs


def find_conflicts(db: Session, rows: list) -> list[dict]:
    """Cleaned rows that nearly match an existing master record.

    A conflict is a cleaned row that shares a strong identity anchor with a
    stored record yet differs in at least one field — i.e. neither an exact
    identity match (those dedup silently) nor a brand-new recording. Each
    conflict pairs the cleaned row with its single closest existing record (the
    one differing in the fewest fields) so the reviewer can decide which is
    correct. Candidates are read in a few bulk queries, not one per row.
    """
    keys: dict[str, set[str]] = {"isrc": set(), "upc": set(), "track_name": set()}
    anchored = []
    for r in rows:
        q = _anchor_query(r.values)
        anchored.append((r, q))
        if q:
            attr, val = q
            keys[attr].add(val)

    # attr -> {normalized anchor value: [candidate records]}
    buckets: dict[str, dict[str, list]] = {"isrc": {}, "upc": {}, "track_name": {}}
    for attr, vals in keys.items():
        vals = list(vals)
        if not vals:
            continue
        col = getattr(MasterData, attr)
        for i in range(0, len(vals), _FETCH_CHUNK):
            chunk = vals[i : i + _FETCH_CHUNK]
            for m in db.scalars(select(MasterData).where(func.lower(col).in_(chunk))):
                buckets[attr].setdefault(_norm(getattr(m, attr)), []).append(m)

    conflicts: list[dict] = []
    for r, q in anchored:
        if not q:
            continue
        attr, val = q
        cands = buckets[attr].get(val, [])
        if not cands:
            continue
        fp = fingerprint(r.values)
        exact = False
        best = best_diffs = None
        for m in cands:
            if not _is_same_recording(m, r.values, attr):
                continue
            if m.fingerprint == fp:
                exact = True  # identical recording already stored — not a conflict
                break
            diffs = _differences(m, r.values)
            if diffs and (best_diffs is None or len(diffs) < len(best_diffs)):
                best, best_diffs = m, diffs
        if exact or best is None:
            continue
        conflicts.append(
            {
                "row_index": r.index,
                "master_id": best.id,
                "differences": best_diffs,
                "cleaned": _values_to_dict(r.values),
                "master": record_to_dict(best),
            }
        )
    return conflicts


def record_to_dict(rec: MasterData, columns: list[str] | None = None) -> dict:
    """A master row as {master column name: value}, optionally projected to
    just `columns` — this is how any required field is extracted on demand."""
    cols = columns or list(MASTER_COLUMN_TO_ATTR)
    out = {}
    for col in cols:
        attr = MASTER_COLUMN_TO_ATTR.get(col)
        if attr is not None:
            out[col] = getattr(rec, attr)
    return out
