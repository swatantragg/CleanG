"""files: allow kind='corrupted'

The "skip & download" export writes two outputs: the confidently-clean rows
(kind='cleaned') and the flagged/corrupted rows (kind='corrupted'), both as .xlsx.
Relax the kind CHECK to permit 'corrupted'.

Revision ID: 0005_files_corrupted_kind
Revises: 0004_files_staging_kind
Create Date: 2026-06-11
"""
from alembic import op

revision = "0005_files_corrupted_kind"
down_revision = "0004_files_staging_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("files_kind_check", "files", type_="check")
    op.create_check_constraint(
        "files_kind_check", "files", "kind IN ('source','cleaned','corrupted','staging')"
    )


def downgrade() -> None:
    op.drop_constraint("files_kind_check", "files", type_="check")
    op.create_check_constraint(
        "files_kind_check", "files", "kind IN ('source','cleaned','staging')"
    )
