import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import Icon from "../components/Icon.jsx";
import { ASSIGNABLE_ROLES, isSuperAdmin, roleLabel } from "../utils/roles.js";

const EMPTY = { email: "", full_name: "", password: "", role: "user" };

const TABS = [
  { id: "users", label: "Users", icon: "users" },
  { id: "activity", label: "Activity", icon: "file" },
];

function formatWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Admin-only: which files each user worked on. Deliberately narrow — who, which
 * file, where and when. It never reports what was done to the data.
 */
function Activity({ users }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [who, setWho] = useState("all");

  async function load(userId) {
    setLoading(true);
    setError("");
    try {
      const query = userId && userId !== "all" ? `?user_id=${userId}` : "";
      setRows(await api(`/api/users/activity${query}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(who);
  }, [who]);

  return (
    <>
      <div className="resolved-bar">
        <div className="muted small">
          Every file a user has worked on, most recent first.
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => load(who)} disabled={loading}>
            <Icon name="restore" size={15} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {loading ? (
        <p className="muted">Loading activity…</p>
      ) : rows.length === 0 ? (
        <p className="muted">
          No file activity yet. Entries appear as soon as a user uploads or
          standardizes a file.
        </p>
      ) : (
        <table className="table card">
          <thead>
            <tr>
              <th>User</th>
              <th>File</th>
              <th>Where</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.user_name || "—"}</strong>
                  {a.role && (
                    <span className="role-pill" style={{ marginLeft: "0.4rem" }}>
                      {roleLabel(a.role)}
                    </span>
                  )}
                  <div className="muted small">{a.user_email}</div>
                </td>
                <td>
                  <Icon name="file" size={14} /> {a.filename}
                </td>
                <td>{a.area}</td>
                <td className="muted">{formatWhen(a.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Super-admin-only: set a new password for another account. */
function SetPasswordDialog({ target, onClose, onDone }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onDone(
        await api(`/api/users/${target.id}/reset-password`, {
          method: "POST",
          body: { password },
        })
      );
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="save-overlay" onClick={busy ? undefined : onClose}>
      <form
        className="confirm-modal pw-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="confirm-spark">
          <Icon name="lock" size={22} />
        </div>
        <h3>Set a new password</h3>
        <p className="muted small">
          For <strong>{target.full_name}</strong> ({target.email}). They'll be
          signed out everywhere and asked to choose their own password at next
          login.
        </p>
        {error && <div className="alert">{error}</div>}
        <label>
          New password
          <span className="pw-wrap">
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
              autoFocus
            />
            <button
              type="button"
              className="pw-toggle"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              title={show ? "Hide password" : "Show password"}
              tabIndex={-1}
            >
              <Icon name={show ? "eyeOff" : "eye"} size={18} />
            </button>
          </span>
          <small className="muted">
            Min 8 characters, with an uppercase letter, a lowercase letter and a
            digit.
          </small>
        </label>
        <div className="confirm-actions">
          <button type="button" className="btn sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn sm primary" disabled={busy}>
            {busy ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [tab, setTab] = useState("users");
  const [rowBusy, setRowBusy] = useState(null); // id of the user row being changed
  // Row-action errors show right above the table, where the click happened.
  const [rowError, setRowError] = useState("");
  const [rowMsg, setRowMsg] = useState("");
  const [pwTarget, setPwTarget] = useState(null); // user whose password is being set
  const superAdmin = isSuperAdmin(me);

  async function load() {
    setLoading(true);
    try {
      setUsers(await api("/api/users"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await api("/api/users", { method: "POST", body: form });
      setUsers((prev) => [user, ...prev]);
      setForm(EMPTY);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(id, role) {
    setRowError("");
    setRowMsg("");
    setRowBusy(id);
    try {
      const updated = await api(`/api/users/${id}`, {
        method: "PATCH",
        body: { role },
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch (err) {
      setRowError(err.message);
    } finally {
      setRowBusy(null);
    }
  }

  async function removeUser(u) {
    if (
      !window.confirm(
        `Delete ${u.full_name} (${u.email})? This permanently removes the account and cannot be undone.`
      )
    )
      return;
    setRowError("");
    setRowMsg("");
    setRowBusy(u.id);
    try {
      await api(`/api/users/${u.id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } catch (err) {
      setRowError(err.message);
    } finally {
      setRowBusy(null);
    }
  }

  function passwordSet(updated) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    setRowError("");
    setRowMsg(`New password set for ${updated.full_name}.`);
    setPwTarget(null);
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted">
            Provision accounts for your team, and see which files they worked on.
          </p>
        </div>
      </div>

      <div className="view-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && <Activity users={users} />}

      {tab === "users" && (
        <>
        {error && <div className="alert">{error}</div>}

        <form className="card create-form" onSubmit={handleCreate}>
          <h3>Create account</h3>
          <div className="form-row">
            <label>
              Full name
              <input
                value={form.full_name}
                onChange={(e) => update("full_name", e.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Temporary password
              <span className="pw-wrap">
                <input
                  type={showPw ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => update("password", e.target.value)}
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  className="pw-toggle"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  title={showPw ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  <Icon name={showPw ? "eyeOff" : "eye"} size={18} />
                </button>
              </span>
              <small className="muted">
                Min 8 characters, with an uppercase letter, a lowercase letter and
                a digit.
              </small>
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(e) => update("role", e.target.value)}
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>

        {rowError && <div className="alert">{rowError}</div>}
        {rowMsg && <div className="ok-note">{rowMsg}</div>}

        {loading ? (
          <p className="muted">Loading users…</p>
        ) : (
          <table className="table card">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = me?.id === u.id;
                // Only a super admin ever receives "super_admin" here (the API
                // shows those accounts to admins as plain admins).
                const isSuper = u.role === "super_admin";
                const roleOptions = ASSIGNABLE_ROLES.includes(u.role)
                  ? ASSIGNABLE_ROLES
                  : [u.role, ...ASSIGNABLE_ROLES];
                return (
                  <tr key={u.id}>
                    <td>{u.full_name}</td>
                    <td>{u.email}</td>
                    <td>
                      <select
                        value={u.role}
                        disabled={isSelf || isSuper || rowBusy === u.id}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                        title={
                          isSelf
                            ? "You can't change your own role"
                            : isSuper
                              ? "Super admin role is fixed"
                              : "Change role"
                        }
                      >
                        {roleOptions.map((r) => (
                          <option
                            key={r}
                            value={r}
                            disabled={!ASSIGNABLE_ROLES.includes(r)}
                          >
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{u.is_active ? "Active" : "Disabled"}</td>
                    <td className="row-actions">
                      {superAdmin && !isSelf && !isSuper && (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={rowBusy === u.id}
                          onClick={() => setPwTarget(u)}
                          title="Set a new password"
                        >
                          <Icon name="lock" size={15} /> Password
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={isSelf || isSuper || rowBusy === u.id}
                        onClick={() => removeUser(u)}
                        title={
                          isSelf
                            ? "You can't delete your own account"
                            : isSuper
                              ? "Super admin accounts can't be deleted"
                              : "Delete user"
                        }
                      >
                        <Icon name="trash" size={15} /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </>
      )}

      {pwTarget && (
        <SetPasswordDialog
          target={pwTarget}
          onClose={() => setPwTarget(null)}
          onDone={passwordSet}
        />
      )}
    </section>
  );
}
