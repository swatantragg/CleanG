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

# Delimiter used when several names / source columns are merged into one field.
NAME_SEP = " | "
# Split an input name cell into individual names. Names are joined by a pipe, a
# comma, an ampersand, or the word "and" (any case) — e.g. "Vishal & Shekhar",
# "A and B", "A, B" all split. The "and" arm requires surrounding whitespace so
# it never breaks a name that merely contains the letters (e.g. "Anderson").
# Only applied to name-type fields (Singer / Composer / Lyricist / Lead Artist).
_NAME_SPLIT = re.compile(r"\s*[|,&]\s*|\s+and\s+", re.IGNORECASE)
# Split an already-cleaned, pipe-joined name cell back into its individual names.
_PIPE_SPLIT = re.compile(r"\s*\|\s*")
# In a Label cell, several labels can be joined by a comma, an "&", or the word
# "and"/"And" (any case) — normalize those joiners to a pipe so multi-label cells
# read uniformly ("Global Music Junction, I Believe Music" -> "... | ..."). The
# "and" arm requires surrounding whitespace so it never breaks a value that merely
# contains the letters (e.g. "Brand"). Label-only.
_LABEL_JOIN = re.compile(r"\s*[,&]\s*|\s+and\s+", re.IGNORECASE)

# Lead Artist is a roll-up of the creative/performing credits. It's filled from
# these columns, in this priority order — any names already in Lead Artist are
# kept, then the rest are added from Singer / Composer / Lyricist. A person
# credited in more than one role (e.g. singer AND composer) appears only once.
LEAD_ARTIST_SOURCES = ("Lead Artist", "Singer", "Composer", "Lyricist")

# Field types that hold one-or-more human names (people). These get per-name
# Title-casing, comma/pipe splitting and name-shape validation.
NAME_TYPES = {"name"}
# Field types that hold a single proper title (album / track). Title-cased and
# shape-checked, but NOT split on commas (a title may legitimately contain one).
TITLE_TYPES = {"title"}

# Symbols that should never appear in a real name or title -> human review.
# (Apostrophe, hyphen, period, parentheses, ampersand and comma are allowed.)
_SUSPECT_CHARS = set("$%@#^*=+~<>{}[]\\\"`")

# --- field type per master column -----------------------------------------
FIELD_TYPES: dict[str, str] = {
    "Record #": "serial",
    "Label": "label",
    "ISRC": "isrc",
    "Date Submitted": "date",
    "UPC": "upc",
    "Album cat. No.": "code",
    "Album Name": "title",
    "Track Name": "title",
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
    "Revenue Share": "text",
    "Revenue Split": "percent",
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
    "garbled_value": "Corrupted / unreadable value",
    "duplicate": "Duplicate record",
    "possible_duplicate": "Possible duplicate — needs review",
    "upc_album_mismatch": "UPC ↔ Album mismatch",
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
    "titlecased": "Standardized name casing",
    "combined_columns": "Merged from multiple columns",
    "derived_lead_artist": "Filled Lead Artist",
    "filled_constant": "Filled blank cell",
    "corrected": "Manually corrected",
    "merged": "Merged value",
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
    "name": "titlecased",
    "title": "titlecased",
    "category": "trimmed",
    "serial": "trimmed",
    "label": "standardized_category",
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


def _is_garbled(raw: str) -> bool:
    """True for control-escape / mojibake blobs like "`$/`$>`$0 `$`%".

    Tested against the *raw* cell (before normalization strips the markers).
    """
    if not raw:
        return False
    if _ESCAPE.search(raw):              # leftover _xNNNN_ control escapes
        return True
    if raw.count("$") >= 2:              # repeated $ markers
        return True
    if "`" in raw and "$" in raw:        # backtick + dollar combos
        return True
    return False


def _titlecase(text: str) -> str:
    """Standardize casing to 'Demo Name' form (per-word capitalization).

    str.title() handles word boundaries around spaces, hyphens and apostrophes
    (e.g. "JOHN o'brien-smith" -> "John O'Brien-Smith").
    """
    return text.title()


def _name_problem(name: str) -> tuple[str, str] | None:
    """Return (tag, message) if a single name/title looks wrong, else None.

    Flags suspect symbols ($, %, ...), all-caps single words (DEMO), and mangled
    casing such as camelCase smash-ups (DemoName) or initials run together (DName).
    """
    if any(ch in _SUSPECT_CHARS for ch in name):
        return ("suspect_value", "Contains unexpected symbols — please check.")
    tokens = name.split()
    if not tokens:
        return None
    # A single token with irregular casing is almost always bad data.
    if len(tokens) == 1:
        t = tokens[0]
        letters = [c for c in t if c.isalpha()]
        if len(letters) >= 2 and all(c.isupper() for c in letters):
            return ("suspect_value", "All-caps single word — confirm the real name.")
    for t in tokens:
        # lower->Upper ("DemoName") or RUN-together capitals + lower ("DName").
        if re.search(r"[a-z][A-Z]", t) or re.search(r"[A-Z]{2,}[a-z]", t):
            return ("suspect_value", "Unusual capitalization — confirm the real name.")
    return None


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
COSMETIC_TYPES = {"text", "category", "language", "serial", "path"}


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
    """Clean a person-name field that may hold one or many names.

    Multiple names in one cell (separated by comma or pipe) are split, each is
    Title-cased and shape-checked, then re-joined with ' | '. Any name that looks
    wrong (suspect symbols, mangled casing, garbled blob, bare number) flags the
    whole cell for review.
    """
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    if _is_garbled(raw):
        return Cell(base, "error", "garbled_value",
                    "This value looks corrupted — please check.", raw)

    names: list[str] = []
    problem: tuple[str, str] | None = None
    for part in _NAME_SPLIT.split(base):
        part = part.strip()
        if not part:
            continue
        names.append(_titlecase(part))
        # Shape-check the ORIGINAL casing (Title-casing would hide DemoName/DEMO).
        if problem is None:
            if part.isdigit() or len(part) == 1:
                problem = ("suspect_value", "This doesn't look like a name.")
            else:
                problem = _name_problem(part)

    out = NAME_SEP.join(dict.fromkeys(names))  # de-dupe, keep order
    if problem:
        return Cell(out, "error", problem[0], problem[1], raw)
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


def _clean_title(value) -> Cell:
    """Clean an album / track title: Title-case, flag suspect symbols / casing.

    Unlike names, titles are NOT split on commas (a title may contain one).
    """
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    if _is_garbled(raw):
        return Cell(base, "error", "garbled_value",
                    "This value looks corrupted — please check.", raw)
    # Shape-check the ORIGINAL casing before Title-casing hides it.
    problem = _name_problem(base)
    fixed = _titlecase(base)
    if problem:
        return Cell(fixed, "error", problem[0], problem[1], raw)
    return Cell(fixed, "fixed" if fixed != raw else "ok", original=raw)


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
    # Rule: an ISRC must be exactly 12 characters. Anything else -> human review.
    if len(s) != 12:
        return Cell(
            s, "error", "invalid_isrc",
            f"ISRC must be exactly 12 characters (got {len(s)}).", raw,
        )
    if not _ISRC.match(s):
        return Cell(
            s, "error", "invalid_isrc",
            "Not a valid ISRC format (e.g. INA011900001).", raw,
        )
    return Cell(s, "fixed" if s != raw else "ok", original=raw)


def _clean_upc(value) -> Cell:
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    digits = re.sub(r"\D", "", base)
    # Rule: a UPC/EAN must be 12 or 13 digits. Anything else -> human review.
    if len(digits) not in (12, 13):
        return Cell(
            digits, "error", "invalid_upc",
            f"UPC/EAN must be 12 or 13 digits (got {len(digits)}).", raw,
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

    bad = Cell(raw, "error", "invalid_duration",
               "Duration must look like hh:mm:ss.", raw)
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
        return Cell("00:00:00", "error", "invalid_duration", "Zero-length duration.", raw)
    if total > _MAX_DURATION:
        return Cell(raw, "error", "invalid_duration", "Duration is implausibly long.", raw)
    hh, rem = divmod(total, 3600)
    mm, ss = divmod(rem, 60)
    out = f"{hh:02d}:{mm:02d}:{ss:02d}"  # standardized hh:mm:ss
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


def _clean_label(value) -> Cell:
    """Clean a record-label cell; same as category but joins multi-label cells
    on a pipe — any ",", "&", "and" or "And" between labels becomes " | ".

    Splitting (rather than a plain substitution) drops the empty pieces a stray
    or trailing joiner leaves behind, so "A, & B," yields "A | B", never "A |  | B |".
    """
    raw = "" if value is None else str(value)
    base = _base_text(value)
    gate = _blank_or_junk(raw, base)
    if gate:
        return gate
    parts = [p.strip() for p in _LABEL_JOIN.split(base) if p.strip()]
    out = " | ".join(parts)
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


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
    # Revenue Split is multi-party: "60% | 40%". Validate each share, keep order.
    parts = [p.strip() for p in base.split("|") if p.strip()]
    cleaned: list[str] = []
    for part in parts:
        s = part.replace("%", "").strip()
        try:
            num = float(s)
        except ValueError:
            return Cell(s, "error", "invalid_percent",
                        "Expected a percentage value.", raw)
        if not (0 <= num <= 100):
            return Cell(f"{num:g}", "error", "invalid_percent",
                        f"Percentage {num:g} is outside 0–100.", raw)
        cleaned.append(f"{num:g}")
    out = " | ".join(cleaned)
    return Cell(out, "fixed" if out != raw else "ok", original=raw)


_CLEANERS = {
    "text": _clean_text, "name": _clean_name, "title": _clean_title,
    "path": _clean_path, "code": _clean_code, "isrc": _clean_isrc, "upc": _clean_upc,
    "date": _clean_date, "duration": _clean_duration,
    "vocal_instrumental": _clean_vocal, "language": _clean_language,
    "category": _clean_category, "serial": _clean_serial, "percent": _clean_percent,
    "label": _clean_label,
}


def clean_cell(master_column: str, value) -> Cell:
    ftype = FIELD_TYPES.get(master_column, "text")
    cleaner = _CLEANERS.get(ftype, _clean_text)
    cell = cleaner(value)
    # Universal safety net: any field whose raw value is a corrupted control-char
    # blob ("`$/`$>`$0 `$`%") goes to human review, whatever its type.
    if cell.action != "error":
        raw = "" if value is None else str(value)
        if _is_garbled(raw):
            return Cell(cell.value, "error", "garbled_value",
                        "This value looks corrupted — please check.", raw)
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


def clean_value(master_column: str, raws: list) -> Cell:
    """Clean one master cell that may be fed by several input columns.

    Each source is cleaned independently, then merged into a single pipe-separated
    value (e.g. Singer 1 / Singer 2 / Singer 3 -> "A | B | C"). The merged cell is
    an error if ANY source errored; the worst error's tag/message is surfaced.
    """
    cells = [clean_cell(master_column, r) for r in raws]
    nonblank = [c for c in cells if c.value != ""]
    if len(cells) <= 1:
        return cells[0] if cells else Cell("", "ok", original="")
    if len(nonblank) <= 1:
        # Effectively single-valued — return that cell (or a clean blank).
        return nonblank[0] if nonblank else Cell("", "ok", original="")

    # Merge the individual values, splitting any that are themselves multi-name,
    # then de-duplicating while preserving order.
    parts: list[str] = []
    for c in nonblank:
        for piece in c.value.split(NAME_SEP):
            piece = piece.strip()
            if piece and piece not in parts:
                parts.append(piece)
    merged = NAME_SEP.join(parts)
    original = NAME_SEP.join(str(r) for r in raws if r not in (None, ""))

    err = next((c for c in cells if c.action == "error"), None)
    if err is not None:
        return Cell(merged, "error", err.tag, err.message, original)
    return Cell(merged, "fixed", tag="combined_columns", original=original)


def derive_lead_artist(values: dict) -> str:
    """Build the Lead Artist roll-up: the unique union of Lead Artist (existing),
    Singer, Composer and Lyricist, in that priority order.

    Each source is already pipe-joined and Title-cased by the cleaner, so we split
    on the pipe and de-duplicate case-insensitively while preserving first-seen
    order and casing. A name that appears in several roles is therefore written
    once (Singer == Composer -> one entry)."""
    out: list[str] = []
    seen: set[str] = set()
    for col in LEAD_ARTIST_SOURCES:
        for piece in _PIPE_SPLIT.split(values.get(col) or ""):
            piece = piece.strip()
            if not piece:
                continue
            key = piece.lower()
            if key not in seen:
                seen.add(key)
                out.append(piece)
    return NAME_SEP.join(out)


def _apply_lead_artist(values: dict, issues: list[dict]) -> None:
    """Fill / verify the Lead Artist column in place from its source credits.

    - If Lead Artist already holds names, they're kept and the missing ones are
      added (never dropped) — a true verify-and-fill.
    - No-op when nothing contributes and there's no Lead Artist column at all.
    - Skipped while Lead Artist itself carries a hard error (the human resolves it
      first). The fill is recorded as an auto-fix so the grid shows what happened.
    """
    if any(i["column"] == "Lead Artist" and i["action"] == "error" for i in issues):
        return
    derived = derive_lead_artist(values)
    if not derived and "Lead Artist" not in values:
        return
    prev = values.get("Lead Artist", "")
    if derived == prev:
        return  # already complete — leave any existing issue untouched
    values["Lead Artist"] = derived
    # Replace any prior auto-fix note for this column with the roll-up note.
    issues[:] = [
        i for i in issues
        if not (i["column"] == "Lead Artist" and i["action"] == "fixed")
    ]
    issues.append({
        "column": "Lead Artist",
        "action": "fixed",
        "tag": "derived_lead_artist",
        "message": "Filled from Singer / Composer / Lyricist (duplicates removed).",
        "value": derived,
        "original": prev,
        "cosmetic": False,
    })


def _apply_constants(
    values: dict, issues: list[dict], constants: dict[str, str]
) -> None:
    """Broadcast per-column constant values into EMPTY cells only.

    A column with a constant gets that value wherever the row's cell is blank; a
    cell that already holds anything is left completely untouched. The constant is
    run through the column's normal cleaner (so e.g. a "50|50" Revenue Split is
    standardized like any other value) and recorded as an auto-fill so the grid
    shows where it landed."""
    for col, raw in (constants or {}).items():
        if values.get(col):
            continue  # never overwrite an existing value
        cell = clean_cell(col, raw)
        values[col] = cell.value
        if cell.action == "error":
            issues.append(_issue(col, cell))
        elif cell.value != "":
            issues.append({
                "column": col,
                "action": "fixed",
                "tag": "filled_constant",
                "message": "Filled this blank cell with the column value you set.",
                "value": cell.value,
                "original": "",
                "cosmetic": False,
            })


def clean_dataset(
    rows: list[list],
    headers: list[str],
    mapping: list[dict],
    constants: dict[str, str] | None = None,
) -> list[CleanRow]:
    """Clean every row. `mapping` is the master-centric list (master_column, input_header).

    Cleaning runs on whatever columns are mapped — the master format does NOT need
    to be fully present. `constants` fills empty cells of named columns with a
    fixed value (existing values untouched). Duplicate detection is a separate
    cross-row pass (`mark_duplicates`) so it can run after human corrections.
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
            # Gather every input column feeding this master (primary + extras).
            sources = [m["input_header"], *(m.get("extra_headers") or [])]
            raws = []
            for h in sources:
                src = header_index.get(h)
                raws.append(row[src] if src is not None and src < len(row) else None)
            cell = clean_value(master, raws)
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

        # Broadcast any whole-column constants into this row's empty cells...
        _apply_constants(values, issues, constants or {})
        # ...then roll the credits up into Lead Artist (so a constant-filled
        # credit also feeds the roll-up).
        _apply_lead_artist(values, issues)

        results.append(CleanRow(index=r_idx, values=values, issues=issues))

    return results


# Identity fields compared when judging whether two rows are the same record.
# Only those actually present in the mapped output participate; duration, genre
# and any other column are intentionally ignored.
#
# ISRC is the unique key of a *recording* (a song): two rows with different ISRCs
# are different songs and are never duplicates — even when they share a UPC, which
# is the *album/release* barcode that every track on an album has in common.
DEDUP_FIELDS = [
    "ISRC", "UPC", "Label", "Album Name", "Track Name", "Singer", "Composer",
    "Lyricist", "Publisher", "Music Producer", "Language",
]


def _dedup_norm(v: str | None) -> str:
    return re.sub(r"\s+", " ", (v or "").strip()).lower()


def _has_real_error(r: CleanRow) -> bool:
    """A genuine cleaning error (not a duplicate flag) — explains a field mismatch."""
    return any(
        i["action"] == "error"
        and i.get("tag") not in ("duplicate", "possible_duplicate")
        for i in r.issues
    )


def mark_duplicates(rows: list[CleanRow]) -> None:
    """Flag duplicate / possible-duplicate records (in place), keyed on ISRC.

    The ISRC uniquely identifies a recording, so de-duplication groups rows by
    ISRC. Different ISRC -> different song -> never a duplicate (this is why two
    tracks of the same album, which share a UPC but have different ISRCs and song
    names, are NOT flagged). Within one ISRC:

      * EXACT duplicate    — every compared identity field is identical -> tagged
        `duplicate`; the first occurrence is kept, the rest excluded from master.
      * POSSIBLE duplicate — same ISRC (same recording) but some metadata differs
        -> tagged `possible_duplicate`, listing the colliding row(s) and which
        fields differ, so a human can compare and confirm.

    Rows with a blank ISRC are skipped here (they already carry a missing-required
    error). Runs over the *final* values so it stays correct after human edits.
    """
    # Drop any stale cross-row flags from a previous pass.
    _cross = ("duplicate", "possible_duplicate", "upc_album_mismatch")
    for r in rows:
        r.issues = [i for i in r.issues if i.get("tag") not in _cross]

    # Only the identity fields that are actually mapped take part.
    fields = [f for f in DEDUP_FIELDS if any(f in r.values for r in rows)]
    is_exact: set[int] = set()

    if "ISRC" in fields:  # without ISRC we can't tell same song from same album
        def sig(r: CleanRow) -> tuple[str, ...]:
            return tuple(_dedup_norm(r.values.get(f)) for f in fields)

        # Group rows by their (normalized) ISRC — the recording's unique key.
        by_isrc: dict[str, list[CleanRow]] = {}
        for r in rows:
            isrc = _dedup_norm(r.values.get("ISRC"))
            if isrc:
                by_isrc.setdefault(isrc, []).append(r)

        for group in by_isrc.values():
            if len(group) < 2:
                continue  # unique ISRC -> a distinct song, nothing to flag

            # Exact duplicates: identical across every compared field. Keep the
            # first occurrence; tag the later identical rows for removal.
            first_for_sig: dict[tuple[str, ...], int] = {}
            for r in group:
                s = sig(r)
                if s in first_for_sig:
                    is_exact.add(r.index)
                    r.issues.append({
                        "column": "ISRC", "action": "error", "tag": "duplicate",
                        "message": f"Exact duplicate of row {first_for_sig[s] + 1}.",
                        "value": "", "original": "",
                    })
                else:
                    first_for_sig[s] = r.index

            # No metadata conflict (all rows identical) -> only exact dups, done.
            if len(first_for_sig) < 2:
                continue

            # Same ISRC but the rows disagree on some field(s): a possible dup.
            # List the distinct (non-exact) rows as each other's collision
            # partners, and report exactly which identity fields differ.
            reps = [r for r in group if r.index not in is_exact]
            differing = [
                f for f in fields
                if len({_dedup_norm(r.values.get(f)) for r in reps}) > 1
            ]
            for r in reps:
                # A real cleaning error already sends this row to review and
                # explains the mismatch -> don't pile on a duplicate flag.
                if _has_real_error(r):
                    continue
                partners = [o.index + 1 for o in reps if o is not r]
                r.issues.append({
                    "column": "ISRC", "action": "error", "tag": "possible_duplicate",
                    "message": (
                        f"Same ISRC as row {', '.join(map(str, partners))} but "
                        f"{', '.join(differing)} differ{'s' if len(differing) == 1 else ''}. "
                        f"Compare and confirm it isn't a duplicate."
                    ),
                    "value": r.values.get("ISRC", ""),
                    "original": "",
                    "related_rows": partners,
                })

    # UPC <-> Album Name must agree: one album/release has exactly one barcode.
    # Same UPC with different Album Names (or same Album with different UPCs) is a
    # data inconsistency a human should resolve.
    if "UPC" in fields and "Album Name" in fields:
        _flag_field_conflict(rows, "UPC", "Album Name", is_exact,
                             "shares UPC but the Album Name differs")
        _flag_field_conflict(rows, "Album Name", "UPC", is_exact,
                             "shares Album Name but the UPC differs")


def _flag_field_conflict(
    rows: list[CleanRow], key: str, other: str, skip: set[int], reason: str
) -> None:
    """Flag rows where `key` matches across rows but `other` disagrees.

    Used for the UPC<->Album rule: a shared UPC must carry one Album Name (and a
    shared Album Name one UPC). Conflicts are tagged `upc_album_mismatch`.
    """
    groups: dict[str, list[CleanRow]] = {}
    for r in rows:
        if r.index in skip:
            continue
        k = _dedup_norm(r.values.get(key))
        ov = _dedup_norm(r.values.get(other))
        if k and ov:  # both sides must be present to compare
            groups.setdefault(k, []).append(r)

    for group in groups.values():
        if len({_dedup_norm(r.values.get(other)) for r in group}) < 2:
            continue  # the `other` value is consistent -> fine
        for r in group:
            if _has_real_error(r):
                continue
            if any(
                i.get("tag") == "upc_album_mismatch" and i.get("column") == other
                for i in r.issues
            ):
                continue
            partners = [p.index + 1 for p in group if p is not r]
            r.issues.append({
                "column": other, "action": "error", "tag": "upc_album_mismatch",
                "message": (
                    f"Row {', '.join(map(str, partners))} {reason} "
                    f"(got “{r.values.get(other, '')}”). Please reconcile."
                ),
                "value": r.values.get(other, ""),
                "original": "",
                "related_rows": partners,
            })


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
    # Re-derive Lead Artist so an edit to Singer/Composer/Lyricist reflows into it.
    _apply_lead_artist(cleaned, issues)
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
