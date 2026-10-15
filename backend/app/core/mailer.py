"""Minimal SMTP mailer (stdlib only).

Sends a multipart (plain-text + HTML) message via the SMTP server configured in
the environment. Used by the daily report; deliberately tiny so there is no extra
dependency. Raises on a misconfigured server or a send failure so callers (the
manual /api/reports endpoint) can surface the error; the scheduled job wraps it
in a try/except so a bad night never crashes the app.
"""

import smtplib
import ssl
from email.message import EmailMessage

from ..config import SMTP_USE_SSL, SMTP_USE_TLS, get_settings


def send_email(
    subject: str,
    html_body: str,
    text_body: str,
    recipients: list[str],
) -> list[str]:
    """Send one email. Returns the recipient list actually used."""
    settings = get_settings()
    if not settings.smtp_configured:
        raise RuntimeError(
            "SMTP is not configured. Set SMTP_HOST and SMTP_USER/SMTP_FROM in "
            "the environment."
        )
    to = list(recipients)
    if not to:
        raise RuntimeError(
            "No report recipients are switched on. Turn one on in the Mail tab."
        )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_sender
    msg["To"] = ", ".join(to)
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    if SMTP_USE_SSL:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, context=context, timeout=30
        ) as server:
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_pass)
            server.send_message(msg, to_addrs=to)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            server.ehlo()
            if SMTP_USE_TLS:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_pass)
            server.send_message(msg, to_addrs=to)
    return to
