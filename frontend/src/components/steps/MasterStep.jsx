// Stage 6 — Master database: the canonical deduplicated store + duplicate log.

export default function MasterStep({ master, dedup, cleanUploaded, reviewCount, fields, goExtract, resetMaster }) {
  const cols = fields.filter((f) => !f.dynamic).slice(0, 8);
  const finalReady = cleanUploaded && reviewCount === 0;
  const onReset = () => {
    if (window.confirm("Clear all master records and the dedup log? This cannot be undone.")) resetMaster();
  };
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 6 — Master database</div>
          <h1>{finalReady ? "Final Master Data" : "Master Database"}</h1>
        </div>
        <div className="row">
          <button className="btn slate" disabled={!master.length} onClick={onReset}>Reset store</button>
          <button className="btn purple" disabled={!master.length} onClick={goExtract}>Go to extraction →</button>
        </div>
      </div>
      <p className="lede">
        The canonical, deduplicated store. Clean rows and corrected review rows both land here, and every write is
        checked against existing records. When clean upload is done and the review queue is empty, this set becomes the
        Final Master Data for extraction.
      </p>

      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <span className={"pill " + (finalReady ? "emerald" : "slate")}>
            {finalReady ? "✓ Final Master Data ready" : "awaiting review completion"}
          </span>
          <span className="pill emerald">{master.length} records</span>
          <span className="pill rose">{dedup.length} duplicates skipped</span>
        </div>
        {master.length === 0 ? (
          <div className="empty">
            <div className="e1">No master records yet</div>
            <p>Upload clean rows or approve reviewed records to populate the master store.</p>
          </div>
        ) : (
          <div className="scroll" style={{ maxHeight: "46vh" }}>
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {master.map((r) => (
                  <tr key={r._id}>
                    <td>
                      <span className={"pill " + (r._src === "review" ? "amber" : "teal")}>{r._src}</span>
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className={c.key === "isrc" ? "mono" : ""}>
                        {c.key === "isrc" ? r.isrcDisplay || r.isrc : r[c.key] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dedup.length > 0 && (
        <div className="card">
          <h2>Duplicate check log</h2>
          <div className="ch">Candidates skipped because a matching master record already existed.</div>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Singer</th><th>ISRC</th><th>Match key</th></tr>
              </thead>
              <tbody>
                {dedup.map((d, i) => (
                  <tr key={i}>
                    <td>{d.singer}</td>
                    <td className="mono">{d.isrc}</td>
                    <td className="mono" style={{ color: "var(--muted)" }}>{d.key}</td>
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
