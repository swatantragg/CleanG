"""Application configuration: cleansing presets, output columns, field mapping,
canonical G-artist reference. These are business rules, not sample data."""

MAX_BYTES = 20 * 1024 * 1024

COLUMNS = [
    "Record #", "ISRC", "Album Name", "Track Name", "Release Date", "Singer",
    "Language", "Genre", "Lyricist", "Composer", "Label", "Go Live Date",
]

PRESETS = {
    "Metadata (PDL)": {
        "tag": "Music",
        "desc": "Standard PDL music-catalog metadata.",
        "columns": ["Album Name", "Track Name", "Release Date", "Singer", "Language", "Genre", "Lyricist", "Composer", "Label", "Go Live Date"],
        "rules": ["Split multi-value Artist / Composer / Lyricist into N columns", "Normalize all dates → YYYY-MM-DD", "Lead Artist = all contributors, pipe-joined", "Dedup on ISRC + UPC + Album Name"],
    },
    "Music Rights Catalog": {
        "tag": "Rights",
        "desc": "Ownership, splits & territory.",
        "columns": ["Track Name", "Composer", "Lyricist", "Publisher", "Territory", "Royalty Split %"],
        "rules": ["Validate ISRC checksum", "Normalize ownership % to total 100", "Flag missing territory rights", "Concatenate writer share rows"],
    },
    "Artist Master Data": {
        "tag": "Artist",
        "desc": "De-duplicated talent master.",
        "columns": ["Artist Name", "Aliases", "Primary Role", "Track Count", "Primary Genre"],
        "rules": ["Merge spelling variants → canonical name", "Roll up alias list", "Count tracks per artist", "Match against the G-Artist list"],
    },
    "Video Metadata": {
        "tag": "Video",
        "desc": "Music-video & visual assets.",
        "columns": ["Title", "Director", "Duration", "Resolution", "Release Date", "Language"],
        "rules": ["Normalize duration → HH:MM:SS", "Standardize resolution labels", "Validate file references", "Dedup on ISRC / ISVN"],
    },
    "OTT Content Metadata": {
        "tag": "OTT",
        "desc": "Streaming platform delivery.",
        "columns": ["Title", "Content Type", "Season / Episode", "Genre", "Maturity Rating", "Language", "Run Time"],
        "rules": ["Map content-type vocabulary", "Normalize maturity ratings", "Validate episode numbering", "Fill language from reference"],
    },
    "Podcast Metadata": {
        "tag": "Podcast",
        "desc": "Episodes & shows.",
        "columns": ["Episode Title", "Show Name", "Host", "Duration", "Publish Date", "Category"],
        "rules": ["Normalize duration", "Roll episodes under their show", "Standardize category taxonomy", "Strip HTML from descriptions"],
    },
    "Radio Content Metadata": {
        "tag": "Radio",
        "desc": "Broadcast play logging.",
        "columns": ["Track Name", "Artist", "Air Date", "Time Slot", "Station", "Duration"],
        "rules": ["Normalize air date & time", "Map station codes", "Validate slot durations", "Dedup repeat plays"],
    },
    "Publishing Catalog Metadata": {
        "tag": "Publishing",
        "desc": "Works & compositions.",
        "columns": ["Work Title", "Writers", "Publisher", "IPI / CAE", "ISWC", "Share %"],
        "rules": ["Validate ISWC format", "Normalize writer / publisher splits", "Link recordings (ISRC) to works (ISWC)", "Flag unmatched shares"],
    },
    "Custom": None,
}

PRESET_ORDER = [
    "Metadata (PDL)", "Music Rights Catalog", "Artist Master Data", "Video Metadata",
    "OTT Content Metadata", "Podcast Metadata", "Radio Content Metadata",
    "Publishing Catalog Metadata", "Custom",
]

FIELD_MAP = {
    "ISRC": "isrc", "UPC": "upc", "Album cat. No.": "albumcat", "Album Name": "album", "Album": "album",
    "Track Name": "track", "Track": "track", "Song": "track", "Title": "track", "Work Title": "track", "Episode Title": "track",
    "Release Date": "release", "Release": "release", "Publish Date": "release", "Air Date": "release",
    "Singer": "singer", "Artist": "singer", "Artist Name": "singer", "Primary Artists": "singer", "Host": "singer",
    "Language": "lang", "Lang": "lang", "Genre": "genre", "Primary Genre": "genre", "Category": "genre",
    "Lyricist": "lyricist", "Writers": "lyricist", "Lyric Writer": "lyricist",
    "Composer": "composer", "Music By": "composer", "Director": "composer",
    "Label": "label", "Record Label": "label", "Publisher": "label", "Station": "label", "Show Name": "album",
    "Go Live Date": "golive", "Duration": "duration", "Run Time": "duration",
}

# Canonical G-artist reference (variants resolved during cleansing).
G_ARTISTS = [
    {"name": "Sonu Nigam", "variants": []},
    {"name": "Shreya Ghoshal", "variants": []},
    {"name": "Arijit Singh", "variants": ["Arijit S.", "Arjit Singh"]},
    {"name": "Shweta Mohan", "variants": ["Swetha Mohan"]},
    {"name": "Sunidhi Chauhan", "variants": ["Sunidhi Chowhan", "Sunithy Chouhan"]},
    {"name": "Rakesh Chaurasia", "variants": ["Rajesh Chaurasiya"]},
    {"name": "Ajay Ashok Gogavale", "variants": ["Ajay Gogavale"]},
    {"name": "Shankar Mahadevan", "variants": []},
    {"name": "Shaan", "variants": []},
    {"name": "Raju Singh", "variants": []},
    {"name": "Amit Trivedi", "variants": []},
    {"name": "Vishal Dadlani", "variants": []},
]


def public_config() -> dict:
    return {
        "presets": PRESETS,
        "presetOrder": PRESET_ORDER,
        "columns": COLUMNS,
        "fieldMap": FIELD_MAP,
        "gArtists": G_ARTISTS,
        "maxBytes": MAX_BYTES,
    }
