# MRM Cleanser API
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first -> layer cache survives source edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App source (bundled master_output_format.xlsx ships inside app/data).
COPY app ./app

# Drop privileges: run as a non-root user so a process compromise is contained.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Where this container answers, echoed on boot so `docker compose logs backend`
# tells you the URL outright. Compose overrides it per environment.
ENV SERVICE_URL=http://localhost:8000

# init_db() seeds admin + master schema on first start via lifespan.
# `exec` hands PID 1 to uvicorn so SIGTERM still stops it cleanly.
CMD ["sh", "-c", "echo \"[CleanG] Backend API  -> ${SERVICE_URL}  (docs ${SERVICE_URL}/docs · health ${SERVICE_URL}/api/health)\"; exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
