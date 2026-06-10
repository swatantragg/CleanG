from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import Preset, User
from ..schemas import PresetCreate, PresetRead
from ..security import CurrentUser

router = APIRouter(prefix="/presets", tags=["presets"])


@router.get("", response_model=list[PresetRead])
async def list_presets(user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    """System presets (owner_id IS NULL) + the caller's own presets."""
    rows = (
        await db.execute(
            select(Preset)
            .where(or_(Preset.owner_id.is_(None), Preset.owner_id == user.id))
            .order_by(Preset.owner_id.is_(None).desc(), Preset.name)
        )
    ).scalars().all()
    return rows


@router.post("", response_model=PresetRead, status_code=201)
async def create_preset(body: PresetCreate, user: User = CurrentUser, db: AsyncSession = Depends(get_db)):
    preset = Preset(owner_id=user.id, name=body.name.strip(), config=body.config, is_shared=body.is_shared)
    db.add(preset)
    await db.commit()
    await db.refresh(preset)
    return preset
