"""One-time helper: obtain a Google Drive OAuth refresh token for a personal account.

A free @gmail.com cannot grant a service account any Drive quota, so cleaned files are
stored via OAuth user-delegation instead — the app acts as you and uses your own Drive.

Run once on a machine with a browser:

    python -m app.drive_auth /path/to/oauth_client.json

It opens a consent page; approve with the Google account that owns the target Drive
folder. The three values printed go into backend/.env, then set STORAGE_BACKEND=drive.
"""
from __future__ import annotations

import sys

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def main() -> None:
    client_secrets = sys.argv[1] if len(sys.argv) > 1 else "oauth_client.json"
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(client_secrets, SCOPES)
    # offline + consent forces Google to return a long-lived refresh token.
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    if not creds.refresh_token:
        sys.exit("No refresh token returned — revoke prior access and retry with prompt=consent.")

    print("\n# --- paste into backend/.env ---")
    print(f"GOOGLE_OAUTH_CLIENT_ID={creds.client_id}")
    print(f"GOOGLE_OAUTH_CLIENT_SECRET={creds.client_secret}")
    print(f"GOOGLE_OAUTH_REFRESH_TOKEN={creds.refresh_token}")
    print("STORAGE_BACKEND=drive")


if __name__ == "__main__":
    main()
