"""Serialise master rows to a CSV string for the chosen export columns."""
import re

_NEEDS_QUOTE = re.compile(r'[",\n]')


def _escape(v: str) -> str:
    v = ("" if v is None else str(v)).replace('"', '""')
    return f'"{v}"' if _NEEDS_QUOTE.search(v) else v


def build_csv(master: list, cols: list, fields: list) -> str:
    use_cols = cols if cols else ["isrc"]
    label = {f["key"]: f.get("label", f["key"]) for f in fields}

    lines = [",".join(_escape(label.get(k, k)) for k in use_cols)]
    for r in master:
        row = []
        for k in use_cols:
            if k == "isrc":
                v = r.get("isrcDisplay") or r.get("isrc")
            else:
                v = r.get(k, "")
            row.append(_escape(v))
        lines.append(",".join(row))
    return "\n".join(lines)
