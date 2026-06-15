// Stage 7 — Extraction: choose a preset + optional columns, preview and export CSV.

export default function ExtractStep({
  preset, setPreset, presets, extractCols, extraOptions, extra, toggleExtra, fields, master, extract, csv,
}) {
  const labelOf = (k) => fields.find((f) => f.key === k)?.label || k;
  const previewRows = master.slice(0, 6);
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 7 — Extraction</div>
          <h1>Extract from Final Master Data</h1>
        </div>
        <button className="btn purple" disabled={!master.length} onClick={extract}>
          Extract {preset} · {master.length} records
        </button>
      </div>
      <p className="lede">
        Pick a preset, add any optional master columns, and export a CSV of the deduplicated master set. The Custom
        preset starts empty so you can build a column set from scratch.
      </p>

      <div className="card">
        <h2>Preset</h2>
        <div className="ch">PDL and SVF ship fixed column sets; Custom may be left empty.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12, marginTop: 6 }}>
          {Object.keys(presets).map((pk) => (
            <div key={pk} className={"preset" + (preset === pk ? " on" : "")} onClick={() => setPreset(pk)}>
              <div className="row">
                <div className="pt">{pk}</div>
                <span className="spacer"></span>
                {preset === pk && <span className="pill emerald">selected</span>}
              </div>
              <div className="pc">
                {presets[pk].length ? presets[pk].map(labelOf).join(" · ") : "No preset columns — add your own"}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Additional master columns</h2>
        <div className="ch">Optionally append any other available master column to the export.</div>
        <div className="chips">
          {extraOptions.length === 0 && <span className="pill slate">no extra columns available</span>}
          {extraOptions.map((f) => (
            <button
              key={f.key}
              className={"srcchip" + (extra.includes(f.key) ? " on" : "")}
              onClick={() => toggleExtra(f.key)}
            >
              {extra.includes(f.key) && "✓ "}
              {f.label}
              {f.dynamic && " ✦"}
            </button>
          ))}
        </div>
        <div className="legend" style={{ marginTop: 14 }}>
          <span><b>Export columns:</b></span>
          {extractCols.map((k) => <span key={k} className="pill purple">{labelOf(k)}</span>)}
          {extractCols.length === 0 && <span className="pill rose">none — pick a preset or add columns</span>}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Export preview</h2>
          <span className="spacer"></span>
          <span className="pill slate">{master.length} rows · {extractCols.length} cols</span>
        </div>
        {master.length === 0 ? (
          <div className="empty"><div className="e1">Master data is empty</div></div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>{extractCols.map((k) => <th key={k}>{labelOf(k)}</th>)}</tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r._id}>
                    {extractCols.map((k) => (
                      <td key={k} className={k === "isrc" ? "mono" : ""}>
                        {k === "isrc" ? r.isrcDisplay || r.isrc : r[k] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {master.length > 6 && (
          <div style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 8 }}>
            +{master.length - 6} more rows in the export…
          </div>
        )}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--purple)" }}>
            Show raw CSV (copy fallback)
          </summary>
          <textarea className="csv" readOnly value={csv} style={{ marginTop: 8 }} />
        </details>
      </div>
    </div>
  );
}
