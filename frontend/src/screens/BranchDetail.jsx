/* ============================================================
   Branch Detail — upload sources, choose a primary key, run the
   cleanse, download/share the cleaned output. Reflects retention.
   ============================================================ */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import { api } from "../api/index.js";
import { Icon, LifecyclePill } from "../components/ui.jsx";
import { humanSize, fmtDate, expiryLabel } from "../util.js";

const STEPS = ["Upload files", "Choose primary key", "Preset / columns"];

// Match columns case-insensitively so "ISRC"/"isrc" or "Go Live Date"/"Go live date"
// count as the same column across files.
function norm(s) { return String(s).trim().toLowerCase().replace(/\s+/g, " "); }

function extOf(name) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".xlsx")) return "xlsx";
  return null;
}

// Headers of the first sheet — works for both CSV and XLSX array buffers.
function columnsFromBuffer(buf) {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  return (rows[0] || []).map((c) => String(c).trim()).filter(Boolean);
}

export function BranchDetail({ ctx, branchId }) {
  const branch = ctx.branches.find((b) => b.id === branchId);
  const [files, setFiles] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [step, setStep] = useState(0);
  const [cols, setCols] = useState({}); // fileId -> { columns: [...], error }
  const [colsBusy, setColsBusy] = useState(false);
  const [primaryKey, setPrimaryKey] = useState(null);
  const [presetSel, setPresetSel] = useState(null); // preset id, or "custom"
  const [customCols, setCustomCols] = useState([]); // normalized column names (besides the pk)
  const inputRef = useRef(null);

  const reload = useCallback(() => api.branches.files(branchId).then(setFiles).catch(() => setFiles([])), [branchId]);
  useEffect(() => { reload(); }, [reload]);

  const isActive = branch && branch.status === "active";
  const sources = useMemo(() => (files || []).filter((f) => f.kind === "source"), [files]);
  const cleaned = (files || []).find((f) => f.kind === "cleaned" && f.status === "available");
  const branchType = sources.length ? extOf(sources[0].originalFilename) : null;

  // Resolve columns for any source we haven't parsed yet (e.g. after a reload) by
  // streaming the file back and reading its headers in the browser.
  useEffect(() => {
    let on = true;
    const missing = sources.filter((f) => !cols[f.id]);
    if (!missing.length) return;
    setColsBusy(true);
    Promise.all(
      missing.map((f) =>
        api.files.signedUrl(f.id)
          .then((r) => fetch(r.url))
          .then((res) => res.arrayBuffer())
          .then((buf) => ({ id: f.id, columns: columnsFromBuffer(buf), error: null }))
          .catch(() => ({ id: f.id, columns: [], error: "Could not read columns." }))
      )
    ).then((results) => {
      if (!on) return;
      setCols((m) => { const next = { ...m }; results.forEach((r) => { next[r.id] = { columns: r.columns, error: r.error }; }); return next; });
    }).finally(() => { if (on) setColsBusy(false); });
    return () => { on = false; };
  }, [sources, cols]);

  const parsed = sources.map((f) => ({ file: f, ...(cols[f.id] || { columns: [], error: null }) })).filter((p) => p.columns.length && !p.error);
  // Common columns, compared by normalized name (lowercase/trim).
  const common = useMemo(() => {
    if (!parsed.length) return [];
    let set = parsed[0].columns.map(norm);
    parsed.slice(1).forEach((p) => { const n = p.columns.map(norm); set = set.filter((c) => n.indexOf(c) >= 0); });
    return Array.from(new Set(set));
  }, [parsed.map((p) => p.file.id + ":" + p.columns.join(",")).join("|")]);

  useEffect(() => {
    if (primaryKey && common.indexOf(primaryKey) >= 0) return;
    setPrimaryKey(common.indexOf("isrc") >= 0 ? "isrc" : common[0] || null);
  }, [common.join(",")]);

  // Union of all columns across files: normalized name -> representative original label.
  const displayMap = useMemo(() => {
    const m = {};
    parsed.forEach((p) => p.columns.forEach((c) => { const n = norm(c); if (!m[n]) m[n] = c; }));
    return m;
  }, [parsed.map((p) => p.columns.join(",")).join("|")]);
  const allColumns = useMemo(() => Object.keys(displayMap).map((n) => ({ norm: n, label: displayMap[n] })), [displayMap]);

  if (!branch) return <div className="page"><div className="empty">Branch not found.</div></div>;

  function pick() { if (inputRef.current) inputRef.current.click(); }
  function onPick(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;

    // Same-type enforcement: CSV or XLSX, and matching what's already in the branch.
    const want = branchType || extOf(list[0].name);
    for (const f of list) {
      const t = extOf(f.name);
      if (!t) { ctx.toast(`"${f.name}" is not a CSV or Excel (.xlsx) file.`); return; }
      if (t !== want) { ctx.toast(`All files must be ${want.toUpperCase()} — "${f.name}" doesn't match.`); return; }
    }

    setBusy(true);
    list.reduce((chain, file) => chain.then(() =>
      api.branches.uploadSource(branchId, file).then((row) =>
        file.arrayBuffer()
          .then((buf) => ({ columns: columnsFromBuffer(buf), error: null }))
          .catch(() => ({ columns: [], error: "Could not read columns." }))
          .then((c) => setCols((m) => ({ ...m, [row.id]: c })))
      )
    ), Promise.resolve())
      .then(reload).catch((err) => ctx.toast(err.message || "Upload failed."))
      .finally(() => setBusy(false));
  }
  function runClean(spec) {
    setCleaning(true);
    api.branches.clean(branchId, spec).then(reload).then(() => ctx.toast("Cleaned file produced."))
      .catch((err) => ctx.toast(err.message || "Cleaning failed.")).finally(() => setCleaning(false));
  }
  function download(fileId) {
    api.files.signedUrl(fileId).then((r) => { window.open(r.url, "_blank"); })
      .catch((err) => ctx.toast(err.message || "Download failed."));
  }
  function toggleVisibility() {
    const next = branch.visibility === "shared" ? "private" : "shared";
    api.branches.update(branchId, { visibility: next }).then((b) => { ctx.patchBranch(b); ctx.toast(next === "shared" ? "Branch shared." : "Branch set to private."); })
      .catch((err) => ctx.toast(err.message || "Update failed."));
  }
  function del() {
    ctx.deleteBranch(branchId).then(() => ctx.go("dashboard")).catch((err) => ctx.toast(err.message || "Delete failed."));
  }

  return (
    <div className="page wide fade">
      <button className="btn ghost sm" style={{ marginBottom: 14 }} onClick={() => ctx.go("dashboard")}>← Branches</button>

      <div className="page-head between">
        <div>
          <div className="ey">Branch</div>
          <h1>{branch.name}</h1>
          <div className="row" style={{ gap: 10, marginTop: 6, alignItems: "center", fontSize: 13, color: "var(--ink-3)" }}>
            <LifecyclePill status={branch.status} />
            <Icon name={branch.visibility === "shared" ? "globe" : "lock"} size={14} />
            <span>{branch.visibility === "shared" ? "Shared" : "Private"}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <Icon name="clock" size={14} /><span>{expiryLabel(branch)}</span>
          </div>
        </div>
        {isActive ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={toggleVisibility}>
              <Icon name={branch.visibility === "shared" ? "lock" : "globe"} size={15} />
              {branch.visibility === "shared" ? "Make private" : "Share"}
            </button>
            <button className="btn danger" onClick={del}><Icon name="trash" size={15} />Delete</button>
          </div>
        ) : null}
      </div>

      {!isActive ? (
        <div className="ro-banner" style={{ marginBottom: 18 }}>
          <Icon name="lock" size={16} className="ic" />
          <span>This branch is <b>{branch.status}</b> — read-only. {branch.purgedAt ? "Its files have been purged from storage." : "Its files will be purged after expiry."}</span>
        </div>
      ) : null}

      {isActive ? (
        <div className="wizard-steps" style={{ marginBottom: 22 }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={i}>
              <div className={"wstep " + (step === i ? "active" : step > i ? "done" : "")}>
                <span className="wn">{step > i ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="wl">{s}</span>
              </div>
              {i < STEPS.length - 1 ? <span className={"wbar" + (step > i ? " done" : "")} style={{ display: "inline-block" }} /> : null}
            </React.Fragment>
          ))}
        </div>
      ) : null}

      {isActive && step === 1 ? (
        <PrimaryKeyStep
          parsed={parsed} common={common} colsBusy={colsBusy} primaryKey={primaryKey} setPrimaryKey={setPrimaryKey}
          back={() => setStep(0)} next={() => setStep(2)} />
      ) : isActive && step === 2 ? (
        <PresetStep
          presets={ctx.presets} allColumns={allColumns} primaryKey={primaryKey} pkLabel={displayMap[primaryKey] || primaryKey}
          presetSel={presetSel} setPresetSel={setPresetSel} customCols={customCols} setCustomCols={setCustomCols}
          runClean={runClean} cleaning={cleaning} cleaned={cleaned} download={download} back={() => setStep(1)} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 22, alignItems: "start" }}>
          {/* sources */}
          <div>
            <div className="between" style={{ marginBottom: 12 }}>
              <div className="sectitle" style={{ margin: 0 }}>Source files{branchType ? " · " + branchType.toUpperCase() : ""}</div>
              {isActive ? (
                <>
                  <input ref={inputRef} type="file" accept=".csv,.xlsx" multiple style={{ display: "none" }} onChange={onPick} />
                  <button className="btn pri sm" disabled={busy} onClick={pick}><Icon name="upload" size={14} />{busy ? "Uploading…" : "Add files"}</button>
                </>
              ) : null}
            </div>
            {isActive ? (
              <div className="criteria" style={{ marginBottom: 12 }}>
                <span className="crit"><Icon name="doc" size={14} />CSV or Excel (.xlsx)</span>
                <span className="crit"><Icon name="table" size={14} />One file type per branch</span>
                <span className="crit"><Icon name="upload" size={14} />One by one or many at once</span>
              </div>
            ) : null}
            {files === null ? (
              <div className="empty">Loading files…</div>
            ) : sources.length ? (
              <div className="card filelist">
                {sources.map((f) => {
                  const c = cols[f.id];
                  return (
                    <div className="fileitem" key={f.id}>
                      <Icon name="doc" size={16} style={{ color: "var(--ink-3)" }} />
                      <span className="fn">{f.originalFilename || ("source-" + f.id)}</span>
                      <span className="sz">{humanSize(f.sizeBytes)}{c && c.columns.length ? " · " + c.columns.length + " cols" : ""}</span>
                      {f.status === "available" ? (
                        <button className="btn ghost sm" onClick={() => download(f.id)}><Icon name="download" size={13} />Download</button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty">No source files yet{isActive ? " — upload your catalog files to begin." : "."}</div>
            )}

            {isActive ? (
              <div style={{ marginTop: 20, display: "flex", gap: 10, alignItems: "center" }}>
                <button className="btn pri" disabled={!sources.length || busy || colsBusy} onClick={() => setStep(1)}>
                  Next: choose primary key →
                </button>
                <span className="muted" style={{ fontSize: 13 }}>
                  {!sources.length ? "Upload at least one file" : colsBusy ? "Reading columns…" : sources.length + " file" + (sources.length > 1 ? "s" : "") + " ready"}
                </span>
              </div>
            ) : null}
          </div>

          {/* cleaned (read-only branches still show the output) */}
          <div>
            <div className="sectitle">Cleaned output</div>
            <div className="card pad">
              {cleaned ? (
                <CleanedCard cleaned={cleaned} download={download} isActive={isActive} cleaning={cleaning} onRerun={() => setStep(1)} />
              ) : (
                <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
                  No cleaned output yet. Upload your sources, choose a primary key, then run cleaning.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CleanedCard({ cleaned, download, isActive, cleaning, onRerun }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="av" style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent-ink)" }}>
          <Icon name="sparkle" size={17} />
        </span>
        <div>
          <div style={{ fontWeight: 600 }}>{cleaned.originalFilename || "cleaned.csv"}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{humanSize(cleaned.sizeBytes)} · built {fmtDate(cleaned.createdAt)}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn pri sm" onClick={() => download(cleaned.id)}><Icon name="download" size={14} />Download</button>
        {isActive ? <button className="btn ghost sm" disabled={cleaning} onClick={onRerun}><Icon name="refresh" size={14} />Re-run</button> : null}
      </div>
    </div>
  );
}

function PrimaryKeyStep({ parsed, common, colsBusy, primaryKey, setPrimaryKey, back, next }) {
  return (
    <div>
      <p style={{ maxWidth: 720, marginTop: -6 }}>
        Pick the one column present in every uploaded file. It becomes the <b>primary key</b> used to link and merge
        rows across files. Columns common to all files are <b>highlighted</b> and selectable.
      </p>

      {colsBusy ? (
        <div className="pk-note"><div className="spin" /><span>Reading columns from your files…</span></div>
      ) : !parsed.length ? (
        <div className="errbanner" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={16} />
          <div><div className="t">No readable columns</div><div className="d">Couldn't read headers from the uploaded files. Go back and re-check them.</div></div>
        </div>
      ) : common.length ? (
        <div className="pk-note">
          <Icon name="check" size={16} />
          <span>{common.length + " column" + (common.length > 1 ? "s are" : " is") + " common to all " + parsed.length + " file" + (parsed.length > 1 ? "s" : "") + ". Highlighted columns are selectable."}</span>
        </div>
      ) : (
        <div className="errbanner" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={16} />
          <div><div className="t">No shared column</div><div className="d">These files have no column name in common, so they can't be merged. Go back and check your files.</div></div>
        </div>
      )}

      {parsed.map((p) => (
        <div className="filecols" key={p.file.id}>
          <div className="fch">
            <Icon name="doc" size={14} style={{ color: "var(--ink-3)" }} />
            <span className="fn">{p.file.originalFilename || ("source-" + p.file.id)}</span>
            <span className="muted" style={{ marginLeft: "auto", fontSize: 11.5, fontFamily: "var(--mono)" }}>{p.columns.length + " cols"}</span>
          </div>
          <div className="colchips">
            {p.columns.map((c) => {
              const isCommon = common.indexOf(norm(c)) >= 0;
              const isSel = primaryKey === norm(c);
              return (
                <span key={c} className={"colchip" + (isCommon ? " common" : "") + (isSel ? " sel" : "")}
                  onClick={isCommon ? () => setPrimaryKey(norm(c)) : undefined}>
                  {isSel ? <span className="pkdot">● </span> : null}{c}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 22, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn ghost" onClick={back}>← Back</button>
        <button className="btn pri" disabled={!primaryKey} onClick={next}>Next: preset / columns →</button>
        {primaryKey ? (
          <span className="muted" style={{ fontSize: 13 }}>Primary key: <b className="mono" style={{ color: "var(--accent-ink)" }}>{primaryKey}</b></span>
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>Select a common column to continue</span>
        )}
      </div>
    </div>
  );
}

function PresetStep({ presets, allColumns, primaryKey, pkLabel, presetSel, setPresetSel, customCols, setCustomCols, runClean, cleaning, cleaned, download, back }) {
  const isCustom = presetSel === "custom";
  const selPreset = !isCustom ? (presets || []).find((p) => p.id === presetSel) : null;
  const presetCols = (selPreset && selPreset.config && selPreset.config.columns) || [];
  const presetRules = (selPreset && selPreset.config && selPreset.config.rules) || [];
  const extras = allColumns.filter((c) => c.norm !== primaryKey);
  const canRun = primaryKey && (isCustom ? customCols.length > 0 : !!selPreset);

  function toggle(n) { setCustomCols((l) => (l.indexOf(n) >= 0 ? l.filter((x) => x !== n) : l.concat([n]))); }
  function start() {
    if (isCustom) {
      const labels = customCols.map((n) => (allColumns.find((c) => c.norm === n) || {}).label || n);
      runClean({ primaryKey, columns: labels });
    } else {
      runClean({ primaryKey, presetId: presetSel });
    }
  }

  return (
    <div>
      <p style={{ maxWidth: 720, marginTop: -6 }}>
        Choose a <b>preset</b> for a ready-made output column set and rules, or build a <b>custom</b> output by
        hand-picking columns. Your primary key <b className="mono" style={{ color: "var(--accent-ink)" }}>{pkLabel}</b> is
        always the first output column.
      </p>

      <div className="preset-grid">
        {(presets || []).map((p) => {
          const cust = norm(p.name) === "custom";
          const active = cust ? isCustom : presetSel === p.id;
          return (
            <button key={p.id} className={"preset" + (active ? " sel" : "") + (cust ? " custom" : "")}
              onClick={() => setPresetSel(cust ? "custom" : p.id)}>
              <div className="pt">{cust ? "Build your own" : (p.config && p.config.tag) || "Preset"}</div>
              <h4>{p.name}</h4>
              <p>{cust ? "Hand-pick the output columns from your files." : (p.config && p.config.desc) || ""}</p>
            </button>
          );
        })}
      </div>

      {selPreset ? (
        <div className="preset-detail">
          <div className="card pad">
            <div className="sectitle">Output columns</div>
            <div className="coltrack">
              <span className="c pk">{pkLabel} · key</span>
              {presetCols.map((c) => <span className="c" key={c}>{c}</span>)}
            </div>
          </div>
          {presetRules.length ? (
            <div className="card pad">
              <div className="sectitle">Cleaning rules</div>
              <ul className="bullets" style={{ margin: 0 }}>{presetRules.map((r, i) => <li key={i} style={{ fontSize: 13.5 }}>{r}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : isCustom ? (
        <div className="card pad" style={{ marginTop: 18 }}>
          <div className="sectitle" style={{ marginTop: 0 }}>Custom output columns</div>
          <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>Your primary key is always included. Pick the other columns you want from the files.</p>
          <div className="coltrack" style={{ marginBottom: 14 }}>
            <span className="c pk">{pkLabel} · key · locked</span>
            {customCols.map((n) => { const c = allColumns.find((x) => x.norm === n); return <span className="c" key={n}>{c ? c.label : n}</span>; })}
          </div>
          <div className="sectitle">Available columns</div>
          <div className="cust-add">
            {extras.length ? extras.map((c) => {
              const on = customCols.indexOf(c.norm) >= 0;
              return (
                <button key={c.norm} className="ca" onClick={() => toggle(c.norm)}
                  style={on ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent-ink)" } : undefined}>
                  {(on ? "✓ " : "+ ") + c.label}
                </button>
              );
            }) : <span className="muted" style={{ fontSize: 13 }}>No other columns found in the files.</span>}
          </div>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>Select a preset or “Custom” to continue.</div>
      )}

      <div style={{ marginTop: 24, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn ghost" onClick={back}>← Back</button>
        <button className="btn pri" disabled={!canRun || cleaning} onClick={start}>
          <Icon name="pipeline" size={16} />{cleaning ? "Cleaning…" : cleaned ? "Re-run cleaning →" : "Run cleaning →"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          {!primaryKey ? "No primary key" : isCustom ? customCols.length + " extra column" + (customCols.length === 1 ? "" : "s") + " selected"
            : selPreset ? "Preset: " + selPreset.name : "Choose a preset or Custom"}
        </span>
      </div>

      {cleaned ? (
        <div className="card pad" style={{ marginTop: 22, maxWidth: 460 }}>
          <div className="sectitle" style={{ marginTop: 0 }}>Cleaned output</div>
          <CleanedCard cleaned={cleaned} download={download} isActive cleaning={cleaning} onRerun={start} />
        </div>
      ) : null}
    </div>
  );
}
