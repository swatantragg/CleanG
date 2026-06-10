"""Storage abstraction for the CLEANED output only.

Source files are stored as TEXT in Postgres (see models.File.content); only the
final cleaned file goes to object storage (Google Drive). Nothing is stored locally.

Interface (sync; call via asyncio.to_thread from async routes):
    put(data, filename, mime) -> storage_key   (Drive file id)
    get(storage_key)          -> bytes
    delete(storage_key)       -> None

Downloads are never permanent public links — the route mints a short-lived signed
token (see security.sign_download_token) and streams bytes back through our own
endpoint, so this interface needs no native presigning.
"""
from __future__ import annotations

import io
from abc import ABC, abstractmethod

from . import settings


class StorageBackend(ABC):
    @abstractmethod
    def put(self, data: bytes, filename: str, mime: str | None) -> str: ...

    @abstractmethod
    def get(self, storage_key: str) -> bytes: ...

    @abstractmethod
    def delete(self, storage_key: str) -> None: ...


class GoogleDriveStorage(StorageBackend):
    """Google Drive backend via a service account. storage_key = Drive file id."""

    def __init__(self, credentials_path: str, folder_id: str):
        if not credentials_path or not folder_id:
            raise RuntimeError(
                "Google Drive storage needs GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_DRIVE_FOLDER_ID."
            )
        self.credentials_path = credentials_path
        self.folder_id = folder_id
        self._svc = None

    def _service(self):
        if self._svc is None:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build

            creds = service_account.Credentials.from_service_account_file(
                self.credentials_path, scopes=["https://www.googleapis.com/auth/drive.file"]
            )
            self._svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        return self._svc

    def put(self, data: bytes, filename: str, mime: str | None) -> str:
        from googleapiclient.http import MediaIoBaseUpload

        media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime or "application/octet-stream", resumable=False)
        meta = {"name": filename or "file", "parents": [self.folder_id]}
        created = (
            self._service().files()
            .create(body=meta, media_body=media, fields="id", supportsAllDrives=True)
            .execute()
        )
        return created["id"]

    def get(self, storage_key: str) -> bytes:
        from googleapiclient.http import MediaIoBaseDownload

        request = self._service().files().get_media(fileId=storage_key, supportsAllDrives=True)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue()

    def delete(self, storage_key: str) -> None:
        from googleapiclient.errors import HttpError

        try:
            self._service().files().delete(fileId=storage_key, supportsAllDrives=True).execute()
        except HttpError as exc:
            if getattr(exc, "status_code", None) == 404 or "404" in str(exc):
                return  # already gone — idempotent
            raise


_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    """Singleton Google Drive backend (only the cleaned output is stored here)."""
    global _backend
    if _backend is None:
        _backend = GoogleDriveStorage(
            settings.GOOGLE_APPLICATION_CREDENTIALS, settings.GOOGLE_DRIVE_FOLDER_ID
        )
    return _backend
