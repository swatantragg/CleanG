from fastapi import APIRouter

from ..config_data import COLUMNS, FIELD_MAP, G_ARTISTS, MAX_BYTES

router = APIRouter(prefix="/config", tags=["config"])


@router.get("")
def get_config():
    """Static application config not held in tables. Presets now come from /presets;
    G-artist reference is system-level read-only."""
    return {
        "columns": COLUMNS,
        "fieldMap": FIELD_MAP,
        "gArtists": G_ARTISTS,
        "maxBytes": MAX_BYTES,
    }
