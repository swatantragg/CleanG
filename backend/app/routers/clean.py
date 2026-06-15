"""Cleaning pipeline + on-demand revalidation for interactive review editing."""
from fastapi import APIRouter, Depends

from ..core.pipeline import clean_rows
from ..core.normalize import fmt_isrc
from ..core.validation import validate_record
from ..deps import get_current_user
from ..schemas import CleanIn, ValidateIn

router = APIRouter(tags=["pipeline"])


@router.post("/clean")
def clean(body: CleanIn, _=Depends(get_current_user)):
    clean_recs, review = clean_rows(body.rawRows, body.fields, body.mapping)
    return {"clean": clean_recs, "review": review}


@router.post("/validate")
def validate(body: ValidateIn, _=Depends(get_current_user)):
    """Recompute issues + display ISRC for records edited in the review queue."""
    results = []
    for r in body.records:
        rec = dict(r)
        rec["isrcDisplay"] = fmt_isrc(rec.get("isrc"))
        results.append({
            "_id": r.get("_id"),
            "issues": validate_record(rec),
            "isrcDisplay": rec["isrcDisplay"],
        })
    return {"results": results}
