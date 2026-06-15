"""Master schema: built-in fields, header synonyms, and language dictionaries."""

# Canonical master fields every record is cleaned into.
BUILTINS = [
    {"key": "singer",    "label": "Singer Name",    "sub": "merge target",     "type": "name"},
    {"key": "isrc",      "label": "ISRC",           "sub": "recording code",   "type": "isrc"},
    {"key": "upc",       "label": "UPC",            "sub": "barcode",          "type": "upc"},
    {"key": "composer",  "label": "Composer Name",  "sub": "composition",      "type": "name"},
    {"key": "publisher", "label": "Publisher Name", "sub": "rights publisher", "type": "name"},
    {"key": "label",     "label": "Label",          "sub": "record label",     "type": "name"},
    {"key": "lyricist",  "label": "Lyricist",       "sub": "lyrics writer",    "type": "name"},
    {"key": "language",  "label": "Language",       "sub": "track language",   "type": "lang"},
]

# Header-name synonyms used to auto-map source columns onto master fields.
SYNS = {
    "singer":    ["artist", "performer", "singer", "vocalist", "vocals", "artiste"],
    "isrc":      ["isrc", "isrccode"],
    "upc":       ["upc", "ean", "barcode", "upcean"],
    "composer":  ["composer", "music", "musicdirector", "musicby", "compositor"],
    "publisher": ["publisher", "publishing", "publishedby"],
    "label":     ["label", "recordlabel"],
    "lyricist":  ["lyricist", "lyrics", "lyricsby", "writer", "penned"],
    "language":  ["language", "lang", "locale"],
}

KNOWN_LANGS = [
    "English", "Hindi", "Tamil", "Telugu", "Punjabi", "Bengali", "Marathi",
    "Kannada", "Malayalam", "Gujarati", "Urdu", "Assamese", "Odia",
]

LANG_VARIANTS = {
    "en": "English", "eng": "English", "english": "English",
    "hi": "Hindi", "hin": "Hindi", "hindi": "Hindi",
    "ta": "Tamil", "tam": "Tamil", "tamil": "Tamil",
    "te": "Telugu", "tel": "Telugu", "telugu": "Telugu",
    "pa": "Punjabi", "pun": "Punjabi", "pnb": "Punjabi", "punjabi": "Punjabi",
    "bn": "Bengali", "ben": "Bengali", "bengali": "Bengali",
    "mr": "Marathi", "mar": "Marathi", "marathi": "Marathi",
    "kn": "Kannada", "kannada": "Kannada",
    "ml": "Malayalam", "malayalam": "Malayalam",
    "gu": "Gujarati", "gujarati": "Gujarati",
    "ur": "Urdu", "urdu": "Urdu",
}
