// Stage 2 — Column mapping: bind source headers to master fields (many-to-one),
// and promote leftover columns into new dynamic master columns. Suggestions
// (dashed chips) come from the backend's auto-map at ingest time.

export default function MappingStep({
  fields, headers, mapping, suggestions, toggleMap, unmapped, addColumn, requiredMapped, next,
}) {
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 2 — Column mapping</div>
          <h1>Map source columns to master fields</h1>
        </div>
        <button className="btn" disabled={!requiredMapped} onClick={next}>Continue to cleaning →</button>
      </div>
      <p className="lede">
        Pick which source column(s) feed each master field. Several sources can feed one field — e.g. <b>Artist</b> +{" "}
        <b>Performer</b> → <b>Singer Name</b>, merged at clean time. All eight builtin fields must be mapped to continue.
      </p>

      <div className="card">
        <h2>Master fields</h2>
        <div className="ch">Dashed chips are auto-suggested from header names. Click to map / unmap.</div>
        {fields.map((f) => {
          const sel = mapping[f.key] || [];
          const sug = suggestions[f.key] || [];
          return (
            <div className="maprow" key={f.key}>
              <div>
                <div className="mflabel">
                  {f.label}
                  {f.dynamic && <span className="pill amber" style={{ marginLeft: 7 }}>new</span>}
                </div>
                <div className="mfsub">{f.sub}{!f.dynamic && " · required"}</div>
              </div>
              <div className="chips">
                {headers.map((h) => {
                  const on = sel.includes(h);
                  const suggested = sug.includes(h);
                  return (
                    <button
                      key={h}
                      className={"srcchip" + (on ? " on" : "") + (suggested ? " suggested" : "")}
                      onClick={() => toggleMap(f.key, h)}
                    >
                      {on && "✓ "}
                      {h}
                    </button>
                  );
                })}
                {sel.length === 0 && <span className="pill rose">unmapped</span>}
              </div>
            </div>
          );
        })}
      </div>

      {unmapped.length > 0 && (
        <div className="card">
          <h2>Unmapped source columns</h2>
          <div className="ch">
            These aren’t feeding any field. Add one as a new master column — it’s created in the master store and mapped
            here. Existing master rows stay empty for it.
          </div>
          <div className="chips">
            {unmapped.map((h) => (
              <span key={h} className="srcchip">
                {h}
                <button className="btn purple sm" style={{ marginLeft: 6 }} onClick={() => addColumn(h)}>
                  + create column
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
