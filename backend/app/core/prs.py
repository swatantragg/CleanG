"""PRS "List of works" consolidation.

A PRS work report arrives with one row per interested party, so the same work
(Tune Code / WORKKEY) repeats once per composer, author and publisher. This
module collapses it to **one row per work**: work-level fields are written once,
and every interested party is expanded *horizontally* into numbered, role-based
column blocks (Composer 1…n, Author 1…n, Publisher 1…n, …).

Everything is derived from the data, nothing is hardcoded:
  - the work key is whichever identifier the file actually carries,
  - party columns are recognised by header, the rest are work-level (and are
    verified constant per work — a varying column is demoted to the party block
    rather than silently collapsed),
  - the number of columns per role comes from a full scan of the dataset
    (max occurrences of that role group in any single work).

Role routing: a role code containing "C" (C, CA, AC, CP, CAP, …) is a composer
and lands in the Composer block only — never duplicated under Author — while the
original role value is preserved in that party's Role column.

Ownership is allocated dynamically: a work is always 100%, split 25% composer /
25% author / 50% publisher, and each pool is divided equally between the parties
holding that role. A combined role (CA) draws from both writer pools. The result
is written to Performance Share, and a work that cannot allocate a pool (no
publisher, say) keeps the shares it can and names the gap in a trailing Issue
column instead of having the missing percentage redistributed.

Two output shapes:
  FULL — every mapped party field (Name, Role, IPI, ICE Agreement Number,
         Performance/Mechanical Society + Share, Claim Status, UA Flag, CAR).
  CORE — Name, Role, IPI Number, Performance Society, Performance Share.
Both carry identical work-level columns.

Field transforms follow the mapping schema: "LASTNAME, FIRSTNAME" -> "Firstname
Lastname", "052:PRS" -> "PRS", durations to HH:MM:SS, dates to DD-MM-YYYY.
Every other field is passed through unchanged.

IPRS "work listing" exports are accepted too: banner rows above the header are
skipped, a two-row header ("PER SHARES" over "OWN % / COLLECT %") is merged,
work fields printed only on a work's first row are carried down to its party
rows, and summary rows ("NO. OF WORKS : 413") are dropped — after which the file
goes through exactly the same consolidation as a PRS report.
"""

import datetime as dt
import io
import re

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .standardize import StandardizeError, load_grid, split_header

# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------
# Work identifier, in order of preference — the first one present is used.
# INTERNAL_NO is the IPRS work number of an IPRS "work listing" export.
KEY_CANDIDATES = ["ALLIANCE_TUNECODE", "WORKKEY", "INPUT_KEY", "INTERNAL_NO"]

# Interested-party columns: source header -> output label.
PARTY_FIELDS: dict[str, str] = {
    "NAME": "Name",
    "ROLE_CLASS": "Role",
    "IPI_NO": "IPI Number",
    "ICEAGRNUMBER": "ICE Agreement Number",
    "PERF_SOCIETY": "Performance Society",
    "PERF": "Performance Share",
    "MECH_SOCIETY": "Mechanical Society",
    "MECH": "Mechanical Share",
    "CLAIM_STATUS": "Claim Status",
    "UA_FLAG": "UA Flag",
    "CAR": "CAR",
}
FULL_FIELDS = [
    "NAME", "ROLE_CLASS", "IPI_NO", "ICEAGRNUMBER", "PERF_SOCIETY", "PERF",
    "MECH_SOCIETY", "MECH", "CLAIM_STATUS", "UA_FLAG", "CAR",
]
CORE_FIELDS = ["NAME", "ROLE_CLASS", "IPI_NO", "PERF_SOCIETY", "PERF"]
VARIANTS = {"full": FULL_FIELDS, "core": CORE_FIELDS}

ROLE_COLUMN = "ROLE_CLASS"

# Other societies' spelling of the same party fields (IPRS work listing:
# ROLE / SOCIETY / "PER SHARES" + "OWN %" ...). Keyed by normalized header; an
# alias only applies when the file doesn't also carry the canonical column.
HEADER_ALIASES: dict[str, str] = {
    "ROLE": "ROLE_CLASS",
    "SOCIETY": "PERF_SOCIETY",
    "PERSHARESOWN": "PERF",
    "MECSHARESOWN": "MECH",
}

# How far down a report the header row is searched for (banner rows above it,
# e.g. the IPRS listing's member name / IPI block, are skipped).
HEADER_SCAN_ROWS = 30

# Ownership: a work is always 100%, divided into these role pools. Each pool is
# split equally between the parties that hold it in that work, so the numbers
# come from the data (1 composer -> 25, 2 -> 12.5, 4 -> 6.25) and nothing is
# hardcoded to a party count.
SHARE_POOLS = {"C": 25.0, "A": 25.0, "E": 50.0}
POOL_ORDER = ["C", "A", "E"]
POOL_LABEL = {"C": "Composer", "A": "Author", "E": "Publisher"}
SHARE_COLUMN = "PERF"          # the allocated share is written here
ISSUE_COLUMN = "Issue"         # trailing validation column (blank when 100% allocated)

# Role-group labels and the order their blocks appear in.
GROUP_LABEL = {
    "C": "Composer", "A": "Author", "AR": "Arranger", "AD": "Adaptor",
    "TR": "Translator", "E": "Publisher", "SE": "Sub Publisher",
    "SA": "Sub Author", "PA": "Publisher Administrator",
}
GROUP_ORDER = ["C", "A", "AR", "AD", "TR", "E", "SE", "SA", "PA"]

# Value transforms (schema "Changes in Data type" column).
SOCIETY_COLUMNS = {"PERF_SOCIETY", "MECH_SOCIETY", "DOC_OWNER"}   # 052:PRS -> PRS
DATE_COLUMNS = {"PUBL_DATE"}                                      # -> DD-MM-YYYY
DIST_REF_COLUMNS = {"LAST_DIST_REF_MECH", "LAST_DIST_REF_PERF"}   # YYYYMM<seq> -> DD-MM-YYYY
DURATION_COLUMNS = {"DURATION"}                                   # -> HH:MM:SS
NAME_COLUMNS = {"NAME"}                                           # LAST, FIRST -> First Last

PREVIEW_ROWS = 20


class PrsError(Exception):
    """Raised when an upload isn't a usable PRS work report."""

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


# --------------------------------------------------------------------------
# Field-level transforms
# --------------------------------------------------------------------------
def fix_name(value: str) -> str:
    """"GULATI, UTTAM SINGH" -> "Uttam Singh Gulati".

    Names without a comma (companies, mononyms) are passed through untouched.
    """
    s = (value or "").strip()
    if "," not in s:
        return s
    last, first = s.split(",", 1)
    last, first = last.strip(), first.strip()
    if not first or not last:
        return (first or last).title()
    return f"{first} {last}".title()


def fix_society(value: str) -> str:
    """"052:PRS" -> "PRS" (everything before the colon is dropped)."""
    s = (value or "").strip()
    return s.split(":", 1)[1].strip() if ":" in s else s


def _parse_datetime(s: str):
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d-%m-%Y",
                "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def fix_date(value: str) -> str:
    """Any recognisable date -> DD-MM-YYYY."""
    s = (value or "").strip()
    if not s:
        return ""
    parsed = _parse_datetime(s)
    return parsed.strftime("%d-%m-%Y") if parsed else s


def fix_dist_ref(value: str) -> str:
    """PRS distribution reference YYYYMM<seq> -> DD-MM-YYYY.

    "2026071" -> 01-07-2026. An alphabetic sequence marker ("202601A") counts as
    day 01, per the mapping schema.
    """
    s = re.sub(r"\.0$", "", (value or "").strip())
    if not s:
        return ""
    m = re.fullmatch(r"(\d{4})(\d{2})(.?)", s)
    if not m:
        return fix_date(s)
    year, month, seq = m.groups()
    day = int(seq) if seq.isdigit() and int(seq) > 0 else 1
    return f"{day:02d}-{month}-{year}"


def fix_duration(value: str) -> str:
    """Durations to HH:MM:SS."""
    s = (value or "").strip()
    if not s:
        return ""
    m = re.fullmatch(r"(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.\d+)?", s)
    if m:
        return "%02d:%02d:%02d" % tuple(int(x) for x in m.groups())
    m = re.fullmatch(r"(\d{1,2}):(\d{1,2})", s)
    if m:
        return "00:%02d:%02d" % tuple(int(x) for x in m.groups())
    if s.isdigit():                       # plain seconds
        total = int(s)
        return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return s


def transform_cell(column: str, value) -> str:
    """Apply the schema transform for one column.

    Columns the schema marks "Same as Given" pass through byte for byte — not
    even whitespace is touched — so nothing is altered that wasn't asked for.
    """
    s = "" if value is None else str(value)
    if column in NAME_COLUMNS:
        return fix_name(s)
    if column in SOCIETY_COLUMNS:
        return fix_society(s)
    if column in DATE_COLUMNS:
        return fix_date(s)
    if column in DIST_REF_COLUMNS:
        return fix_dist_ref(s)
    if column in DURATION_COLUMNS:
        return fix_duration(s)
    return s


def role_group(role: str) -> str:
    """The column block a role code belongs to.

    Any role containing "C" is a composer (C, CA, AC, CP, CAP, …) and goes to the
    Composer block only. Everything else keeps its own block. The party's own
    Role value is never rewritten.
    """
    code = (role or "").strip().upper()
    if not code:
        return "UNSPECIFIED"
    return "C" if "C" in code else code


def share_pools(role: str) -> set[str]:
    """The ownership pools a role code draws from.

    A combined writer code (CA, AC, CAP, …) draws from the composer *and* the
    author pool, so a party who is both holds 25% + 25% — while still being
    placed in the Composer block. Roles outside the three pools (arranger,
    sub-publisher, income participant, …) own no part of the 100%.
    """
    code = (role or "").strip().upper()
    group = role_group(code)
    if group == "C":
        return {"C", "A"} if "A" in code else {"C"}
    if group in ("A", "E"):
        return {group}
    return set()


def allocate_shares(parties: list[dict], role_col: str) -> tuple[list[float], list[str]]:
    """Split 25 / 25 / 50 across one work's interested parties.

    Returns the share per party (same order as `parties`) and the pools nothing
    could be allocated to. A missing pool is never redistributed — the parties
    that are present keep exactly what their own pool entitles them to.

    A pool that doesn't divide evenly (3 composers -> 8.3333…) is rounded to 4
    decimals with the remainder going to the last holder, so the pool still adds
    up to exactly its 25 / 50. An evenly divisible pool gives every holder the
    identical share.
    """
    holders = {
        pool: [i for i, p in enumerate(parties) if pool in share_pools(p[role_col])]
        for pool in POOL_ORDER
    }
    shares = [0.0] * len(parties)
    for pool, members in holders.items():
        if not members:
            continue
        total = SHARE_POOLS[pool]
        each = round(total / len(members), 4)
        for i in members[:-1]:
            shares[i] += each
        shares[members[-1]] += round(total - each * (len(members) - 1), 4)
    return shares, [pool for pool in POOL_ORDER if not holders[pool]]


def format_share(value: float) -> str:
    """25.0 -> "25", 12.5 -> "12.5", 25/3 -> "8.3333" (trailing zeros dropped)."""
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def issue_message(missing: list[str]) -> str:
    """"Composer share not allocated", "Composer and Publisher share not
    allocated" — blank when the full 100% was assigned."""
    if not missing:
        return ""
    names = [POOL_LABEL[p] for p in missing]
    joined = names[0] if len(names) == 1 else " and ".join([", ".join(names[:-1]), names[-1]])
    return f"{joined} share not allocated"


def group_label(group: str) -> str:
    """A role code we don't have a name for keeps its own code as the block
    label, so an unseen role still gets its own columns."""
    if group == "UNSPECIFIED":
        return "Unspecified Role"
    return GROUP_LABEL.get(group, group)


# --------------------------------------------------------------------------
# Consolidation
# --------------------------------------------------------------------------
def _norm_header(h: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(h or "").upper())


_KNOWN_COLUMNS = list(PARTY_FIELDS) + sorted(
    SOCIETY_COLUMNS | DATE_COLUMNS | DIST_REF_COLUMNS | DURATION_COLUMNS
)


def canonical_names(headers: list[str]) -> dict[str, str]:
    """Canonical name per source header, so transforms/labels work whatever the
    file's exact spelling is. An exact match wins over an alias, and each
    canonical name is claimed by one header only."""
    known = {_norm_header(c): c for c in _KNOWN_COLUMNS}
    canon = {h: known.get(_norm_header(h), h) for h in headers}
    taken = set(canon.values())
    for h in headers:
        target = HEADER_ALIASES.get(_norm_header(h))
        if canon[h] == h and target and target not in taken:
            canon[h] = target
            taken.add(target)
    return canon


def find_key(headers: list[str]) -> str | None:
    lookup = {_norm_header(h): h for h in headers}
    return next((lookup[_norm_header(k)] for k in KEY_CANDIDATES if _norm_header(k) in lookup), None)


def analyze(headers: list[str], rows: list[list], layout: list[str] | None = None) -> dict:
    """Read the report, apply the transforms and work out the layout.

    Returns everything both variants need: the transformed party records grouped
    by work, the work-level columns, and the per-role column budget.
    """
    key = find_key(headers)
    if key is None:
        raise PrsError(
            "No work identifier found. The report needs an ALLIANCE_TUNECODE, "
            "WORKKEY or INPUT_KEY column (or INTERNAL NO in an IPRS work listing)."
        )
    canon = canonical_names(headers)
    role_col = next((h for h in headers if canon[h] == ROLE_COLUMN), None)
    if role_col is None:
        raise PrsError("No ROLE_CLASS (or ROLE) column found — interested-party roles are required.")

    party_cols = [h for h in headers if canon[h] in PARTY_FIELDS]
    work_cols = [h for h in headers if h not in party_cols]
    idx = {h: i for i, h in enumerate(headers)}

    # Transform every cell once, then drop exact duplicate records (only those).
    records, seen = [], set()
    duplicates = 0
    for row in rows:
        rec = {h: transform_cell(canon[h], row[idx[h]] if idx[h] < len(row) else "") for h in headers}
        rec[key] = rec[key].strip()       # the grouping key is matched trimmed
        if not rec[key]:
            continue                      # a row with no work identifier isn't a work record
        fingerprint = tuple(rec[h] for h in headers)
        if fingerprint in seen:
            duplicates += 1
            continue
        seen.add(fingerprint)
        records.append(rec)
    if not records:
        raise PrsError("No usable rows: every row is missing a work identifier.")

    # Group by work, preserving both work order and party order from the file.
    works: dict[str, list[dict]] = {}
    for rec in records:
        works.setdefault(rec[key], []).append(rec)

    # A "work-level" column that varies inside a work is really party data —
    # move it into the party block instead of losing the other values.
    demoted = []
    for col in list(work_cols):
        for parties in works.values():
            if len({p[col] for p in parties}) > 1:
                demoted.append(col)
                break
    if demoted:
        work_cols = [c for c in work_cols if c not in demoted]
        party_cols = party_cols + demoted

    # Column budget: the largest number of parties any single work has per group.
    max_per_group: dict[str, int] = {}
    for parties in works.values():
        counts: dict[str, int] = {}
        for p in parties:
            g = role_group(p[role_col])
            counts[g] = counts.get(g, 0) + 1
        for g, n in counts.items():
            max_per_group[g] = max(max_per_group.get(g, 0), n)
    groups = ([g for g in GROUP_ORDER if g in max_per_group]
              + sorted(g for g in max_per_group if g not in GROUP_ORDER))

    # Ownership allocation, per work: the calculated share overwrites Performance
    # Share, and any pool with no holder is reported in the Issue column rather
    # than being shared out among the roles that are present.
    share_col = next((h for h in headers if canon[h] == SHARE_COLUMN), None)
    issues: dict[str, str] = {}
    for work_key, parties in works.items():
        shares, missing = allocate_shares(parties, role_col)
        if share_col is not None:
            for party, share in zip(parties, shares):
                party[share_col] = format_share(share)
        issues[work_key] = issue_message(missing)

    return {
        "key": key,
        "role_col": role_col,
        "canon": canon,
        "headers": headers,
        "work_cols": work_cols,
        "party_cols": party_cols,
        "demoted": demoted,
        "works": works,
        "groups": groups,
        "max_per_group": max_per_group,
        "total_parties": len(records),
        "duplicates": duplicates,
        "share_column": share_col,
        "issues": issues,
        "layout": layout or [],
    }


def _fields_for(info: dict, variant: str) -> list[str]:
    """The party columns of this variant, in output order, restricted to what the
    file actually has. FULL also carries any demoted (varying) extra column."""
    canon, party_cols = info["canon"], info["party_cols"]
    by_canon = {canon[h]: h for h in party_cols}
    wanted = VARIANTS[variant]
    fields = [by_canon[c] for c in wanted if c in by_canon]
    if variant == "full":
        fields += [h for h in info["demoted"] if h not in fields]
    return fields


def field_label(info: dict, source: str) -> str:
    return PARTY_FIELDS.get(info["canon"][source], str(source))


def build(info: dict, variant: str) -> dict:
    """Pivot to one row per work for a variant. Returns columns + row dicts."""
    key, role_col = info["key"], info["role_col"]
    work_cols, groups, budget = info["work_cols"], info["groups"], info["max_per_group"]
    fields = _fields_for(info, variant)

    def slot(group: str, i: int, source: str) -> str:
        return f"{group_label(group)} {i + 1} {field_label(info, source)}"

    slots = [slot(g, i, f) for g in groups for i in range(budget[g]) for f in fields]
    columns = work_cols + slots + [ISSUE_COLUMN]
    out_rows, expected = [], []
    for work_key, parties in info["works"].items():
        row = {c: parties[0][c] for c in work_cols}
        row[ISSUE_COLUMN] = info["issues"].get(work_key, "")
        for g in groups:
            members = [p for p in parties if role_group(p[role_col]) == g]
            for i in range(budget[g]):
                party = members[i] if i < len(members) else None
                for f in fields:
                    row[slot(g, i, f)] = party[f] if party is not None else ""
                if party is not None:
                    expected.append(tuple([party[c] for c in work_cols] + [party[f] for f in fields]))
        out_rows.append(row)

    return {
        "columns": columns,
        "work_columns": work_cols,
        "party_columns": slots,
        "rows": out_rows,
        "fields": fields,
        "expected": expected,
        "slot": slot,
    }


def validate(info: dict, built: dict, variant: str) -> list[dict]:
    """Re-derive the long form from the wide rows and prove nothing moved."""
    key, role_col = info["key"], info["role_col"]
    work_cols, groups, budget = info["work_cols"], info["groups"], info["max_per_group"]
    fields, slot = built["fields"], built["slot"]

    # A slot is occupied when any of its fields carries a value — never keyed off
    # one field, so a party with (say) a blank role is still seen.
    rebuilt = []
    for row in built["rows"]:
        for g in groups:
            for i in range(budget[g]):
                values = [row[slot(g, i, f)] for f in fields]
                if not any(v != "" for v in values):
                    continue
                rebuilt.append(tuple([row[c] for c in work_cols] + values))
    # Parties whose every kept field is empty leave no trace to compare against
    # (they can only happen in the reduced variant); count them separately.
    n_work = len(work_cols)
    visible = [t for t in built["expected"] if any(v != "" for v in t[n_work:])]
    invisible = len(built["expected"]) - len(visible)
    identical = rebuilt == visible

    checks: list[dict] = []

    def add(check: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": check, "ok": bool(ok), "detail": detail})

    if info.get("layout"):
        add("Work-listing layout recognised", True, "; ".join(info["layout"]))
    n_works = len(info["works"])
    keys = [r[key] for r in built["rows"]]
    add("Every unique work appears exactly once",
        len(keys) == n_works == len(set(keys)),
        f"{len(keys)} rows / {n_works} unique {key}")
    add("Every interested party present exactly once",
        len(rebuilt) + invisible == info["total_parties"],
        f"{len(rebuilt) + invisible} of {info['total_parties']} source party records"
        + (f" ({invisible} carry no value in the fields this variant keeps)" if invisible else ""))
    add("Party fields round-trip exactly", identical,
        "wide rows unpivoted and compared cell by cell")
    add("Party order preserved", identical, "ordered comparison, no sorting applied")
    add("No party assigned to the wrong work", identical,
        "the work key travels with every unpivoted party row")
    add("Work-level data written once per work", True,
        f"{len(work_cols)} work columns, each verified constant within its work")
    add("Exact duplicate records removed", True,
        f"{info['duplicates']} dropped" if info["duplicates"] else "none found")
    add("Names rearranged (LAST, FIRST -> First Last)", True,
        "comma-less company names left untouched")
    add("Society codes stripped of their numeric prefix", True, "052:PRS -> PRS")
    add("Party fields included", True,
        ", ".join(field_label(info, f) for f in fields))

    # Ownership allocation.
    flagged = [k for k, message in info["issues"].items() if message]
    add("Ownership split 25 / 25 / 50 by role", True,
        "composer 25%, author 25%, publisher 50% — each pool divided equally "
        "between its parties, combined roles (CA) drawing from both writer pools")
    if info["share_column"] is not None:
        add("Calculated share written to Performance Share", True,
            f"column {info['share_column']}")
    else:
        add("Calculated share written to Performance Share", False,
            f"the report has no {SHARE_COLUMN} column, so the allocation could not be written")
    add("Full 100% ownership allocated in every work", not flagged,
        f"all {n_works} works fully allocated" if not flagged
        else f"{len(flagged)} of {n_works} works are missing a role — named in the "
             f"{ISSUE_COLUMN} column, remaining percentage left unallocated")
    combined = sorted({p[role_col] for parties in info["works"].values() for p in parties
                       if role_group(p[role_col]) == "C" and p[role_col].strip().upper() != "C"})
    if combined:
        add("Combined composer roles routed to the Composer block", True,
            f"{', '.join(combined)} — original Role value kept")
    if info["demoted"]:
        add("Columns that vary within a work moved to the party block",
            variant == "full", ", ".join(info["demoted"]))
    return checks


def group_summary(info: dict) -> list[dict]:
    role_col = info["role_col"]
    per_group: dict[str, list] = {}
    for parties in info["works"].values():
        for p in parties:
            per_group.setdefault(role_group(p[role_col]), []).append(p[role_col])
    return [
        {
            "group": group_label(g),
            "roles": sorted({r for r in per_group.get(g, []) if r}),
            "columns": info["max_per_group"][g],
            "parties": len(per_group.get(g, [])),
        }
        for g in info["groups"]
    ]


# --------------------------------------------------------------------------
# Workbook output
# --------------------------------------------------------------------------
_INT = re.compile(r"-?\d+")
_FLOAT = re.compile(r"-?\d*\.\d+")


def _typed(value: str):
    """Write numbers as numbers so shares and IPI numbers stay usable in Excel,
    while codes with leading zeros stay text."""
    s = str(value or "")
    if not s or (len(s) > 1 and s[0] == "0" and s[1] != "."):
        return s
    if _INT.fullmatch(s):
        return int(s)
    if _FLOAT.fullmatch(s):
        return float(s)
    return s


_PALETTE = ["FCE4D6", "E2EFDA", "FFF2CC", "E4DFEC", "DDEBF7", "FBE5D6"]


def to_workbook(info: dict, built: dict, checks: list[dict]) -> bytes:
    """The consolidated sheet plus a Validation sheet, as .xlsx bytes."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Consolidated"

    columns = built["columns"]
    ws.append(columns)
    for row in built["rows"]:
        ws.append([_typed(row.get(c, "")) for c in columns])

    fields, slot = built["fields"], built["slot"]
    column_group = {slot(g, i, f): g
                    for g in info["groups"] for i in range(info["max_per_group"][g]) for f in fields}
    fills = {g: PatternFill("solid", fgColor=_PALETTE[i % len(_PALETTE)])
             for i, g in enumerate(info["groups"])}
    work_fill = PatternFill("solid", fgColor="D9D9D9")
    issue_fill = PatternFill("solid", fgColor="FFC7CE")
    for j, name in enumerate(columns, 1):
        cell = ws.cell(1, j)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.fill = (issue_fill if name == ISSUE_COLUMN
                     else fills.get(column_group.get(name), work_fill))
        ws.column_dimensions[get_column_letter(j)].width = (
            38 if name == ISSUE_COLUMN else min(max(12, len(str(name)) + 2), 30)
        )
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    vs = wb.create_sheet("Validation")
    vs.append(["Check", "Result", "Detail"])
    for c in checks:
        vs.append([c["check"], "PASS" if c["ok"] else "FAIL", c["detail"]])
    vs.append([])
    vs.append(["Column Group", "Source Role Codes", "Columns created", "Parties"])
    header_rows = {1, vs.max_row}
    for g in group_summary(info):
        vs.append([g["group"], ", ".join(g["roles"]), g["columns"], g["parties"]])
    for r in header_rows:
        for cell in vs[r]:
            cell.font = Font(bold=True)
    for col, width in zip("ABCD", (52, 12, 62, 18)):
        vs.column_dimensions[col].width = width

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------
# Locating the table (plain PRS report or IPRS-style work listing)
# --------------------------------------------------------------------------
def _is_header_row(cells: list[str]) -> bool:
    """A row naming both a work identifier and a role column."""
    names = [str(c).strip() for c in cells if str(c).strip()]
    canon = canonical_names(names)
    return find_key(names) is not None and ROLE_COLUMN in canon.values()


def _merge_header(top: list[str], sub: list[str]) -> list[str]:
    """Two-row header -> one: a sub-label is prefixed with the group label above
    it (or to its left, for a group spanning several columns), so "PER SHARES"
    over "OWN %" / "COLLECT %" becomes "PER SHARES OWN %" / "PER SHARES COLLECT %"."""
    width = max(len(top), len(sub))
    top = list(top) + [""] * (width - len(top))
    sub = list(sub) + [""] * (width - len(sub))
    merged, group = [], ""
    for t, s in zip(top, sub):
        t, s = t.strip(), s.strip()
        if t:
            group = t
        merged.append(" ".join(f"{group} {s}".split()) if s and group else (t or s))
    return merged


def _unique_headers(headers: list[str]) -> list[str]:
    out, seen = [], {}
    for j, h in enumerate(headers):
        h = " ".join(h.split()) or f"Column {get_column_letter(j + 1)}"
        seen[h] = seen.get(h, 0) + 1
        out.append(h if seen[h] == 1 else f"{h} ({seen[h]})")
    return out


def locate_table(grid: list[list[str]]) -> tuple[list[str], list[list], list[str]]:
    """Find the header row and reshape the body into one record per party.

    A plain PRS export (header on the first row, key on every row) takes the
    usual path untouched. Anything else is read as a work listing:
      - banner rows above the header are skipped,
      - a sub-header row directly below it is merged in,
      - work-level columns (blank on every continuation row in the whole file)
        are carried down from a work's first row to its other party rows,
      - rows with no party (summary lines such as "NO. OF WORKS : 413") dropped.
    Returns (headers, rows, layout notes for the validation sheet).
    """
    def plain() -> tuple[list[str], list[list], list[str]]:
        try:
            headers, rows = split_header(grid)
        except StandardizeError as exc:
            raise PrsError(exc.message) from exc
        return headers, rows, []

    start = next((i for i, r in enumerate(grid[:HEADER_SCAN_ROWS]) if _is_header_row(r)), None)
    if start is None:
        return plain()

    def cell(row: list[str], j: int | None) -> str:
        return str(row[j]).strip() if j is not None and j < len(row) else ""

    def locate(header: list[str]) -> tuple[int, int, int | None]:
        canon = canonical_names(header)
        name = next((j for j, h in enumerate(header) if canon[h] == "NAME"), None)
        role = next(j for j, h in enumerate(header) if canon[h] == ROLE_COLUMN)
        return header.index(find_key(header)), role, name

    header = [str(c) for c in grid[start]]
    body = grid[start + 1:]
    key_j, role_j, name_j = locate(header)

    # Sub-header: no key / role / name, no numbers, and at least one label sitting
    # under a blank top cell (the tail of a spanning group such as "PER SHARES").
    sub = [str(c).strip() for c in body[0]] if body else []
    two_row = bool(sub) and not any(cell(sub, j) for j in (key_j, role_j, name_j)) and not any(
        _INT.fullmatch(v) or _FLOAT.fullmatch(v) for v in sub if v
    ) and any(v and not cell(header, j) for j, v in enumerate(sub))
    blocks = any(not cell(r, key_j) and (cell(r, role_j) or cell(r, name_j))
                 for r in body[1 if two_row else 0:])
    if start == 0 and not two_row and not blocks:
        return plain()

    notes: list[str] = []
    if start:
        notes.append(f"{start} banner row{'s' if start != 1 else ''} above the header skipped")
    if two_row:
        header, body = _merge_header(header, sub), body[1:]
        notes.append("two-row header merged")

    width = max([len(header)] + [len(r) for r in body])
    header = header + [""] * (width - len(header))
    body = [list(r) + [""] * (width - len(r)) for r in body]
    # Columns with neither a header nor any data are dropped; a data column with
    # no header gets a positional name.
    keep = [j for j in range(width) if header[j].strip() or any(str(r[j]).strip() for r in body)]
    headers = _unique_headers([header[j] for j in keep])
    body = [[r[j] for j in keep] for r in body]
    if not blocks:
        return headers, body, notes

    key_j, role_j, name_j = locate(headers)

    # Wrapped text: the export spills a long value onto an extra row holding only
    # the overflow ("ZEE ENTERTAINMENT" / "ENTERPRISES LIMITED"). Such a row has no
    # key, no role and no numbers — rejoin it to the row above, cell by cell.
    joined, wrapped = [], 0
    for r in body:
        texts = [str(v).strip() for v in r]
        if joined and not cell(r, key_j) and not cell(r, role_j) and not any(
            _INT.fullmatch(v) or _FLOAT.fullmatch(v) for v in texts if v
        ):
            prev = joined[-1]
            for j, v in enumerate(texts):
                if v:
                    prev[j] = f"{str(prev[j]).rstrip()} {v}" if str(prev[j]).strip() else v
            wrapped += 1
            continue
        joined.append(list(r))
    body = joined
    if wrapped:
        notes.append(f"{wrapped} wrapped-text row{'s' if wrapped != 1 else ''} rejoined to the row above")

    def has_party(row: list[str]) -> bool:
        return bool(cell(row, role_j) or cell(row, name_j))

    continuation = [r for r in body if not cell(r, key_j) and has_party(r)]
    canon = canonical_names(headers)
    carried = [j for j, h in enumerate(headers)
               if canon[h] not in PARTY_FIELDS and not any(cell(r, j) for r in continuation)]
    rows, current, filled, dropped = [], None, 0, 0
    for r in body:
        if cell(r, key_j):
            current = r
        elif current is not None and has_party(r):
            r = list(r)
            for j in carried:
                r[j] = current[j]
            filled += 1
        if not (has_party(r) and cell(r, key_j)):
            dropped += 1                     # summary / orphan line, not a party
            continue
        rows.append(r)
    notes.append(f"work fields carried down to {filled} party rows "
                 f"({', '.join(headers[j] for j in carried)})")
    if dropped:
        notes.append(f"{dropped} row{'s' if dropped != 1 else ''} without an interested party skipped")
    return headers, rows, notes


def prepare(filename: str, data: bytes) -> dict:
    """Parse + transform an upload and work out its layout (one pass, reusable
    by both variants)."""
    try:
        grid = load_grid(filename, data)
    except StandardizeError as exc:
        raise PrsError(exc.message) from exc
    headers, rows, layout = locate_table(grid)
    if not rows:
        raise PrsError("The file has headers but no data rows.")
    return analyze(headers, rows, layout)


def consolidate(info: dict, variant: str) -> dict:
    """Pivot + validate one variant of a prepared report."""
    if variant not in VARIANTS:
        raise PrsError(f"Unknown variant {variant!r}. Use 'full' or 'core'.")
    built = build(info, variant)
    return {"built": built, "checks": validate(info, built, variant)}
