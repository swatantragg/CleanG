"""Extraction presets — fixed master-column sets exported per downstream system."""

PRESETS = {
    "PDL": ["isrc", "upc", "singer", "composer", "publisher", "label", "lyricist", "language"],
    "SVF": ["isrc", "upc", "singer", "label", "language"],
    "Custom": [],
}
