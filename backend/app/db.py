"""Async SQLAlchemy engine, session, and declarative base.

Connection is lazy: the engine is built only when the database is configured
via env (POSTGRES_* or DATABASE_URL).
"""
from __future__ import annotations

from typing import AsyncIterator, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .settings import asyncpg_connect_args, database_url


class Base(DeclarativeBase):
    pass


_url = database_url("asyncpg")
engine: Optional[AsyncEngine] = (
    create_async_engine(_url, pool_pre_ping=True, connect_args=asyncpg_connect_args()) if _url else None
)
AsyncSessionLocal: Optional[async_sessionmaker[AsyncSession]] = (
    async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession) if engine else None
)


def is_configured() -> bool:
    return engine is not None


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a request-scoped async session."""
    if AsyncSessionLocal is None:
        raise RuntimeError(
            "Database is not configured. Set POSTGRES_* (or DATABASE_URL) in backend/.env"
        )
    async with AsyncSessionLocal() as session:
        yield session


async def ping() -> dict:
    if engine is None:
        return {"configured": False, "ok": False}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"configured": True, "ok": True}
    except Exception as exc:  # report, don't crash
        return {"configured": True, "ok": False, "error": str(exc)}
