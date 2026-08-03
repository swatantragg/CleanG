import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "../components/Icon.jsx";

const STEP_LABELS = ["Not started", "Uploaded", "Mapped", "Cleaned", "Saved"];

export default function Dashboard() {
  const { user } = useAuth();
  // Admins and super users see every branch and may delete any of them; a plain
  // user only ever sees their own and can't delete branches. (Backend enforces
  // this too — this just hides the control.)
  const canManageAllBranches =
    user?.role === "admin" || user?.role === "superuser";
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null); // branch pending deletion
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await api(`/api/branches/${deleteTarget.id}`, { method: "DELETE" });
      setBranches((prev) => prev.filter((b) => b.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      setBranches(await api("/api/branches"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.description || "").toLowerCase().includes(q)
    );
  }, [branches, query]);

  const stats = useMemo(() => {
    let active = 0;
    let done = 0;
    for (const b of branches) {
      if (b.progress >= 4) done += 1;
      else if (b.progress >= 1) active += 1;
    }
    return { total: branches.length, active, done };
  }, [branches]);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const branch = await api("/api/branches", {
        method: "POST",
        body: { name, description: description || null },
      });
      setBranches((prev) => [branch, ...prev]);
      setName("");
      setDescription("");
      setShowForm(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Branches</h1>
          <p className="muted">
            Each branch is one cleaning request — upload, map, and clean a file.
          </p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((s) => !s)}>
          <Icon name="plus" size={16} />
          {showForm ? "Cancel" : "New branch"}
        </button>
      </div>

      {/* Overview stats */}
      {!loading && branches.length > 0 && (
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-ico" style={{ background: "var(--brand-50)", color: "var(--brand)" }}>
              <Icon name="branch" size={18} />
            </span>
            <div>
              <b>{stats.total}</b>
              <span className="muted small">Total branches</span>
            </div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat-ico" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>
              <Icon name="sparkles" size={18} />
            </span>
            <div>
              <b>{stats.active}</b>
              <span className="muted small">In progress</span>
            </div>
          </div>
          <div className="dash-stat">
            <span className="dash-stat-ico" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
              <Icon name="check" size={18} />
            </span>
            <div>
              <b>{stats.done}</b>
              <span className="muted small">Saved to master</span>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}

      {showForm && (
        <form className="card create-form" onSubmit={handleCreate}>
          <h3>Create a branch</h3>
          <label>
            Branch name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Vendor X — June batch"
              autoFocus
              required
            />
          </label>
          <label>
            Description (optional)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this cleaning request for?"
            />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create branch"}
          </button>
        </form>
      )}

      {!loading && branches.length > 0 && (
        <div className="toolbar">
          <div className="search">
            <Icon name="search" size={16} />
            <input
              placeholder="Search branches…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="muted small">
            {filtered.length} of {branches.length}
          </span>
        </div>
      )}

      {loading ? (
        <div className="branch-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="card branch-card skeleton-card" key={i}>
              <div className="sk sk-icon" />
              <div className="sk sk-line" style={{ width: "70%" }} />
              <div className="sk sk-line" style={{ width: "90%" }} />
              <div className="sk sk-bar" />
            </div>
          ))}
        </div>
      ) : branches.length === 0 ? (
        <div className="card empty">
          <Icon name="branch" size={36} />
          <h3>No branches yet</h3>
          <p className="muted">Create your first branch to start cleaning a file.</p>
          <button className="btn primary" onClick={() => setShowForm(true)}>
            <Icon name="plus" size={16} /> New branch
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty">
          <Icon name="search" size={32} />
          <h3>No matches</h3>
          <p className="muted">Nothing matches “{query}”.</p>
        </div>
      ) : (
        <div className="branch-grid">
          {filtered.map((b) => {
            const pct = Math.round((Math.min(b.progress, 4) / 4) * 100);
            const complete = b.progress >= 4;
            return (
              <Link className="card branch-card" key={b.id} to={`/branches/${b.id}`}>
                <div className="branch-card-top">
                  <div className="branch-icon">
                    <Icon name="branch" size={18} />
                  </div>
                  <div className="branch-card-actions">
                    <span className={`status-pill ${b.status}`}>{b.status}</span>
                    {canManageAllBranches && (
                      <button
                        className="branch-del"
                        title="Delete branch"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeleteTarget(b);
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="branch-card-head">
                  <h3>{b.name}</h3>
                </div>
                {b.description ? (
                  <p className="muted small branch-desc">{b.description}</p>
                ) : (
                  <p className="muted small branch-desc faint">No description</p>
                )}

                <div className="branch-progress">
                  <div className="branch-progress-bar">
                    <span
                      style={{
                        width: `${pct}%`,
                        background: complete
                          ? "var(--green)"
                          : "var(--brand-gradient)",
                      }}
                    />
                  </div>
                  <span className="muted small">{STEP_LABELS[b.progress] || "Not started"}</span>
                </div>

                <div className="branch-meta">
                  <span className="branch-chip">
                    <Icon name="file" size={13} />
                    {b.file_count} file{b.file_count !== 1 ? "s" : ""}
                  </span>
                  <span>{new Date(b.created_at).toLocaleDateString()}</span>
                  <span className="open">
                    Open <Icon name="arrowRight" size={14} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {deleteTarget && (
        <div className="save-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-spark danger">
              <Icon name="trash" size={22} />
            </div>
            <h3>Delete this branch?</h3>
            <p className="muted">
              This permanently removes <strong>{deleteTarget.name}</strong>, its
              uploaded files and any master records saved from it. This cannot be
              undone.
            </p>
            <div className="confirm-actions">
              <button
                className="btn sm"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button className="btn sm danger" onClick={confirmDelete} disabled={deleting}>
                <Icon name="trash" size={15} />
                {deleting ? "Deleting…" : "Delete branch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
