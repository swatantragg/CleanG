"""Auto-mapping engine: match input headers to master columns.

Two independent signals are combined so the matcher rarely needs a human:

  1. Header similarity  - exact / synonym / smart-fuzzy on the column *name*.
  2. Content inference   - what the column's *values* actually look like
                           (ISRC codes, UPC barcodes, dates, mm:ss durations,
                           Vocal/Instrumental, percentages).

When a header is ambiguous or oddly named, the data usually isn't: a column
full of valid ISRCs maps to ISRC even if it's labelled "Code". We score every
(input, master) pair on the blend, then do a greedy one-to-one assignment so
each input feeds at most one master and vice versa — like an analyst lining the
two sheets up, but in milliseconds.
"""

import datetime as dt
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .cleaning import FIELD_TYPES
from .normalize import (
    content_tokens,
    normalize,
    singularize,
    synonym_set,
    synonym_tokens,
    tokenize,
)

# Below this, a fuzzy guess is treated as "no confident match".
FUZZY_THRESHOLD = 0.55
# At/above this we treat a match as high-confidence (else flagged for review).
REVIEW_THRESHOLD = 0.85
# A column whose values match a type at/above this fraction is a strong signal.
CONTENT_MIN = 0.60
# How many sample values to profile per column (plenty to be sure, still fast).
SAMPLE_SIZE = 150


@dataclass
class Suggestion:
    master_column: str
    position: int
    input_header: str | None
    confidence: float
    method: str  # exact | synonym | fuzzy | content | unmatched
    needs_review: bool
    extra_headers: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Content inference: detect what a column's values *are*
# --------------------------------------------------------------------------
_ISRC = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")
_DURATION = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")
_VOCAL_VALUES = {"vocal", "vocals", "v", "instrumental", "instru", "inst"}
_DATE_FORMATS = ("%d-%b-%y", "%d-%b-%Y", "%d %b %Y", "%d/%m/%Y",
                 "%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y", "%d.%m.%Y")


def _is_isrc(v: str) -> bool:
    return bool(_ISRC.match(v.upper().replace("-", "").replace(" ", "")))


def _is_upc(v: str) -> bool:
    s = v.replace(" ", "")
    return s.isdigit() and len(s) in (12, 13)


def _is_duration(v: str) -> bool:
    return bool(_DURATION.match(v))


def _is_vocal(v: str) -> bool:
    return v.lower() in _VOCAL_VALUES


def _is_percent(v: str) -> bool:
    s = v.strip()
    had_sign = s.endswith("%")
    if had_sign:
        s = s[:-1].strip()
    try:
        f = float(s)
    except ValueError:
        return False
    # Avoid grabbing plain integer columns — only a % sign or a decimal counts.
    return 0 <= f <= 100 and (had_sign or "." in s)


def _is_date(v: str) -> bool:
    s = v.strip()
    try:
        dt.datetime.fromisoformat(s)
        return True
    except ValueError:
        pass
    candidate = s.split(" ", 1)[0] if " " in s else s
    for fmt in _DATE_FORMATS:
        try:
            dt.datetime.strptime(candidate, fmt)
            return True
        except ValueError:
            continue
    return False


# Map a master field type -> the detector that recognises its values. Only the
# types where the data is genuinely discriminative are listed here.
_DETECTORS = {
    "isrc": _is_isrc,
    "upc": _is_upc,
    "date": _is_date,
    "duration": _is_duration,
    "vocal_instrumental": _is_vocal,
    "percent": _is_percent,
}


def _profile_column(values: list[str]) -> dict[str, float]:
    """Fraction of (non-empty) sample values matching each detectable type."""
    sample = [str(v).strip() for v in values if v is not None and str(v).strip()]
    sample = sample[:SAMPLE_SIZE]
    if not sample:
        return {}
    return {
        ftype: sum(1 for v in sample if fn(v)) / len(sample)
        for ftype, fn in _DETECTORS.items()
    }


def _column_profiles(
    input_headers: list[str], sample_rows: list[list] | None
) -> list[dict[str, float]]:
    if not sample_rows:
        return [{} for _ in input_headers]
    columns: list[list] = [[] for _ in input_headers]
    for row in sample_rows:
        for i in range(len(input_headers)):
            if i < len(row):
                columns[i].append(row[i])
    return [_profile_column(col) for col in columns]


# --------------------------------------------------------------------------
# Header similarity
# --------------------------------------------------------------------------
def _best_token_ratio(token: str, pool: set[str]) -> float:
    return max((SequenceMatcher(None, token, p).ratio() for p in pool), default=0.0)


def _token_similarity(in_tokens: set[str], pool: set[str]) -> float:
    """How well each input token is explained by the master's token pool."""
    if not in_tokens or not pool:
        return 0.0
    return sum(_best_token_ratio(t, pool) for t in in_tokens) / len(in_tokens)


def _header_score(input_header: str, master_column: str) -> tuple[float, str]:
    n_in = normalize(input_header)
    n_master = normalize(master_column)
    if not n_in:
        return 0.0, "unmatched"
    if n_in == n_master:
        return 1.0, "exact"
    if n_in in synonym_set(master_column):
        return 0.96, "synonym"

    in_tok = content_tokens(input_header)
    master_tok = {singularize(t) for t in tokenize(master_column)}
    # The input name fully contains the master's name (e.g. "Track Name (orig)").
    if master_tok and master_tok <= in_tok:
        return 0.92, "fuzzy"

    pool = synonym_tokens(master_column)
    tok_sim = _token_similarity(in_tok or tokenize(input_header), pool)
    seq = SequenceMatcher(None, n_in, n_master).ratio()
    score = max(tok_sim, 0.55 * tok_sim + 0.45 * seq)
    return round(min(score, 0.94), 3), "fuzzy"


def _pair_score(
    input_header: str, master_column: str, profile: dict[str, float]
) -> tuple[float, str]:
    """Blend header similarity with data-content evidence for one pair."""
    score, method = _header_score(input_header, master_column)

    ftype = FIELD_TYPES.get(master_column)
    cfrac = profile.get(ftype, 0.0) if ftype in _DETECTORS else 0.0
    if cfrac >= CONTENT_MIN:
        # Content confidence floor: 0.90 at the threshold, ~0.98 when near-perfect.
        content_score = 0.80 + 0.18 * cfrac
        if content_score > score:
            # Data drove this match (header was weak) -> label it "content".
            method = "content" if score < 0.90 else method
            score = round(content_score, 3)
    return score, method


def suggest_mapping(
    input_headers: list[str],
    master_columns: list[str],
    sample_rows: list[list] | None = None,
) -> dict:
    """Return a master-centric mapping suggestion.

    `sample_rows` (optional) are extracted data rows aligned to `input_headers`;
    when provided, column contents are profiled and used to confirm/drive matches.
    """
    profiles = _column_profiles(input_headers, sample_rows)

    # Score every (input, master) pair, keeping the best method per pair.
    scored: list[tuple[float, int, int, str]] = []  # score, in_idx, master_idx, method
    for i, ih in enumerate(input_headers):
        for m, mc in enumerate(master_columns):
            score, method = _pair_score(ih, mc, profiles[i])
            if score > 0:
                scored.append((score, i, m, method))

    scored.sort(key=lambda x: x[0], reverse=True)

    assigned: dict[int, tuple[int, float, str]] = {}  # master_idx -> (in_idx, score, method)
    used_inputs: set[int] = set()
    used_masters: set[int] = set()
    for score, i, m, method in scored:
        if i in used_inputs or m in used_masters:
            continue
        if method in ("fuzzy",) and score < FUZZY_THRESHOLD:
            continue
        assigned[m] = (i, score, method)
        used_inputs.add(i)
        used_masters.add(m)

    # Multi-source auto-grouping: leftover input columns that clearly belong to an
    # already-mapped master become *extra* sources for it. This collects numbered
    # variants like "Singer 1 / Singer 2 / Singer 3" -> Singer automatically, so
    # several input columns can be directed into one master column.
    extras: dict[int, list[int]] = {m: [] for m in assigned}
    for score, i, m, method in scored:
        if i in used_inputs or m not in assigned:
            continue
        if score < REVIEW_THRESHOLD:  # only confident extras are auto-grouped
            continue
        extras[m].append(i)
        used_inputs.add(i)

    suggestions: list[Suggestion] = []
    for m, mc in enumerate(master_columns):
        if m in assigned:
            i, score, method = assigned[m]
            suggestions.append(
                Suggestion(
                    master_column=mc,
                    position=m + 1,
                    input_header=input_headers[i],
                    confidence=score,
                    method=method,
                    needs_review=(score < REVIEW_THRESHOLD),
                    extra_headers=[input_headers[j] for j in extras.get(m, [])],
                )
            )
        else:
            suggestions.append(
                Suggestion(
                    master_column=mc,
                    position=m + 1,
                    input_header=None,
                    confidence=0.0,
                    method="unmatched",
                    needs_review=False,
                )
            )

    unused_inputs = [h for i, h in enumerate(input_headers) if i not in used_inputs]
    matched = sum(1 for s in suggestions if s.input_header is not None)
    return {
        "mappings": [s.__dict__ for s in suggestions],
        "unused_inputs": unused_inputs,
        "summary": {
            "master_total": len(master_columns),
            "input_total": len(input_headers),
            "auto_matched": matched,
            "needs_review": sum(1 for s in suggestions if s.needs_review),
            "unmatched_master": len(master_columns) - matched,
        },
    }
