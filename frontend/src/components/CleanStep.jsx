import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import Icon from "./Icon.jsx";

export default function CleanStep({ file, onCleaned, onReview }) {
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const alreadyCleaned = ["cleaned", "committed"].includes(file.status);

  async function run() {
    setError("");
    setBusy(true);
    setProgress(18);
    // The clean is a single fast request; fill the bar quickly toward ~95% while
    // we wait, then snap to 100% the moment results come back.
    const timer = setInterval(
      () => setProgress((p) => (p < 95 ? p + Math.max(3, (95 - p) * 0.3) : p)),
      90
    );
    try {
      const s = await api(`/api/files/${file.id}/clean`, { method: "POST" });
      setProgress(100);
      setSummary(s);
      onCleaned?.({ ...file, status: "cleaned" });
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(timer);
      setBusy(false);
      setTimeout(() => setProgress(0), 500);
    }
  }

  useEffect(() => {
    if (alreadyCleaned) {
      api(`/api/files/${file.id}/clean/summary`)
        .then(setSummary)
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clean the data</h1>
          <p className="muted">
            We automatically fix what we safely can (junk characters, date
            formats, durations, casing) and flag the rest for review.
          </p>
        </div>
        <button className="btn primary" onClick={run} disabled={busy}>
          <Icon name="sparkles" size={16} />
          {busy ? "Cleaning…" : alreadyCleaned ? "Re-run cleaning" : "Run cleaning"}
        </button>
      </div>

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}

      {busy && (
        <div className="card empty">
          <Icon name="sparkles" size={36} />
          <h3>Cleaning {file.n_rows} rows…</h3>
          <div className="progress" style={{ maxWidth: 420, margin: "1rem auto 0.5rem" }}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <p className="muted small">{Math.round(progress)}%</p>
        </div>
      )}

      {!summary && !busy && (
        <div className="card empty">
          <Icon name="sparkles" size={36} />
          <h3>Ready to clean {file.n_rows} rows</h3>
          <p className="muted">
            Click “Run cleaning” to standardize the data against the master format.
          </p>
        </div>
      )}

      {summary && (
        <>
          <div className="clean-stats">
            <div className="stat-card green">
              <div className="stat-num">{summary.clean}</div>
              <div className="stat-lbl">Clean rows</div>
            </div>
            <div className="stat-card amber">
              <div className="stat-num">{summary.errors}</div>
              <div className="stat-lbl">Need review</div>
            </div>
            <div className="stat-card blue">
              <div className="stat-num">{summary.auto_fixed}</div>
              <div className="stat-lbl">Cells auto-fixed</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{summary.total}</div>
              <div className="stat-lbl">Total rows</div>
            </div>
          </div>

          {summary.tags.length > 0 && (
            <div className="card" style={{ marginTop: "1.25rem" }}>
              <h3 style={{ marginTop: 0 }}>Issues found</h3>
              <div className="tag-list">
                {summary.tags.map((t) => (
                  <div className="tag-row" key={t.tag}>
                    <Icon name="alert" size={15} />
                    <span className="tag-label">{t.label}</span>
                    <span className="tag-count">{t.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="clean-cta">
            {summary.errors > 0 ? (
              <button className="btn primary" onClick={onReview}>
                Review {summary.errors} flagged row
                {summary.errors > 1 ? "s" : ""} <Icon name="arrowRight" size={16} />
              </button>
            ) : (
              <button className="btn primary" onClick={onReview}>
                <Icon name="check" size={16} /> All clean — continue to save
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
