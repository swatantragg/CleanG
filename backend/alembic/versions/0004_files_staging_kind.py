"""files: allow kind='staging'

A cleaning run that produces uncertain duplicate pairs holds an intermediate
"staging" artifact (the auto-merged master + the pending review pairs, as JSON)
until the operator finalizes the master. Relax the kind CHECK to permit 'staging'.

Revision ID: 0004_files_staging_kind
Revises: 0003_files_content_bytes
Create Date: 2026-06-10
"""
from alembic import op

revision = "0004_files_staging_kind"
down_revision = "0003_files_content_bytes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("files_kind_check", "files", type_="check")
    op.create_check_constraint(
        "files_kind_check", "files", "kind IN ('source','cleaned','staging')"
    )


def downgrade() -> None:
    op.drop_constraint("files_kind_check", "files", type_="check")
    op.create_check_constraint(
        "files_kind_check", "files", "kind IN ('source','cleaned')"
    )
