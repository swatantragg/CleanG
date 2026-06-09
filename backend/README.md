# G-Cleanser — Backend

FastAPI + async SQLAlchemy 2.0 (asyncpg) + Alembic + Pydantic v2. Auth is JWT bearer
with argon2 password hashing. Files live in object storage (Google Drive); only
references live in Postgres.

## Run

```bash
cd CleanG/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then fill in the blanks (see below)
alembic upgrade head          # build the schema
uvicorn app.main:app --reload --port 8000
```

API root: `http://localhost:8000/api` · Docs: `/docs` · Health: `/api/health`

### Required env before it runs

- **Postgres** — `POSTGRES_*` (or `DATABASE_URL`).
- **`JWT_SECRET`** — any long random string (`python -c "import secrets;print(secrets.token_urlsafe(48))"`). Auth returns 500 until set.
- **Storage** — `STORAGE_BACKEND=drive` needs `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON path) and `GOOGLE_DRIVE_FOLDER_ID`. For local dev without Drive, set `STORAGE_BACKEND=local`.

## Data model (canonical schema)

`users 1—N branches`, `users 1—N presets` (owner nullable = system preset),
`presets 1—N branches`, `branches 1—N files`. Tables: `users`, `presets`,
`branches`, `files`. TEXT + CHECK enums (not PG enums); `timestamptz` everywhere;
`updated_at` maintained by BEFORE UPDATE triggers; two partial indexes on `branches`
(`WHERE status='active'`). The Alembic migration `0001_initial` reproduces it exactly.

## Data flow: upload → clean → share → expire → purge

1. **Register / login** (`/api/auth/*`) → JWT. Passwords are argon2-hashed; the hash is
   never returned or logged.
2. **Create branch** (`POST /api/branches`) → `status='active'`, `visibility` (`shared`
   default), `expires_at = now() + 7 days`.
3. **Upload sources** (`POST /api/branches/{id}/files`, multipart) → bytes go to storage,
   a `files` row is inserted with `kind='source'`, `storage_key` (never a public URL).
4. **Clean** (`POST /api/branches/{id}/clean`) → the pipeline (`app/pipeline.py`, stub seam)
   reads the sources and writes ONE `files` row with `kind='cleaned'`.
5. **Share / download** — owners download any of their files; any user can download the
   `cleaned` file of a `shared` + `active` branch. `GET /api/files/{id}/download` authorizes,
   then mints a **short-lived signed token** and returns a URL to `GET /api/files/{id}/stream`,
   which validates the token and streams the bytes. No standing public links.
   Other users discover shared branches via `GET /api/shared-branches`
   (`visibility='shared' AND status='active' AND user_id <> me`), which includes each
   branch's cleaned-file reference.
6. **Soft delete** (`DELETE /api/branches/{id}`) → `status='deleted'`, `deleted_at=now()`.
   The row is never hard-deleted — it survives as history. Files are wiped by the purge job.
7. **Purge** (`python -m app.purge`, scheduled) → idempotent. Selects
   `status='active' AND expires_at < now()`. For each: delete storage objects **first**
   (outside the DB transaction); only on success mark files `status='purged', purged_at,
   storage_key=''` and the branch `status='deleted', purged_at`. If a storage delete fails
   the branch is flagged `purge_failed` and retried next run. Nothing is marked purged
   before storage confirms.

## Storage (`app/storage.py`)

`StorageBackend` interface — `put(data, filename, mime) -> key`, `get(key) -> bytes`,
`delete(key)`. Implementations: `GoogleDriveStorage` (default) and `LocalStorage` (dev).
Swap for S3/GCS/R2 by adding a backend and pointing `STORAGE_BACKEND` at it. Downloads
go through the signed-token stream endpoint, so backends need no native presigning.

## Layout

```
app/
  main.py          app + CORS + lifespan seed + /api/health (db ping)
  settings.py      env (HTTP, Postgres async URL, JWT, storage)
  db.py            async engine / session / Base (lazy connect)
  models.py        User, Preset, Branch, File (1:1 with the schema)
  schemas.py       Pydantic v2 DTOs + enums (UserRead hides password_hash)
  security.py      argon2 hashing, JWT access + signed download tokens, current_user
  storage.py       StorageBackend + GoogleDrive/Local backends
  pipeline.py      cleaning hook (StubPipeline seam — wire the real engine here)
  purge.py         idempotent retention purge (python -m app.purge)
  seed.py          seed system presets (owner_id NULL) from config_data
  config_data.py   static config: columns, field map, G-artist reference, presets
  routers/         auth, presets, branches, shared, files, config
alembic/           env.py (async) + versions/0001_initial.py
```

## Open product decisions (not silently chosen)

- **G-artist list** — currently system-level / shared (read-only reference in
  `config_data.py`). Not yet a DB table.
- **Product name** — kept as **G-Cleanser** ("Cadence" remains a working title).
