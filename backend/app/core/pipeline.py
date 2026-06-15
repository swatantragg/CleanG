"""The cleaning pipeline: merge mapped sources, normalise, validate, route."""
import secrets

from .normalize import collapse, normalize_field, fmt_isrc, is_empty
from .validation import validate_record


def build_record(raw: dict, fields: list, mapping: dict) -> dict:
    """Merge each master field's mapped source columns and normalise the value."""
    rec = {"_id": secrets.token_hex(4)}
    for f in fields:
        key = f["key"]
        srcs = mapping.get(key) or []
        vals = [raw.get(s) for s in srcs]
        vals = [v for v in vals if not is_empty(v)]
        if key == "singer":
            # Many-to-one merge: distinct, joined with " & ".
            seen = []
            for v in vals:
                c = collapse(v)
                if c not in seen:
                    seen.append(c)
            merged = " & ".join(seen)
        else:
            merged = vals[0] if vals else ""
        rec[key] = normalize_field(f.get("type", "text"), merged)
    rec["isrcDisplay"] = fmt_isrc(rec.get("isrc"))
    return rec


def clean_rows(raw_rows: list, fields: list, mapping: dict):
    """Return (clean, review). Review rows carry their `issues`."""
    clean, review = [], []
    for raw in raw_rows:
        rec = build_record(raw, fields, mapping)
        issues = validate_record(rec)
        if issues:
            rec = dict(rec)
            rec["issues"] = issues
            review.append(rec)
        else:
            clean.append(rec)
    return clean, review
