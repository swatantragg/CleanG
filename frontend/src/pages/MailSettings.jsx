import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import Icon from "../components/Icon.jsx";

function formatWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function Switch({ on, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`switch${on ? " on" : ""}`}
      onClick={onChange}
      disabled={disabled}
    >
      <span />
    </button>
  );
}

/**
 * Super-admin-only: the daily report email. Start/stop the scheduled send, pick
 * which addresses receive it, and send it on demand.
 */
export default function MailSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null); // "enabled" | "send" | "add" | recipient id
  const [newEmail, setNewEmail] = useState("");
  const [sendMsg, setSendMsg] = useState("");

  async function run(key, fn) {
    setError("");
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    run("load", async () => setData(await api("/api/reports/settings")));
  }, []);

  function setRecipients(fn) {
    setData((d) => ({ ...d, recipients: fn(d.recipients) }));
  }

  const toggleEnabled = () =>
    run("enabled", async () =>
      setData(
        await api("/api/reports/settings", {
          method: "PATCH",
          body: { enabled: !data.enabled },
        })
      )
    );

  const toggleRecipient = (r) =>
    run(r.id, async () => {
      const updated = await api(`/api/reports/recipients/${r.id}`, {
        method: "PATCH",
        body: { enabled: !r.enabled },
      });
      setRecipients((list) => list.map((x) => (x.id === r.id ? updated : x)));
    });

  const removeRecipient = (r) => {
    if (!window.confirm(`Remove ${r.email} from the daily report list?`)) return;
    run(r.id, async () => {
      await api(`/api/reports/recipients/${r.id}`, { method: "DELETE" });
      setRecipients((list) => list.filter((x) => x.id !== r.id));
    });
  };

  const addRecipient = (e) => {
    e.preventDefault();
    run("add", async () => {
      const created = await api("/api/reports/recipients", {
        method: "POST",
        body: { email: newEmail.trim() },
      });
      setRecipients((list) => [...list, created]);
      setNewEmail("");
    });
  };

  const sendNow = () => {
    setSendMsg("");
    run("send", async () => {
      const res = await api("/api/reports/daily/send", { method: "POST" });
      setSendMsg(
        `Report sent for ${res.files} file(s) to ${res.recipients.join(", ")}.`
      );
    });
  };

  if (!data) {
    return (
      <section>
        {error ? <div className="alert">{error}</div> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const receiving = data.recipients.filter((r) => r.enabled).length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Mail</h1>
          <p className="muted">
            The daily report email: whether it runs and who receives it.
          </p>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="card create-form">
        <div className="mail-status">
          <div>
            <h3>Daily report</h3>
            <p className="muted small">
              <span className={`status-dot${data.enabled ? " on" : ""}`} />
              {data.enabled ? "Running" : "Stopped"} · sends every day at{" "}
              {data.schedule} ({data.timezone})
              {data.enabled && data.next_run && <> · next {formatWhen(data.next_run)}</>}
            </p>
            {data.sender && <p className="muted small">From {data.sender}</p>}
          </div>
          <button
            type="button"
            className={`btn ${data.enabled ? "danger" : "primary"}`}
            onClick={toggleEnabled}
            disabled={busy === "enabled"}
          >
            {data.enabled ? "Stop mail" : "Start mail"}
          </button>
        </div>
        {!data.smtp_configured && (
          <div className="warn">
            <Icon name="alert" size={16} /> SMTP isn't configured on the server, so
            nothing can be sent yet. Set SMTP_HOST, SMTP_USER and SMTP_PASS.
          </div>
        )}
        <div>
          <button
            type="button"
            className="btn"
            onClick={sendNow}
            disabled={busy === "send"}
          >
            <Icon name="mail" size={15} />
            {busy === "send" ? "Sending…" : "Send report now"}
          </button>
          {sendMsg && <small className="muted mail-sent">{sendMsg}</small>}
        </div>
      </div>

      <div className="card create-form">
        <div>
          <h3>Recipients</h3>
          <p className="muted small">
            {receiving} of {data.recipients.length} receiving the report.
          </p>
        </div>
        <form className="mail-add" onSubmit={addRecipient}>
          <input
            type="email"
            placeholder="name@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
          <button className="btn primary" type="submit" disabled={busy === "add"}>
            <Icon name="plus" size={15} /> Add
          </button>
        </form>

        {data.recipients.length === 0 ? (
          <p className="muted">No recipients yet. Add an email above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Receiving</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.recipients.map((r) => (
                <tr key={r.id} className={r.enabled ? "" : "row-off"}>
                  <td>{r.email}</td>
                  <td>
                    <Switch
                      on={r.enabled}
                      onChange={() => toggleRecipient(r)}
                      disabled={busy === r.id}
                      label={r.enabled ? "Stop sending to this address" : "Send to this address"}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={() => removeRecipient(r)}
                      disabled={busy === r.id}
                    >
                      <Icon name="trash" size={15} /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
