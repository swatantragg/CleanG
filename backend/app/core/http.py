"""HTTP response helpers."""

import re
from urllib.parse import quote

# Anything that isn't a safe filename char (or could break out of the header).
# Parentheses are allowed so a caller-supplied descriptor like
# "Demo(manually_edited_singers)" survives intact.
_UNSAFE = re.compile(r'[^A-Za-z0-9._ ()-]+')


def safe_filename(name: str, fallback: str = "download.xlsx") -> str:
    """A filename safe to drop into a Content-Disposition header.

    Strips CR/LF (header-injection / response-splitting vectors) and any
    character outside a conservative allowlist, collapses the result, and falls
    back to a default if nothing usable remains.
    """
    name = _UNSAFE.sub("_", name.replace("\r", " ").replace("\n", " ")).strip(" .")
    return name[:120] or fallback


def content_disposition(filename: str, fallback: str = "download.xlsx") -> str:
    """Build an `attachment` Content-Disposition value with a sanitized ASCII
    filename plus an RFC 5987 UTF-8 fallback."""
    safe = safe_filename(filename, fallback)
    return f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(safe)}"
