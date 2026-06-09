/* ============================================================
   Branch Detail — upload sources, run the cleanse, download/share
   the cleaned output. Reflects the retention lifecycle.
   ============================================================ */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/index.js";
import { Icon, LifecyclePill } from "../components/ui.jsx";
import { humanSize, fmtDate, expiryLabel } from "../util.js";

export function BranchDetail({ ctx, branchId }) {
  const branch = ctx.branches.find((b) => b.id === branchId);
  const [files, setFiles] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const inputRef = useRef(null);

  const reload = useCallback(() => api.branches.files(branchId).then(setFiles).catch(() => setFiles([])), [branchId]);
  useEffect(() => { reload(); }, [reload]);

  if (!branch) return <div className="page"><div className="empty">Branch not found.</div></div>;

  const isActive = branch.status === "active";
  const sources = (files || []).filter((f) => f.kind === "source");
  const cleaned = (files || []).find((f) => f.kind === "cleaned" && f.status === "available");
  const presetName = (() => { const p = ctx.presets.find((x) => x.id === branch.presetId); return p ? p.name : "No preset"; })();

  function pick() { if (inputRef.current) inputRef.current.click(); }
  function onPick(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;
    setBusy(true);
    list.reduce((chain, file) => chain.then(() => api.branches.uploadSource(branchId, file)), Promise.resolve())
      .then(reload).catch((err) => ctx.toast(err.message || "Upload failed."))
      .finally(() => setBusy(false));
  }
  function runClean() {
    setCleaning(true);
    api.branches.clean(branchId).then(reload).then(() => ctx.toast("Cleaned file produced."))
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
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{presetName}</span>
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

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 22, alignItems: "start" }}>
        {/* sources */}
        <div>
          <div className="between" style={{ marginBottom: 12 }}>
            <div className="sectitle" style={{ margin: 0 }}>Source files</div>
            {isActive ? (
              <>
                <input ref={inputRef} type="file" multiple style={{ display: "none" }} onChange={onPick} />
                <button className="btn pri sm" disabled={busy} onClick={pick}><Icon name="upload" size={14} />{busy ? "Uploading…" : "Upload source"}</button>
              </>
            ) : null}
          </div>
          {files === null ? (
            <div className="empty">Loading files…</div>
          ) : sources.length ? (
            <div className="card filelist">
              {sources.map((f) => (
                <div className="fileitem" key={f.id}>
                  <Icon name="doc" size={16} style={{ color: "var(--ink-3)" }} />
                  <span className="fn">{f.originalFilename || ("source-" + f.id)}</span>
                  <span className="sz">{humanSize(f.sizeBytes)} · {f.status}</span>
                  {f.status === "available" ? (
                    <button className="btn ghost sm" onClick={() => download(f.id)}><Icon name="download" size={13} />Download</button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No source files yet{isActive ? " — upload your catalog files to begin." : "."}</div>
          )}
        </div>

        {/* cleaned */}
        <div>
          <div className="sectitle">Cleaned output</div>
          <div className="card pad">
            {cleaned ? (
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
                  {isActive ? <button className="btn ghost sm" disabled={cleaning} onClick={runClean}><Icon name="refresh" size={14} />Re-run</button> : null}
                </div>
              </div>
            ) : (
              <div className="col" style={{ gap: 12 }}>
                <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
                  Run the cleansing pipeline over your source files to produce one cleaned output. Shared branches let teammates download this file.
                </p>
                <button className="btn pri" disabled={!isActive || !sources.length || cleaning} onClick={runClean}>
                  <Icon name="pipeline" size={16} />{cleaning ? "Cleaning…" : "Run cleaning"}
                </button>
                {!sources.length && isActive ? <div className="muted" style={{ fontSize: 12.5 }}>Upload at least one source file first.</div> : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
