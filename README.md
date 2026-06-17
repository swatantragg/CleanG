# MRM Cleanser

A web app for fully cleaning Excel files. This is the foundation milestone:
**login → admin-managed users → branch creation**. Each cleaning request lives
in its own *branch* (workspace).

- **Frontend:** React (Vite)
- **Backend:** Python (FastAPI)
- **Database:** Neon (Postgres)

## User journey (so far)

1. **Login** — there is no public sign-up. The admin provisions every account.
2. **Admin → Users** — an admin creates accounts (id/password) for people.
3. **Branches** — any logged-in user creates a branch per cleaning request and
   sees their branches (admins see all).

The Excel cleaning steps themselves come in the next milestones.

---

## Docker

Runs the whole stack (frontend + backend) in two containers. The database
stays external (Neon) via `backend/.env` → `DATABASE_URL`.

```bash
cd CleanG
cp backend/.env.example backend/.env   # fill DATABASE_URL, SECRET_KEY, admin creds
docker compose up -d --build
```

- App:  http://localhost:5173
- API:  http://localhost:3000/api/health (also proxied at `:5173/api`)

`docker compose down` to stop. The backend seeds the admin + master schema on
first start; the frontend is built and served by nginx, which proxies `/api`
to the backend.

---

## 1. Backend setup (local, without Docker)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — paste your Neon connection string (ends with `?sslmode=require`).
- `SECRET_KEY` — a long random string (e.g. `python -c "import secrets; print(secrets.token_hex(32))"`).
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — the bootstrap admin, created automatically
  on first startup if the database has no users.

Run it:

```bash
uvicorn app.main:app --reload --port 8000
```

On first start it creates the tables and seeds the admin. API docs: http://localhost:8000/docs

## 2. Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/api` to the backend on
port 8000, so no extra config is needed.

## 3. First login

Sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from your `.env`, then go to
**Users** to create accounts for your team.

---

## API summary

| Method | Path | Who | Purpose |
| ------ | ---- | --- | ------- |
| POST | `/api/auth/login` | anyone | Get a session token |
| GET  | `/api/auth/me` | logged in | Current user |
| GET  | `/api/users` | admin | List users |
| POST | `/api/users` | admin | Create an account |
| GET  | `/api/branches` | logged in | List branches (own; admin sees all) |
| POST | `/api/branches` | logged in | Create a branch |
