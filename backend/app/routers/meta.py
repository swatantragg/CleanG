"""Configuration the frontend pulls instead of hardcoding: schema + presets."""
from fastapi import APIRouter, Depends

from ..core.schema import BUILTINS, SYNS
from ..core.presets import PRESETS
from ..deps import get_current_user

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("")
def meta(_=Depends(get_current_user)):
    return {"builtins": BUILTINS, "syns": SYNS, "presets": PRESETS}
