/* ============================================================
   Branch Detail — upload sources, choose a primary key, run the
   cleanse, download/share the cleaned output. Reflects retention.
   ============================================================ */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import { api } from "../api/index.js";
import { Icon, LifecyclePill } from "../components/ui.jsx";
import { humanSize, fmtDate, expiryLabel, triggerDownload } from "../util.js";

const STEPS = ["Upload files", "Choose primary key", "Preset / columns"];
const REVIEW_PAGE = 50; // pairs fetched/rendered per page — keeps the DOM small at any scale

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
  const [review, setReview] = useState(null); // current page: { active, items, total, pending, ... }
  const [finalizing, setFinalizing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reviewOffset, setReviewOffset] = useState(0);
  const [reviewStatus, setReviewStatus] = useState("pending"); // "pending" | "all" | "resolved"
  const inputRef = useRef(null);

  const reload = useCallback(() => api.branches.files(branchId).then(setFiles).catch(() => setFiles([])), [branchId]);
  // Paged so the queue never ships 16k+ pairs at once (server renders only the slice).
  const loadReview = useCallback((opts) => {
    const o = opts || {};
    const offset = o.offset != null ? o.offset : reviewOffset;
    const status = o.status != null ? o.status : reviewStatus;
    return api.branches.review(branchId, { offset, limit: REVIEW_PAGE, status: status === "all" ? null : status })
      .then((r) => {
        // If a resolve emptied the tail page, step back so the operator isn't stranded.
        if (r.active && !(r.items || []).length && r.total > 0 && r.offset > 0) {
          const back = Math.max(0, r.total - REVIEW_PAGE);
          setReviewOffset(back);
          return loadReview({ offset: back, status });
        }
        setReview(r);
      })
      .catch(() => setReview({ active: false, items: [] }));
  }, [branchId, reviewOffset, reviewStatus]);
  useEffect(() => { reload(); loadReview(); }, [reload, loadReview]);

  function goReviewPage(offset) { setReviewOffset(offset); loadReview({ offset }); }
  function setReviewFilter(status) { setReviewStatus(status); setReviewOffset(0); loadReview({ offset: 0, status }); }

  const isActive = branch && branch.status === "active";
  const sources = useMemo(() => (files || []).filter((f) => f.kind === "source"), [files]);
  const cleaned = (files || []).find((f) => f.kind === "cleaned" && f.status === "available");
  const corrupted = (files || []).find((f) => f.kind === "corrupted" && f.status === "available");
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
    api.branches.clean(branchId, spec)
      .then((res) => Promise.all([reload(), loadReview()]).then(() => res))
      .then((res) => ctx.toast(res.status === "review"
        ? res.reviewCount.toLocaleString() + " record" + (res.reviewCount === 1 ? "" : "s") + " need review"
        : "Cleaned file produced."))
      .catch((err) => ctx.toast(err.message || "Cleaning failed.")).finally(() => setCleaning(false));
  }
  function resolveItem(itemId, body) {
    return api.branches.resolveReview(branchId, itemId, body)
      .then(() => ctx.toast(body.action === "delete" ? "Record deleted" : body.action === "fix" ? "Fix applied" : "Kept as-is"))
      .then(loadReview)
      .catch((err) => ctx.toast(err.message || "Could not save decision."));
  }
  function bulkResolve(body) {
    return api.branches.bulkResolveReview(branchId, body)
      .then((r) => { ctx.toast(r.resolved.toLocaleString() + " record" + (r.resolved === 1 ? "" : "s") + " resolved"); return loadReview(); })
      .catch((err) => ctx.toast(err.message || "Bulk action failed."));
  }
  // Raw bulk call (no toast/reload) — used by the chunked delete-all progress loop.
  function bulkRaw(body) { return api.branches.bulkResolveReview(branchId, body); }
  function doFinalize() {
    setFinalizing(true);
    api.branches.finalize(branchId).then(() => Promise.all([reload(), loadReview()]))
      .then(() => ctx.toast("Master list built."))
      .catch((err) => ctx.toast(err.message || "Finalize failed.")).finally(() => setFinalizing(false));
  }
  function doSkip() {
    setSkipping(true);
    api.branches.skip(branchId)
      .then((r) => Promise.all([reload(), loadReview()]).then(() => r))
      .then((r) => ctx.toast("Exported " + (r.cleanedCount || 0).toLocaleString() + " clean + " + (r.corruptedCount || 0).toLocaleString() + " corrupted rows"))
      .catch((err) => ctx.toast(err.message || "Export failed.")).finally(() => setSkipping(false));
  }
  function cancelReview() {
    api.branches.cancelReview(branchId).then(() => loadReview()).then(() => setStep(2))
      .catch((err) => ctx.toast(err.message || "Could not cancel review."));
  }
  function download(fileId) {
    api.files.signedUrl(fileId).then((r) => triggerDownload(r.url))
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

      {cleaned ? (
        /* Output exists → show downloads (sources are gone). */
        <div className="card pad" style={{ maxWidth: 560 }}>
          <div className="sectitle" style={{ marginTop: 0 }}>Cleaned output</div>
          <CleanedCard file={cleaned} download={download} />
          {corrupted ? (
            <>
              <div className="sectitle" style={{ marginTop: 20 }}>Corrupted rows (set aside)</div>
              <CleanedCard file={corrupted} download={download} tone="warn" />
            </>
          ) : null}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 14, marginBottom: 0 }}>
            Source files were removed after cleaning — only {corrupted ? "these outputs are" : "this output is"} retained{branch.visibility === "shared" ? " and shared with your team" : ""}.
          </p>
        </div>
      ) : isActive && review && review.active ? (
        <ReviewQueue key={reviewStatus + ":" + reviewOffset} review={review} resolveItem={resolveItem}
          bulkResolve={bulkResolve} bulkRaw={bulkRaw} reloadReview={loadReview}
          doFinalize={doFinalize} doSkip={doSkip} skipping={skipping}
          cancelReview={cancelReview} finalizing={finalizing}
          offset={reviewOffset} pageSize={REVIEW_PAGE} status={reviewStatus}
          goPage={goReviewPage} setFilter={setReviewFilter} />
      ) : !isActive ? (
        <div className="empty">No cleaned output is available for this branch.</div>
      ) : (
        <>
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

          {step === 1 ? (
            <PrimaryKeyStep
              parsed={parsed} common={common} colsBusy={colsBusy} primaryKey={primaryKey} setPrimaryKey={setPrimaryKey}
              back={() => setStep(0)} next={() => setStep(2)} />
          ) : step === 2 ? (
            <PresetStep
              presets={ctx.presets} allColumns={allColumns} primaryKey={primaryKey} pkLabel={displayMap[primaryKey] || primaryKey}
              presetSel={presetSel} setPresetSel={setPresetSel} customCols={customCols} setCustomCols={setCustomCols}
              runClean={runClean} cleaning={cleaning} download={download} back={() => setStep(1)} />
          ) : (
            <div>
              <div className="between" style={{ marginBottom: 12 }}>
                <div className="sectitle" style={{ margin: 0 }}>Source files{branchType ? " · " + branchType.toUpperCase() : ""}</div>
                <input ref={inputRef} type="file" accept=".csv,.xlsx" multiple style={{ display: "none" }} onChange={onPick} />
                <button className="btn pri sm" disabled={busy} onClick={pick}><Icon name="upload" size={14} />{busy ? "Uploading…" : "Add files"}</button>
              </div>
              <div className="criteria" style={{ marginBottom: 12 }}>
                <span className="crit"><Icon name="doc" size={14} />CSV or Excel (.xlsx)</span>
                <span className="crit"><Icon name="table" size={14} />One file type per branch</span>
                <span className="crit"><Icon name="upload" size={14} />One by one or many at once</span>
              </div>
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
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No source files yet — upload your catalog files to begin.</div>
              )}

              <div style={{ marginTop: 20, display: "flex", gap: 10, alignItems: "center" }}>
                <button className="btn pri" disabled={!sources.length || busy || colsBusy} onClick={() => setStep(1)}>
                  Next: choose primary key →
                </button>
                <span className="muted" style={{ fontSize: 13 }}>
                  {!sources.length ? "Upload at least one file" : colsBusy ? "Reading columns…" : sources.length + " file" + (sources.length > 1 ? "s" : "") + " ready"}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CleanedCard({ file, download, tone }) {
  const warn = tone === "warn";
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="av" style={{ width: 34, height: 34, borderRadius: 9, background: warn ? "var(--danger-soft)" : "var(--accent-soft)", color: warn ? "var(--danger-ink)" : "var(--accent-ink)" }}>
          <Icon name={warn ? "alert" : "sparkle"} size={17} />
        </span>
        <div>
          <div style={{ fontWeight: 600 }}>{file.originalFilename || "output.xlsx"}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{humanSize(file.sizeBytes)} · built {fmtDate(file.createdAt)}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className={"btn sm " + (warn ? "" : "pri")} onClick={() => download(file.id)}><Icon name="download" size={14} />Download</button>
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

function PresetStep({ presets, allColumns, primaryKey, pkLabel, presetSel, setPresetSel, customCols, setCustomCols, runClean, cleaning, back }) {
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
          <Icon name="pipeline" size={16} />{cleaning ? "Cleaning…" : "Run cleaning →"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          {!primaryKey ? "No primary key" : isCustom ? customCols.length + " extra column" + (customCols.length === 1 ? "" : "s") + " selected"
            : selPreset ? "Preset: " + selPreset.name : "Choose a preset or Custom"}
        </span>
      </div>
    </div>
  );
}

function actionLabel(action) {
  if (action === "fix") return "fixed";
  if (action === "dismiss") return "kept as-is";
  if (action === "delete") return "deleted";
  return action || "";
}

const ISSUE_LABEL = { garbled: "garbled text", garbage: "junk value", conflict: "conflicting value" };

function ReviewQueue({ review, resolveItem, bulkResolve, bulkRaw, reloadReview, doFinalize, doSkip, skipping, cancelReview, finalizing, offset, pageSize, status, goPage, setFilter }) {
  const items = review.items || [];
  const total = review.total != null ? review.total : items.length;        // pairs in the current filter
  const pending = review.pending != null ? review.pending : 0;             // pending across the whole queue
  const resolved = review.resolved != null ? review.resolved : 0;
  const flagged = pending + resolved;                                      // total flagged, all statuses
  const lastOffset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + pageSize, total);

  const [sel, setSel] = useState(() => new Set()); // selected item ids on this page
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null); // { label, done, total } during a long delete
  const selectable = items.filter((it) => it.status !== "resolved");
  const allSel = selectable.length > 0 && selectable.every((it) => sel.has(it.id));
  function toggle(id) { setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSel(allSel ? new Set() : new Set(selectable.map((i) => i.id))); }
  function bulk(action, allPending) {
    const ids = Array.from(sel);
    if (!allPending && !ids.length) return;
    setBusy(true);
    bulkResolve(allPending ? { all_pending: true, action } : { ids, action })
      .then(() => setSel(new Set())).finally(() => setBusy(false));
  }
  // Delete every pending record in chunks, driving a progress bar (handles 100k+).
  async function deleteAll() {
    const tot = pending;
    if (!tot) return;
    setBusy(true);
    setProg({ label: "Deleting all flagged records", done: 0, total: tot });
    let remaining = tot;
    try {
      while (remaining > 0) {
        const r = await bulkRaw({ all_pending: true, action: "delete", limit: 1000 });
        const next = r && r.pending != null ? r.pending : 0;
        if (next >= remaining) break;            // safety: no progress → stop
        remaining = next;
        setProg({ label: "Deleting all flagged records", done: tot - remaining, total: tot });
      }
    } finally {
      setProg(null); setSel(new Set()); setBusy(false); reloadReview();
    }
  }
  // Delete just the pending records shown on this page.
  function deletePage() {
    const ids = selectable.map((it) => it.id);
    if (!ids.length) return;
    setBusy(true);
    setProg({ label: "Deleting this page", done: 0, total: ids.length });
    bulkRaw({ ids, action: "delete" })
      .then(() => setProg({ label: "Deleting this page", done: ids.length, total: ids.length }))
      .finally(() => { setProg(null); setSel(new Set()); setBusy(false); reloadReview(); });
  }

  const tab = (key, label, n) => (
    <button className={"btn sm" + (status === key ? " pri" : " ghost")} onClick={() => setFilter(key)}>
      {label}{n != null ? " · " + n.toLocaleString() : ""}
    </button>
  );

  if (review.stale) {
    return (
      <div>
        <div className="errbanner" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={16} />
          <div>
            <div className="t">Outdated review</div>
            <div className="d">This review was produced by an older version of the cleanser (duplicate pairs). Re-run cleaning to use the new corruption review.</div>
          </div>
        </div>
        <button className="btn pri" onClick={cancelReview}>Discard &amp; re-run cleaning</button>
      </div>
    );
  }

  return (
    <div>
      <p style={{ maxWidth: 760, marginTop: -6 }}>
        Duplicates were merged automatically on the primary key and spelling was standardized.
        Only records with <b>heavy corruption</b> — garbled text, or a key that carries a contradictory
        song/artist — are left here. <b>Apply</b> the suggested fix, edit it by hand, or <b>dismiss</b> to keep
        the value as-is. Tick the boxes to act on many at once.
      </p>
      <div className="pk-note">
        <Icon name="alert" size={16} />
        <span>{flagged.toLocaleString()} record{flagged === 1 ? "" : "s"} flagged · {pending.toLocaleString()} still pending</span>
      </div>

      <div className="row" style={{ gap: 8, margin: "12px 0", flexWrap: "wrap", alignItems: "center" }}>
        {tab("pending", "Pending", pending)}
        {tab("all", "All", flagged)}
        {tab("resolved", "Resolved", resolved)}
        {selectable.length ? (
          <label className="row" style={{ gap: 6, marginLeft: 6, fontSize: 13, color: "var(--ink-2)", cursor: "pointer" }}>
            <input type="checkbox" checked={allSel} onChange={toggleAll} /> Select page
          </label>
        ) : null}
      </div>

      {/* Bulk delete + the download alternative to reviewing on screen. */}
      <div className="row" style={{ gap: 8, margin: "0 0 14px", flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn danger sm" disabled={busy || !selectable.length} onClick={deletePage}>Delete this page</button>
        <button className="btn danger sm" disabled={busy || !pending} onClick={deleteAll}>Delete all {pending.toLocaleString()}</button>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={skipping || busy} onClick={doSkip} title="Don't review here — export clean + corrupted rows as Excel">
          <Icon name="download" size={14} />{skipping ? "Exporting…" : "Skip & download as Excel"}
        </button>
      </div>

      {prog ? (
        <div className="progress-wrap">
          <div className="progress-head"><span>{prog.label}…</span><span className="mono">{prog.done.toLocaleString()} / {prog.total.toLocaleString()}</span></div>
          <div className="progress"><i style={{ width: (prog.total ? Math.round((100 * prog.done) / prog.total) : 100) + "%" }} /></div>
        </div>
      ) : null}

      {sel.size ? (
        <div className="bulkbar">
          <span className="bb-count"><b>{sel.size}</b> selected</span>
          <button className="btn sm" disabled={busy} onClick={() => bulk("accept")}>Apply suggested fixes</button>
          <button className="btn sm" disabled={busy} onClick={() => bulk("dismiss")}>Dismiss · keep as-is</button>
          <button className="btn danger sm" disabled={busy} onClick={() => bulk("delete")}>Delete {sel.size} record{sel.size === 1 ? "" : "s"}</button>
          <button className="btn ghost sm" disabled={busy} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      ) : null}

      {items.length ? items.map((it) => (
        <ReviewItem key={it.id} item={it} columns={review.columns} pkDisplay={review.pkDisplay}
          onResolve={resolveItem} selected={sel.has(it.id)} onToggle={() => toggle(it.id)} />
      )) : (
        <div className="empty">{status === "pending" ? "No pending records — everything here is resolved." : "Nothing to show in this view."}</div>
      )}

      {total > pageSize ? (
        <div className="row" style={{ gap: 10, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn ghost sm" disabled={offset <= 0} onClick={() => goPage(0)}>« First</button>
          <button className="btn ghost sm" disabled={offset <= 0} onClick={() => goPage(Math.max(0, offset - pageSize))}>‹ Prev</button>
          <span className="muted" style={{ fontSize: 13 }}>{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
          <button className="btn ghost sm" disabled={offset >= lastOffset} onClick={() => goPage(offset + pageSize)}>Next ›</button>
          <button className="btn ghost sm" disabled={offset >= lastOffset} onClick={() => goPage(lastOffset)}>Last »</button>
        </div>
      ) : null}

      <div style={{ marginTop: 22, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn ghost" onClick={cancelReview}>← Cancel &amp; edit</button>
        <button className="btn pri" disabled={finalizing} onClick={doFinalize}>
          <Icon name="sparkle" size={16} />{finalizing ? "Building…" : "Build master &amp; finish →"}
        </button>
        {pending ? (
          <button className="btn sm" disabled={busy} onClick={() => bulk("dismiss", true)} title="Dismiss every pending record (keep values as-is)">
            Dismiss all {pending.toLocaleString()}
          </button>
        ) : null}
        <span className="muted" style={{ fontSize: 13 }}>{pending ? pending.toLocaleString() + " pending → kept as-is" : "All resolved"}</span>
      </div>
    </div>
  );
}

function ReviewItem({ item, columns, pkDisplay, onResolve, selected, onToggle }) {
  const resolved = item.status === "resolved";
  const cell = { padding: "6px 10px", borderTop: "1px solid var(--line)", fontSize: 13.5, verticalAlign: "top" };
  // Map flagged field → its issue (suggestion etc.).
  const byField = {};
  (item.issues || []).forEach((i) => { byField[i.field] = i; });
  // Suggested fixes the "Apply" button would write (issues that carry a suggestion).
  const suggestions = (item.issues || []).filter((i) => i.suggestion);

  // Edit mode seeds from current values, pre-filling suggestions for flagged fields.
  const [edit, setEdit] = useState(null); // { [col]: value } or null
  function startEdit() {
    const seed = {};
    columns.forEach((c) => { seed[c] = byField[c] && byField[c].suggestion ? byField[c].suggestion : (item.values[c] || ""); });
    setEdit(seed);
  }
  function saveEdit() {
    const fixes = {};
    columns.forEach((c) => { if (c !== pkDisplay && (edit[c] || "") !== (item.values[c] || "")) fixes[c] = edit[c] || ""; });
    onResolve(item.id, { action: "fix", fixes }).then(() => setEdit(null));
  }
  function applySuggestions() {
    const fixes = {};
    suggestions.forEach((i) => { if (i.field !== pkDisplay) fixes[i.field] = i.suggestion; });
    onResolve(item.id, { action: "fix", fixes });
  }

  return (
    <div className={"filecols" + (selected ? " sel" : "")} style={{ opacity: resolved ? 0.62 : 1 }}>
      <div className="fch">
        {!resolved && onToggle ? (
          <input type="checkbox" checked={!!selected} onChange={onToggle} title="Select for bulk action"
            style={{ marginRight: 2, cursor: "pointer" }} />
        ) : null}
        <Icon name="alert" size={14} style={{ color: "var(--accent-ink)" }} />
        <span className="fn">{item.pk}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          · {(item.issues || []).map((i) => i.field + " (" + (ISSUE_LABEL[i.kind] || i.kind) + ")").join(", ")}
        </span>
        {resolved ? <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>Resolved · {actionLabel(item.action)}</span> : null}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
        <thead>
          <tr style={{ textAlign: "left", fontSize: 12, color: "var(--ink-3)" }}>
            <th style={{ padding: "2px 10px", width: "24%" }}>Field</th>
            <th style={{ padding: "2px 10px" }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => {
            const issue = byField[c];
            const bg = issue ? "var(--accent-soft)" : "transparent";
            return (
              <tr key={c}>
                <td style={{ ...cell, color: "var(--ink-3)" }}>{c}</td>
                <td style={{ ...cell, background: bg }}>
                  {edit && c !== pkDisplay ? (
                    <input className="miniinput" value={edit[c] || ""}
                      onChange={(e) => setEdit((m) => ({ ...m, [c]: e.target.value }))} />
                  ) : (
                    <>
                      <span>{item.values[c] || <span className="muted">—</span>}</span>
                      {issue && issue.suggestion && !resolved ? (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>→ suggest: <b style={{ color: "var(--accent-ink)" }}>{issue.suggestion}</b></span>
                      ) : null}
                      {issue && issue.alternates && issue.alternates.length && !resolved ? (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>vs {issue.alternates.join(" · ")}</span>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!resolved ? (
        edit ? (
          <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Editing values</span>
            <button className="btn pri sm" onClick={saveEdit}>Save fix</button>
            <button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {suggestions.length ? <button className="btn sm" onClick={applySuggestions}>Apply suggested fix</button> : null}
            <button className="btn sm" onClick={startEdit}>Fix manually…</button>
            <button className="btn ghost sm" onClick={() => onResolve(item.id, { action: "dismiss" })}>Dismiss · keep as-is</button>
            <button className="btn danger sm" onClick={() => onResolve(item.id, { action: "delete" })}>Delete record</button>
          </div>
        )
      ) : null}
    </div>
  );
}
