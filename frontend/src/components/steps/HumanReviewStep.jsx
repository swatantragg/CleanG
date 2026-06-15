// Stage 5 — Human review queue: per-record cards showing why each was flagged.
// Issues come from the backend (refreshed as you edit); approve writes the
// corrected record after a server-side dedup check.

export default function HumanReviewStep({ rows, fields, edit, approve, goMaster }) {
  const cols = fields.filter((f) => !f.dynamic);
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 5 — Human review queue</div>
          <h1>Resolve flagged records</h1>
        </div>
        <button className="btn emerald" onClick={goMaster}>Go to Master data →</button>
      </div>
      <p className="lede">
        Each card shows why the record was flagged. Correct the highlighted fields until every issue clears, then
        approve — a duplicate check runs at upload before it’s written to the master store.
      </p>

      {!rows || rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="e1">Review queue is empty ✓</div>
            <p>Every flagged record has been resolved. The master data can be finalised.</p>
          </div>
        </div>
      ) : (
        rows.map((r) => {
          const iss = r.issues || [];
          const ok = iss.length === 0;
          const reasonFor = (k) => iss.find((i) => i.field === k);
          return (
            <div className={"reviewcard" + (ok ? " ok" : "")} key={r._id}>
              <div className="row" style={{ marginBottom: 6 }}>
                <b style={{ fontFamily: "'Space Grotesk'" }}>{r.singer || "(no singer)"}</b>
                <span className="mono" style={{ color: "var(--muted)", fontSize: 13.5 }}>
                  {r.isrcDisplay || r.isrc || "no ISRC"}
                </span>
                <span className="spacer"></span>
                {ok ? (
                  <span className="pill teal">all checks pass</span>
                ) : (
                  <span className="pill amber">{iss.length} issue{iss.length > 1 ? "s" : ""}</span>
                )}
              </div>
              <div className="reasons">
                {iss.map((i, x) => (
                  <span key={x} className={"pill " + (i.type === "missing" ? "rose" : "amber")}>
                    {fields.find((f) => f.key === i.field)?.label}: {i.msg}
                  </span>
                ))}
              </div>
              <div className="fieldgrid">
                {cols.map((c) => {
                  const why = reasonFor(c.key);
                  return (
                    <div className="field" key={c.key}>
                      <label>{c.label}</label>
                      <input
                        className={why ? "bad" : ""}
                        value={c.key === "isrc" ? r.isrc || "" : r[c.key] || ""}
                        onChange={(e) => edit(r._id, c.key, e.target.value)}
                      />
                      {why && <div className="why">{why.msg}</div>}
                    </div>
                  );
                })}
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn teal sm" disabled={!ok} onClick={() => approve(r._id)}>
                  Approve & upload
                </button>
                {!ok && <span className="pill slate">resolve all issues to enable</span>}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
