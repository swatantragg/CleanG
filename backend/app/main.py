"""FastAPI entrypoint: CORS, table creation, and router wiring under /api."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, engine
from . import models  # noqa: F401  (ensure models are registered before create_all)
from .routers import auth, meta, ingest, clean, master

Base.metadata.create_all(bind=engine)

app = FastAPI(title="MRM-CleanUp API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth.router, meta.router, ingest.router, clean.router, master.router):
    app.include_router(r, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}
