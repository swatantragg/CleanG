"""Field normalisation: casing, spacing, code formatting, language resolution."""
import re

from .schema import KNOWN_LANGS, LANG_VARIANTS

_NON_ALNUM = re.compile(r"[^a-z0-9]")
_WS = re.compile(r"\s+")
_NON_ALNUM_UP = re.compile(r"[^A-Z0-9]")
_NON_DIGIT = re.compile(r"[^0-9]")


def norm(s) -> str:
    """Lowercase alphanumerics only — used for fuzzy header / value matching."""
    return _NON_ALNUM.sub("", str(s if s is not None else "").lower())


def collapse(s) -> str:
    return _WS.sub(" ", str(s if s is not None else "")).strip()


def title_case(s) -> str:
    return " ".join(w[0].upper() + w[1:] if w else w for w in collapse(s).split(" "))


def is_empty(v) -> bool:
    return v is None or str(v).strip() == ""


def resolve_lang(v) -> str:
    c = norm(v)
    if not c:
        return ""
    if c in LANG_VARIANTS:
        return LANG_VARIANTS[c]
    for k in KNOWN_LANGS:
        if norm(k) == c:
            return k
    return title_case(v)


def fmt_isrc(v) -> str:
    """Pretty-print a 12-char ISRC as CC-XXX-YY-NNNNN, else pass through."""
    c = _NON_ALNUM_UP.sub("", str(v if v is not None else "").upper())
    if len(c) == 12:
        return f"{c[0:2]}-{c[2:5]}-{c[5:7]}-{c[7:]}"
    return str(v if v is not None else "")


def normalize_field(ftype: str, val) -> str:
    if is_empty(val):
        return ""
    if ftype == "name":
        return title_case(val)
    if ftype == "isrc":
        return _NON_ALNUM_UP.sub("", str(val).upper())
    if ftype == "upc":
        return _NON_DIGIT.sub("", str(val))
    if ftype == "lang":
        return resolve_lang(val)
    return collapse(val)
