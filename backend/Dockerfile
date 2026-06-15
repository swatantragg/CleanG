# MRM-CleanUp backend — FastAPI + uvicorn.
FROM python:3.12-slim

WORKDIR /app

# psycopg2-binary ships manylinux wheels, so no system build deps are needed.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

# Secrets/config are injected at runtime via env_file (see docker-compose.yml);
# nothing sensitive is copied into the image.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
