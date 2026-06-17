"""The data-cleaning engine.

Given rows shaped to the master format, it cleans every cell according to the
field type of its column, and classifies the outcome:

  - ok     : value was already clean and valid
  - fixed  : value was automatically corrected (trimmed, normalized, ...)
  - error  : value could not be auto-fixed and needs a human (carries a `tag`)

A row is "clean" only if it has zero error cells. Rows with one or more errors
go to Human Review, where errors are grouped by `tag` so a whole class of
problems can be fixed together.

Field types and rules are derived from a real analysis of the source data
(music/audio metadata): control-char escapes from Excel, `d-MMM-yy` dates,
ISRC/UPC validation, mm:ss durations, and a few constrained categories.
"""

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass, field

# Excel/openpyxl renders illegal XML chars as _xNNNN_ ; strip them out.
_ESCAPE = re.compile(r"_x[0-9A-Fa-f]{4}_")
_ISRC = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")

# --- field type per master column -----------------------------------------
FIELD_TYPES: dict[str, str] = {
    "Record #": "serial",
    "Label": "category",
    "ISRC": "isrc",
    "Date Submitted": "date",
    "UPC": "upc",
    "Album cat. No.": "code",
    "Album Name": "text",
    "Track Name": "text",
    "Release Date": "date",
    "Singer": "name",
    "Audio Duration (mm:sec)": "duration",
    "Content Type": "category",
    "Vocal / Instrumental": "vocal_instrumental",
    "Language": "language",
    "Genre": "category",
    "Lyricist": "name",
    "Composer": "name",
    "Territory Rights": "category",
    "God Name": "text",
    "Audio folder (path)": "path",
    "JPG folder (path)": "path",
    "LRC File (path)": "path",
    "Lyrical Video (path)": "path",
    "Go Live Date": "date",
    "Revenue Share": "percent",
    "Revenue Split": "text",
    "Distributor": "category",
    "Territory Restriction": "text",
    "Lead Artist": "name",
    "Agreement No.": "code",
}

# Columns that must not be empty (only enforced when the column is mapped).
REQUIRED = {"ISRC", "Track Name"}

# Human-readable labels for error tags (used to group the review queue).
TAG_LABELS = {
    "invalid_isrc": "Invalid ISRC code",
    "invalid_upc": "Invalid UPC / barcode",
    "invalid_date": "Unreadable date",
    "implausible_date": "Out-of-range date",
    "invalid_duration": "Invalid duration",
    "invalid_percent": "Invalid percentage",
    "invalid_category": "Unexpected value",
    "suspect_value": "Doesn't look right",
    "missing_required": "Missing required value",
    "duplicate": "Duplicate record",
}

# Human-readable labels for the *kinds of cleaning* we apply (auto-fixes).
# These let the UI show a breakdown of what was corrected, so accuracy is visible.
FIX_LABELS = {
    "trimmed": "Tidied formatting",
    "removed_junk": "Removed junk value",
    "reformatted_date": "Reformatted date",
    "normalized_duration": "Standardized duration",
    "normalized_isrc": "Standardized ISRC",
    "normalized_upc": "Cleaned barcode",
    "normalized_code": "Standardized code",
    "normalized_path": "Normalized path",
    "standardized_category": "Standardized value",
    "normalized_language": "Standardized language",
    "normalized_percent": "Standardized percentage",
}

# Default fix category per field type (overridden by "removed_junk" when a
# non-empty value was cleared as junk).
_FIX_TAG_BY_TYPE = {
    "isrc": "normalized_isrc",
    "upc": "normalized_upc",
    "date": "reformatted_date",
    "duration": "normalized_duration",
    "vocal_instrumental": "standardized_category",
    "language": "normalized_language",
    "percent": "normalized_percent",
    "code": "normalized_code",
    "path": "normalized_path",
    "text": "trimmed",
    "name": "trimmed",
    "category": "trimmed",
    "serial": "trimmed",
}

# Values that look like data but mean "nothing here": lone punctuation, common
# null tokens, etc. We treat these as blank so a "." never poses as real data.
_PLACEHOLDERS = {
    "n/a", "na", "n.a.", "n.a", "n a", "#n/a", "#na", "null", "none", "nil",
    "nan", "tbd", "tba", "unknown", "unspecified", "not available",
    "not applicable", "xx", "xxx", "xxxx", "--", "---",
}


def _is_placeholder(text: str) -> bool:
    """True when a non-empty string is really a 'no value' placeholder."""
    t = text.strip().lower()
    if not t:
        return False
    if t in _PLACEHOLDERS:
        return True
    # Only punctuation/symbols (".", "-", "—", "***", "?", "...").
    return all(not ch.isalnum() for ch in t)


def _gtin_check_digit_ok(digits: str) -> bool:
    """Validate the GTIN/EAN-13/UPC-A check digit (the last digit)."""
    nums = [int(c) for c in digits]
    body = nums[:-1][::-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(body))
    return (10 - total % 10) % 10 == nums[-1]


# Plausible calendar-date window for this dataset.
_MIN_YEAR = 1950
_MAX_YEAR = dt.date.today().year + 5

_DATE_FORMATS = [
    "%d-%b-%y", "%d-%b-%Y", "%d %b %y", "%d %b %Y",
    "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%d.%m.%Y",
]


# Field types whose only possible "fix" is cosmetic normalization (whitespace,
# unicode, case, slash direction). A change here doesn't mean the data was wrong,
# just tidied — so it shouldn't light up the health map as a real correction.
COSMETIC_TYPES = {"text", "name", "category", "language", "serial", "path"}


@dataclass
class Cell:
    value: str
    action: str  # ok | fixed | error
    tag: str | None = None
    message: str | None = None
    original: str | None = None
    cosmetic: bool = False  # True when a "fixed" was purely cosmetic normalization


@dataclass
class CleanRow:
    index: int
    values: dict[str, str]
    issues: list[dict] = field(default_factory=list)

    @property
    def status(self) -> str:
        return "error" if any(i["action"] == "error" for i in self.issues) else "clean"


# --------------------------------------------------------------------------
# primitive cleaners
# --------------------------------------------------------------------------
def _base_text(value) -> str:
    if value is None:
        return ""
    s = str(value)
    s = _ESCAPE.sub(" ", s)  # drop control-char escapes
    s = "".join(ch for ch in s if ch >= " " or ch == "\t")  # strip control chars
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", " ", s).strip()


def _blank_or_junk(raw: str, base: str) -> Cell | None:
    """Shared front-gate: empty -> ok blank; placeholder junk -> meaningful blank.

    Returns a Cell to short-circuit with, or None to keep processing.
    """
    if base == "":
        return Cell("", "ok", original=raw)
    if _is_placeholder(base):
        # A lone "." / "n/a" etc. is not data — clear it (a real correction).
        return Cell("", "fixed", original=raw)
    return None


def _clean_text(value) -> Cell:
    raw = "" if value is None else str(value)
    cleaned = _base_text(value)
    gate = _blank_or_junk(raw, cleaned)
    if gate:
        return gate
    return Cell(cleaned, "fixed" if cleaned != raw else "ok", original=raw)


def _clean_name(value) -> Cell:
    cell = _clean_text(value)
    # A "name" that is purely a number (or one stray character) isn't a name.
    if cell.value and (cell.value.isdigit() or len(cell.value) == 1):
        return Cell(cell.value, "error", "suspect_value",
                    "This doesn't look like a name.", cell.original)
    return cell


def _clean_path(value) -> Cell:
    raw = "" if value is None else str(value)
    cleaned = _base_text(value).replace("\\", "/")
    gate = _blank_or_junk(raw, cleaned)
    if gate:
        return gate
    return Cell(cleaned, "fixed" if cleaned != raw else "ok", original=raw)


def _clean_code(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    cleaned = base.upper().replace(" ", "")
    return Cell(cleaned, "fixed" if cleaned != raw else "ok", original=raw)


def _clean_isrc(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    s = base.upper().replace("-", "").replace(" ", "")
    if _ISRC.match(s):
        return Cell(s, "fixed" if s != raw else "ok", original=raw)
    return Cell(
        s, "error", "invalid_isrc",
        "Not a valid 12-character ISRC (e.g. INA011900001).", raw,
    )


def _clean_upc(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    digits = re.sub(r"\D", "", base)
    if len(digits) not in (12, 13):
        return Cell(
            digits, "error", "invalid_upc",
            f"UPC/EAN must be 12 or 13 digits (got {len(digits)}).", raw,
        )
    if not _gtin_check_digit_ok(digits):
        return Cell(
            digits, "error", "invalid_upc",
            "Barcode check digit doesn't match — likely a typo.", raw,
        )
    return Cell(digits, "fixed" if digits != raw else "ok", original=raw)


def _finalize_date(d: dt.date, raw: str) -> Cell:
    if not (_MIN_YEAR <= d.year <= _MAX_YEAR):
        return Cell(d.isoformat(), "error", "implausible_date",
                    f"Year {d.year} is outside the expected range "
                    f"({_MIN_YEAR}–{_MAX_YEAR}).", raw)
    iso = d.isoformat()
    return Cell(iso, "fixed" if iso != raw else "ok", original=raw)


def _clean_date(value) -> Cell:
    raw = "" if value is None else str(value)
    if value in (None, ""):
        return Cell("", "ok", original=raw)
    if isinstance(value, (dt.datetime, dt.date)):
        d = value.date() if isinstance(value, dt.datetime) else value
        return _finalize_date(d, raw)

    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate

    # ISO-style strings, including ones carrying a time component such as
    # "2026-01-09 00:00:00" or "2026-01-09T00:00:00" (how Excel datetimes arrive).
    try:
        return _finalize_date(dt.datetime.fromisoformat(base).date(), raw)
    except ValueError:
        pass

    # Drop a trailing midnight time so day/month/year strings still parse.
    candidates = [base]
    if " " in base:
        candidates.append(base.split(" ", 1)[0])
    for candidate in candidates:
        for fmt in _DATE_FORMATS:
            try:
                return _finalize_date(dt.datetime.strptime(candidate, fmt).date(), raw)
            except ValueError:
                continue
    return Cell(base, "error", "invalid_date",
                "Could not understand this date.", raw)


_MAX_DURATION = 10 * 3600  # 10 hours — anything longer is almost certainly wrong


def _clean_duration(value) -> Cell:
    raw = "" if value is None else str(value)
    if value in (None, ""):
        return Cell("", "ok", original=raw)

    bad = Cell(raw, "error", "invalid_duration", "Duration must look like mm:ss.", raw)
    if isinstance(value, dt.time):
        total = value.hour * 3600 + value.minute * 60 + value.second
    else:
        base = _base_text(value)
        gate = _blank_or_junk(raw, base)
        if gate:
            return gate
        parts = base.split(":")
        try:
            nums = [int(p) for p in parts]
        except ValueError:
            return bad
        if any(n < 0 for n in nums):
            return bad
        if len(nums) == 1:           # bare seconds
            total = nums[0]
        elif len(nums) == 2:         # mm:ss
            if nums[1] >= 60:
                return Cell(base, "error", "invalid_duration",
                            "Seconds must be under 60.", raw)
            total = nums[0] * 60 + nums[1]
        elif len(nums) == 3:         # hh:mm:ss
            if nums[1] >= 60 or nums[2] >= 60:
                return Cell(base, "error", "invalid_duration",
                            "Minutes and seconds must be under 60.", raw)
            total = nums[0] * 3600 + nums[1] * 60 + nums[2]
        else:
            return bad

    if total == 0:
        return Cell("00:00", "error", "invalid_duration", "Zero-length duration.", raw)
    if total > _MAX_DURATION:
        return Cell(raw, "error", "invalid_duration", "Duration is implausibly long.", raw)
    mm, ss = divmod(total, 60)
    out = f"{mm:02d}:{ss:02d}"
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


_VOCAL = {"vocal": "Vocal", "vocals": "Vocal", "v": "Vocal",
          "instrumental": "Instrumental", "instru": "Instrumental", "inst": "Instrumental"}


def _clean_vocal(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    key = base.lower()
    if key in _VOCAL:
        out = _VOCAL[key]
        return Cell(out, "fixed" if out != raw else "ok", original=raw)
    return Cell(base, "error", "invalid_category",
                "Must be 'Vocal' or 'Instrumental'.", raw)


# Common ISO/short codes -> full language names (others are simply title-cased).
_LANG_ALIASES = {
    "hin": "Hindi", "tam": "Tamil", "tel": "Telugu", "kan": "Kannada",
    "mal": "Malayalam", "mar": "Marathi", "ben": "Bengali", "guj": "Gujarati",
    "pun": "Punjabi", "pan": "Punjabi", "eng": "English", "san": "Sanskrit",
    "ori": "Odia", "ory": "Odia", "urd": "Urdu", "asm": "Assamese",
}


def _clean_language(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    out = _LANG_ALIASES.get(base.lower(), base.title())
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


def _clean_category(value) -> Cell:
    return _clean_text(value)


def _clean_serial(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    return Cell(base, "fixed" if base != raw else "ok", original=raw)


def _clean_percent(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    s = base.replace("%", "").strip()
    try:
        num = float(s)
    except ValueError:
        return Cell(s, "error", "invalid_percent", "Expected a percentage value.", raw)
    if not (0 <= num <= 100):
        return Cell(f"{num:g}", "error", "invalid_percent",
                    f"Percentage {num:g} is outside 0–100.", raw)
    out = f"{num:g}"
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


_CLEANERS = {
    "text": _clean_text, "name": _clean_name, "path": _clean_path,
    "code": _clean_code, "isrc": _clean_isrc, "upc": _clean_upc,
    "date": _clean_date, "duration": _clean_duration,
    "vocal_instrumental": _clean_vocal, "language": _clean_language,
    "category": _clean_category, "serial": _clean_serial, "percent": _clean_percent,
}


def clean_cell(master_column: str, value) -> Cell:
    ftype = FIELD_TYPES.get(master_column, "text")
    cleaner = _CLEANERS.get(ftype, _clean_text)
    cell = cleaner(value)
    if cell.action == "fixed":
        # Clearing real junk (a non-empty value reduced to blank) is a meaningful
        # correction; whitespace/case/unicode tidy-ups are cosmetic.
        emptied = bool((cell.original or "").strip()) and cell.value == ""
        if ftype in COSMETIC_TYPES:
            cell.cosmetic = not emptied
        # Categorise the fix so the UI can show what kind of cleaning happened.
        if cell.tag is None:
            cell.tag = "removed_junk" if emptied else _FIX_TAG_BY_TYPE.get(ftype, "trimmed")
    return cell


def clean_dataset(
    rows: list[list],
    headers: list[str],
    mapping: list[dict],
) -> list[CleanRow]:
    """Clean every row. `mapping` is the master-centric list (master_column, input_header).

    Cleaning runs on whatever columns are mapped — the master format does NOT need
    to be fully present. Duplicate detection is a separate cross-row pass
    (`mark_duplicates`) so it can run after human corrections are applied.
    """
    header_index = {h: i for i, h in enumerate(headers)}
    # Only the mapped master columns participate in the output.
    active = [m for m in mapping if m.get("input_header")]

    results: list[CleanRow] = []

    for r_idx, row in enumerate(rows):
        values: dict[str, str] = {}
        issues: list[dict] = []
        for m in active:
            master = m["master_column"]
            src = header_index.get(m["input_header"])
            raw = row[src] if src is not None and src < len(row) else None
            cell = clean_cell(master, raw)
            values[master] = cell.value

            if cell.action == "error":
                issues.append(_issue(master, cell))
            elif cell.action == "fixed":
                issues.append(_issue(master, cell))

            # required-field check
            if master in REQUIRED and cell.value == "":
                issues.append({
                    "column": master, "action": "error", "tag": "missing_required",
                    "message": f"{master} is required but empty.",
                    "value": "", "original": cell.original or "",
                })

        results.append(CleanRow(index=r_idx, values=values, issues=issues))

    return results


def mark_duplicates(rows: list[CleanRow]) -> None:
    """Flag rows that repeat an ISRC seen earlier in the dataset (in place).

    Run as a cross-row pass over the *final* values so it stays correct after
    human edits/bulk fixes. The first occurrence of each ISRC is kept clean.
    """
    seen: dict[str, int] = {}
    for r in rows:
        # Drop any stale duplicate flag from a previous pass before re-checking.
        r.issues = [i for i in r.issues if i.get("tag") != "duplicate"]
        isrc_val = r.values.get("ISRC")
        if not isrc_val:
            continue
        if isrc_val in seen:
            r.issues.append({
                "column": "ISRC", "action": "error", "tag": "duplicate",
                "message": f"Duplicate ISRC (also in row {seen[isrc_val] + 1}).",
                "value": isrc_val, "original": isrc_val,
            })
        else:
            seen[isrc_val] = r.index


def revalidate(values: dict[str, str]) -> tuple[dict[str, str], list[dict]]:
    """Re-clean a single record's values (after a human edit or bulk fix).

    Returns the cleaned values and the remaining issues. Duplicate detection is
    file-level and not re-run here.
    """
    cleaned: dict[str, str] = {}
    issues: list[dict] = []
    for master, raw in values.items():
        cell = clean_cell(master, raw)
        cleaned[master] = cell.value
        if cell.action in ("error", "fixed"):
            issues.append(_issue(master, cell))
        if master in REQUIRED and cell.value == "":
            issues.append({
                "column": master, "action": "error", "tag": "missing_required",
                "message": f"{master} is required but empty.",
                "value": "", "original": str(raw),
            })
    return cleaned, issues


def _issue(column: str, cell: Cell) -> dict:
    return {
        "column": column,
        "action": cell.action,
        "tag": cell.tag,
        "message": cell.message,
        "value": cell.value,
        "original": cell.original or "",
        "cosmetic": cell.cosmetic,
    }
