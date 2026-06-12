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

    def __init__(self, credentials_path: str, folder_id: str, impersonate_subject: str | None = None):
        if not credentials_path or not folder_id:
            raise RuntimeError(
                "Google Drive storage needs GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_DRIVE_FOLDER_ID."
            )
        self.credentials_path = credentials_path
        self.folder_id = folder_id
        # A bare service account has NO Drive storage quota — uploads into a personal
        # ("My Drive") folder fail 403. Quota comes from either a Shared Drive the SA
        # is a member of, or domain-wide delegation impersonating a Workspace user.
        self.impersonate_subject = impersonate_subject or None
        self._svc = None

    def _service(self):
        if self._svc is None:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build

            creds = service_account.Credentials.from_service_account_file(
                self.credentials_path, scopes=["https://www.googleapis.com/auth/drive.file"]
            )
            if self.impersonate_subject:
                creds = creds.with_subject(self.impersonate_subject)
            self._svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        return self._svc

    def put(self, data: bytes, filename: str, mime: str | None) -> str:
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaIoBaseUpload

        media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime or "application/octet-stream", resumable=False)
        meta = {"name": filename or "file", "parents": [self.folder_id]}
        try:
            created = (
                self._service().files()
                .create(body=meta, media_body=media, fields="id", supportsAllDrives=True)
                .execute()
            )
        except HttpError as exc:
            if "storageQuotaExceeded" in str(exc) or "do not have storage quota" in str(exc):
                raise RuntimeError(
                    "Google Drive upload failed: the service account has no storage quota. "
                    "Point GOOGLE_DRIVE_FOLDER_ID at a folder inside a Shared Drive (add the "
                    "service account as a member), or set GOOGLE_DRIVE_IMPERSONATE_SUBJECT to a "
                    "Workspace user with domain-wide delegation enabled."
                ) from exc
            raise
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


class GoogleDriveOAuthStorage(GoogleDriveStorage):
    """OAuth user-delegated Drive — the app acts as a real Google user, so uploads use
    that user's own 15 GB quota. This is the ONLY way to store in Drive from a free
    personal @gmail.com (service accounts have no quota; Shared Drives/delegation need
    Workspace). Obtain the one-time refresh token via `python -m app.drive_auth`.
    """

    def __init__(self, client_id: str, client_secret: str, refresh_token: str, folder_id: str):
        if not (client_id and client_secret and refresh_token and folder_id):
            raise RuntimeError(
                "OAuth Drive storage needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, "
                "GOOGLE_OAUTH_REFRESH_TOKEN and GOOGLE_DRIVE_FOLDER_ID."
            )
        self.folder_id = folder_id
        self.impersonate_subject = None  # inherited put() branch only checks quota errors
        self._oauth = (client_id, client_secret, refresh_token)
        self._svc = None

    def _service(self):
        if self._svc is None:
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build

            client_id, client_secret, refresh_token = self._oauth
            creds = Credentials(
                token=None,
                refresh_token=refresh_token,
                client_id=client_id,
                client_secret=client_secret,
                token_uri="https://oauth2.googleapis.com/token",
                scopes=["https://www.googleapis.com/auth/drive.file"],
            )
            self._svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        return self._svc


_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    """Singleton Drive backend. Prefers OAuth user-delegation (works with a personal
    Gmail) when a refresh token is configured; otherwise a service account (Workspace
    Shared Drive / domain-wide delegation)."""
    global _backend
    if _backend is None:
        if settings.GOOGLE_OAUTH_REFRESH_TOKEN:
            _backend = GoogleDriveOAuthStorage(
                settings.GOOGLE_OAUTH_CLIENT_ID,
                settings.GOOGLE_OAUTH_CLIENT_SECRET,
                settings.GOOGLE_OAUTH_REFRESH_TOKEN,
                settings.GOOGLE_DRIVE_FOLDER_ID,
            )
        else:
            _backend = GoogleDriveStorage(
                settings.GOOGLE_APPLICATION_CREDENTIALS,
                settings.GOOGLE_DRIVE_FOLDER_ID,
                settings.GOOGLE_DRIVE_IMPERSONATE_SUBJECT,
            )
    return _backend
