"""initial schema: users, presets, branches, files

Reproduces the canonical SQL exactly: citext extension, set_updated_at() function,
four tables with checks + FK ondelete, all indexes (incl. two partial), and three
BEFORE UPDATE triggers.

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-09
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import CITEXT, JSONB

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


SET_UPDATED_AT_FN = """
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
"""


def _updated_at_trigger(table: str) -> str:
    return (
        f"CREATE TRIGGER {table}_set_updated_at BEFORE UPDATE ON {table} "
        f"FOR EACH ROW EXECUTE FUNCTION set_updated_at();"
    )


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute(SET_UPDATED_AT_FN)

    # ---- users ----
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("email", CITEXT, nullable=False, unique=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.execute(_updated_at_trigger("users"))

    # ---- presets ----
    op.create_table(
        "presets",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("owner_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_shared", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.execute(_updated_at_trigger("presets"))

    # ---- branches ----
    op.create_table(
        "branches",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("preset_id", sa.BigInteger, sa.ForeignKey("presets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default=sa.text("'active'")),
        sa.Column("visibility", sa.Text, nullable=False, server_default=sa.text("'shared'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now() + INTERVAL '7 days'")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('active','expired','deleted','purge_failed')", name="branches_status_check"),
        sa.CheckConstraint("visibility IN ('private','shared')", name="branches_visibility_check"),
    )
    op.execute(_updated_at_trigger("branches"))
    op.create_index("branches_user_id_idx", "branches", ["user_id"])
    op.create_index("branches_preset_id_idx", "branches", ["preset_id"])
    op.create_index("branches_expiry_idx", "branches", ["expires_at"], postgresql_where=sa.text("status = 'active'"))
    op.create_index("branches_shared_idx", "branches", ["visibility"], postgresql_where=sa.text("status = 'active'"))

    # ---- files ----
    op.create_table(
        "files",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("branch_id", sa.BigInteger, sa.ForeignKey("branches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("original_filename", sa.Text, nullable=True),
        sa.Column("mime_type", sa.Text, nullable=True),
        sa.Column("size_bytes", sa.BigInteger, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default=sa.text("'available'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('source','cleaned')", name="files_kind_check"),
        sa.CheckConstraint("status IN ('available','purged')", name="files_status_check"),
    )
    op.create_index("files_branch_id_idx", "files", ["branch_id"])
    op.create_index("files_branch_kind_idx", "files", ["branch_id", "kind"])


def downgrade() -> None:
    op.drop_table("files")  # drops its indexes
    op.execute("DROP TRIGGER IF EXISTS branches_set_updated_at ON branches")
    op.drop_table("branches")
    op.execute("DROP TRIGGER IF EXISTS presets_set_updated_at ON presets")
    op.drop_table("presets")
    op.execute("DROP TRIGGER IF EXISTS users_set_updated_at ON users")
    op.drop_table("users")
    op.execute("DROP FUNCTION IF EXISTS set_updated_at()")
    op.execute("DROP EXTENSION IF EXISTS citext")
