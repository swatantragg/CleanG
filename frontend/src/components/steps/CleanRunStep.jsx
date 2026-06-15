// Stage 3 — Clean & validate: summarise checks + merges, then run the pipeline
// on the backend.

export default function CleanRunStep({ mapping, fields, rawRows, runClean, busy }) {
  const builtins = fields.filter((f) => !f.dynamic);
  const merges = fields.filter((f) => (mapping[f.key] || []).length > 1);
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 3 — Clean & validate</div>
          <h1>Run the cleaning pipeline</h1>
        </div>
      </div>
      <p className="lede">
        Each row is normalised (casing, spacing, code formatting, language resolution) then validated against the
        master output format. Any field that mismatches, or any required value that’s missing, sends the whole row to
        human review.
      </p>

      <div className="card">
        <h2>What the pipeline checks</h2>
        <div className="ch">All eight criteria must pass for a row to auto-clean.</div>
        <div className="row">
          {builtins.map((b) => (
            <span key={b.key} className="pill indigo">{b.label}</span>
          ))}
        </div>
        {merges.length > 0 && (
          <div className="note" style={{ marginTop: 16 }}>
            <span>↳</span>
            <span>
              <b>Many-to-one merges this run:</b>{" "}
              {merges.map((m) => `${m.label} ← ${(mapping[m.key] || []).join(" + ")}`).join("  ·  ")}
            </span>
          </div>
        )}
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={runClean} disabled={busy}>
            {busy ? "Cleaning…" : `Clean ${rawRows.length} rows`}
          </button>
          <span className="pill slate">normalise → validate → route</span>
        </div>
      </div>
    </div>
  );
}
