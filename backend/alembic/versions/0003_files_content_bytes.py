"""files: binary-safe content storage

Adds files.content_bytes (BYTEA) so SOURCE files (and locally-stored CLEANED files)
keep their raw bytes. The old TEXT `content` column could not hold binary uploads
(e.g. .xlsx): Postgres TEXT rejects NUL (0x00) bytes, which crashed XLSX uploads.

Revision ID: 0003_files_content_bytes
Revises: 0002_files_content
Create Date: 2026-06-10
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_files_content_bytes"
down_revision = "0002_files_content"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("content_bytes", sa.LargeBinary(), nullable=True))


def downgrade() -> None:
    op.drop_column("files", "content_bytes")
