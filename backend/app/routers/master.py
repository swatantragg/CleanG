"""Shared master store: dedup-checked writes, reads, extraction, plus the
concurrent-cleaning layer (row claiming + optimistic version + change log)."""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user, require_roles
from ..models import MasterRecord, DedupEntry, ChangeLog, User, UserRole, RecordStatus, SourceFormat
from ..schemas import UploadIn, ApproveIn, ExtractIn, SaveIn
from ..core.normalize import fmt_isrc
from ..core.validation import validate_record, dedup_key
from ..core.presets import PRESETS
from ..core.csv_export import build_csv

router = APIRouter(prefix="/master", tags=["master"])


# ---------- helpers ----------
def _now():
    return datetime.now(timezone.utc)


def _lock_active(rec: MasterRecord) -> bool:
    """A lock counts only if held and not older than the configured TTL."""
    if not rec.locked_by or not rec.locked_at:
        return False
    locked_at = rec.locked_at
    if locked_at.tzinfo is None:
        locked_at = locked_at.replace(tzinfo=timezone.utc)
    return _now() - locked_at < timedelta(minutes=settings.LOCK_TTL_MINUTES)


def _serialize(rec: MasterRecord) -> dict:
    """Shape a record for the frontend: data fields + concurrency metadata."""
    data = dict(rec.data or {})
    data.update({
        "record_id": str(rec.id),
        "_src": "review" if rec.status == RecordStatus.verified else "clean",
        "status": rec.status.value,
        "source_format": rec.source_format.value if rec.source_format else None,
        "version": rec.version,
        "assigned_to": str(rec.assigned_to) if rec.assigned_to else None,
        "locked_by": str(rec.locked_by) if (rec.locked_by and _lock_active(rec)) else None,
    })
    return data


def _master_list(db: Session):
    rows = db.query(MasterRecord).order_by(MasterRecord.created_at, MasterRecord.id).all()
    return [_serialize(r) for r in rows]


def _dedup_list(db: Session):
    rows = db.query(DedupEntry).order_by(DedupEntry.created_at, DedupEntry.id).all()
    return [{"singer": d.singer, "isrc": d.isrc, "key": d.match_key} for d in rows]


def _coerce_source(value):
    if not value:
        return None
    try:
        return SourceFormat(value)
    except ValueError:
        return None


def _write(db: Session, user: User, records: list, status: RecordStatus, source_format):
    """Insert records whose dedup key is new; log skipped duplicates."""
    seen = {k for (k,) in db.query(MasterRecord.dedup_key).all() if k}
    added = dups = 0
    for r in records:
        rec = dict(r)
        rec["isrcDisplay"] = fmt_isrc(rec.get("isrc"))
        rec.pop("issues", None)
        key = dedup_key(rec)
        if key in seen:
            dups += 1
            db.add(DedupEntry(
                triggered_by=user.id,
                singer=rec.get("singer", ""),
                isrc=rec.get("isrcDisplay") or rec.get("isrc", ""),
                match_key=key,
            ))
            continue
        seen.add(key)
        db.add(MasterRecord(
            data=rec,
            dedup_key=key,
            status=status,
            source_format=source_format,
            created_by=user.id,
            updated_by=user.id,
        ))
        added += 1
    db.commit()
    return added, dups


def _get_record(db: Session, record_id: uuid.UUID) -> MasterRecord:
    rec = db.query(MasterRecord).filter(MasterRecord.id == record_id).first()
    if rec is None:
        raise HTTPException(404, "Record not found")
    return rec


# ---------- reads / bulk writes ----------
@router.get("")
def get_master(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return {"master": _master_list(db), "dedupLog": _dedup_list(db)}


@router.post("/upload")
def upload(body: UploadIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    valid, moved = [], []
    for r in body.records:
        rec = dict(r)
        rec["isrcDisplay"] = fmt_isrc(rec.get("isrc"))
        issues = validate_record(rec)
        if issues:
            moved.append({**rec, "issues": issues})
        else:
            valid.append(rec)
    added, dups = _write(db, user, valid, RecordStatus.cleaned, _coerce_source(body.source_format))
    return {
        "added": added, "dups": dups, "moved": moved,
        "master": _master_list(db), "dedupLog": _dedup_list(db),
    }


@router.post("/approve")
def approve(body: ApproveIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = dict(body.record)
    rec["isrcDisplay"] = fmt_isrc(rec.get("isrc"))
    if validate_record(rec):
        raise HTTPException(400, "Record still has unresolved issues")
    added, dups = _write(db, user, [rec], RecordStatus.verified, _coerce_source(rec.get("source_format")))
    return {
        "added": added, "dups": dups,
        "master": _master_list(db), "dedupLog": _dedup_list(db),
    }


@router.delete("")
def reset(db: Session = Depends(get_db), _: User = Depends(require_roles(UserRole.admin))):
    db.query(ChangeLog).delete()
    db.query(MasterRecord).delete()
    db.query(DedupEntry).delete()
    db.commit()
    return {"master": [], "dedupLog": []}


@router.post("/extract")
def extract(body: ExtractIn, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    preset_cols = PRESETS.get(body.preset, [])
    cols = list(preset_cols) + [e for e in body.extra if e not in preset_cols]
    master = _master_list(db)
    return {
        "csv": build_csv(master, cols, body.fields),
        "filename": f"MRM_{body.preset}_export.csv",
        "cols": cols, "count": len(master),
    }


# ---------- concurrent cleaning ----------
@router.post("/{record_id}/claim")
def claim(record_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = _get_record(db, record_id)
    if _lock_active(rec) and rec.locked_by != user.id:
        raise HTTPException(409, "Row is currently locked by another user")
    rec.locked_by = user.id
    rec.locked_at = _now()
    if rec.assigned_to is None:
        rec.assigned_to = user.id
    if rec.status == RecordStatus.raw:
        rec.status = RecordStatus.in_progress
    rec.updated_by = user.id
    db.commit()
    db.refresh(rec)
    return _serialize(rec)


@router.post("/{record_id}/release")
def release(record_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = _get_record(db, record_id)
    if rec.locked_by and rec.locked_by != user.id and user.role != UserRole.admin:
        raise HTTPException(409, "Lock is held by another user")
    rec.locked_by = None
    rec.locked_at = None
    db.commit()
    db.refresh(rec)
    return _serialize(rec)


@router.patch("/{record_id}")
def save(record_id: uuid.UUID, body: SaveIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rec = _get_record(db, record_id)

    # Layer 1 — row claiming: someone else holds an active lock.
    if _lock_active(rec) and rec.locked_by != user.id:
        raise HTTPException(409, "Row is locked by another user")

    # Layer 2 — optimistic concurrency: reject stale writes.
    if body.version != rec.version:
        raise HTTPException(409, {
            "message": "Record changed since you loaded it — reload and retry",
            "currentVersion": rec.version,
        })

    data = dict(rec.data or {})
    changed = False
    for field, new_value in body.changes.items():
        old_value = data.get(field)
        if (old_value or "") == (new_value or ""):
            continue
        data[field] = new_value
        db.add(ChangeLog(
            record_id=rec.id,
            user_id=user.id,
            field_name=field,
            old_value=None if old_value is None else str(old_value),
            new_value=None if new_value is None else str(new_value),
        ))
        changed = True

    if changed:
        if "isrc" in body.changes:
            data["isrcDisplay"] = fmt_isrc(data.get("isrc"))
        rec.data = data
        rec.version += 1
        rec.updated_by = user.id
        rec.updated_at = _now()

    if body.status:
        try:
            rec.status = RecordStatus(body.status)
        except ValueError:
            raise HTTPException(400, "Invalid status")

    db.commit()
    db.refresh(rec)
    return _serialize(rec)


@router.get("/{record_id}/history")
def history(record_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = (
        db.query(ChangeLog)
        .filter(ChangeLog.record_id == record_id)
        .order_by(ChangeLog.changed_at)
        .all()
    )
    return [{
        "field": c.field_name,
        "old": c.old_value,
        "new": c.new_value,
        "userId": str(c.user_id),
        "changedAt": c.changed_at.isoformat(),
    } for c in rows]
