import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .routers import auth, branches, config, files, presets, shared
from .seed import seed_system_presets
from .settings import API_PREFIX, CORS_ORIGINS

log = logging.getLogger("gcleanser")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Best-effort seed of system presets when the DB is reachable.
    if db.AsyncSessionLocal is not None:
        try:
            async with db.AsyncSessionLocal() as session:
                added = await seed_system_presets(session)
                if added:
                    log.info("Seeded %d system presets", added)
        except Exception as exc:  # don't block startup if DB is down
            log.warning("System preset seed skipped: %s", exc)
    yield


app = FastAPI(title="G-Cleanser API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth.router, presets.router, branches.router, shared.router, files.router, config.router):
    app.include_router(r, prefix=API_PREFIX)


@app.get("/api/health")
async def health():
    return {"status": "ok", "database": await db.ping()}
