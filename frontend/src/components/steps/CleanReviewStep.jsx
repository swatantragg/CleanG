// Stage 4 — Cleaned review: editable grid of passing rows; commit to Master DB.
// The backend re-validates on upload — rows that became invalid are routed to
// human review and reported back.

export default function CleanReviewStep({ rows, fields, edit, upload, uploaded, goReview, reviewCount, busy }) {
  if (uploaded) {
    return (
      <div>
        <div className="pagehead">
          <div>
            <div className="eyebrow">Stage 4 — Cleaned review</div>
            <h1>Clean rows committed</h1>
          </div>
          {reviewCount > 0 ? (
            <button className="btn amber" onClick={goReview}>Go to human review ({reviewCount}) →</button>
          ) : (
            <button className="btn emerald" onClick={goReview}>—</button>
          )}
        </div>
        <div className="card">
          <div className="empty">
            <div className="e1">All clean rows uploaded to Master DB ✓</div>
            <p>
              {reviewCount > 0
                ? `${reviewCount} flagged record(s) still need human review before the master is final.`
                : "Nothing left in review — head to Master data."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const cols = fields.filter((f) => !f.dynamic).slice(0, 8);
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 4 — Cleaned review</div>
          <h1>
            Review clean data{" "}
            <span className="pill teal" style={{ verticalAlign: "middle" }}>{rows.length} rows</span>
          </h1>
        </div>
        <button className="btn teal" disabled={!rows.length || busy} onClick={upload}>
          {busy ? "Uploading…" : "Upload to Master DB →"}
        </button>
      </div>
      <p className="lede">
        Every passing row, shown once and fully editable. Fix anything cleaning normalised wrongly, then commit. Rows
        that become invalid on edit are routed to review instead of being written.
      </p>

      {rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="e1">No clean rows this run</div>
            <p>All rows were flagged for review.</p>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="scroll" style={{ maxHeight: "58vh", border: "none" }}>
            <table>
              <thead>
                <tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id}>
                    {cols.map((c) => (
                      <td key={c.key}>
                        <input
                          className="cellinput"
                          value={c.key === "isrc" ? r.isrc || "" : r[c.key] || ""}
                          onChange={(e) => edit(r._id, c.key, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
