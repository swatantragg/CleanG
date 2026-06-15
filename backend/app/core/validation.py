"""Record validation + dedup key. A row needs zero issues to auto-clean."""
import re

from .schema import BUILTINS, KNOWN_LANGS
from .normalize import norm, is_empty

_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")
_UPC_RE = re.compile(r"^[0-9]{12,13}$")


def field_issue(key: str, ftype: str, val):
    if is_empty(val):
        return {"field": key, "type": "missing", "msg": "Missing required value"}
    sval = str(val)
    if ftype == "isrc" and not _ISRC_RE.match(sval):
        return {"field": key, "type": "mismatch", "msg": "Not a valid 12-char ISRC"}
    if ftype == "upc" and not _UPC_RE.match(sval):
        return {"field": key, "type": "mismatch", "msg": "UPC must be 12-13 digits"}
    if ftype == "lang" and sval not in KNOWN_LANGS:
        return {"field": key, "type": "mismatch", "msg": "Unrecognised language"}
    return None


def validate_record(rec: dict) -> list:
    out = []
    for f in BUILTINS:
        issue = field_issue(f["key"], f["type"], rec.get(f["key"]))
        if issue:
            out.append(issue)
    return out


def dedup_key(rec: dict) -> str:
    """Identity key for dedup: prefer ISRC, fall back to UPC + singer."""
    isrc = rec.get("isrc") or ""
    if isrc.strip():
        return "isrc:" + re.sub(r"[^A-Z0-9]", "", isrc.upper())
    return "uk:" + norm(rec.get("upc")) + "|" + norm(rec.get("singer"))
