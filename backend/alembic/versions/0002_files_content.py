"""files: store source text in DB

Adds files.content (TEXT) so uploaded SOURCE files are stored as text in Postgres.
Cleaned files keep using storage_key (Google Drive); source files use content with
storage_key = ''. storage_key default set to '' so source rows satisfy NOT NULL.

Revision ID: 0002_files_content
Revises: 0001_initial
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_files_content"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("content", sa.Text(), nullable=True))
    op.alter_column("files", "storage_key", server_default=sa.text("''"))


def downgrade() -> None:
    op.alter_column("files", "storage_key", server_default=None)
    op.drop_column("files", "content")
