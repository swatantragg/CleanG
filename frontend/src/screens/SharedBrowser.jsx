/* ============================================================
   Shared Branches — other users' shared + active branches.
   Read-only; you can download their cleaned output only.
   ============================================================ */
import React, { useState, useEffect } from "react";
import { api } from "../api/index.js";
import { Icon, LifecyclePill } from "../components/ui.jsx";
import { humanSize, fmtDate, expiryLabel, triggerDownload } from "../util.js";

export function SharedBrowser({ ctx }) {
  const [branches, setBranches] = useState(null);

  useEffect(() => {
    let on = true;
    api.shared.list().then((b) => { if (on) setBranches(b); }).catch(() => { if (on) setBranches([]); });
    return () => { on = false; };
  }, []);

  function download(fileId) {
    api.files.signedUrl(fileId).then((r) => triggerDownload(r.url))
      .catch((err) => ctx.toast(err.message || "Download failed."));
  }

  return (
    <div className="page wide fade">
      <div className="page-head">
        <div className="ey">Cross-branch</div>
        <h1>Shared branches</h1>
        <div className="sub">Active branches other users have shared. You can download their cleaned output — their files and yours stay isolated.</div>
      </div>

      {branches === null ? (
        <div className="empty">Loading…</div>
      ) : branches.length === 0 ? (
        <div className="empty">No shared branches from other users right now.</div>
      ) : (
        <div className="branchgrid">
          {branches.map((b) => (
            <div className="branch" key={b.id} style={{ cursor: "default" }}>
              <div className="bh">
                <span className="nm">{b.name}</span>
                <div style={{ marginLeft: "auto" }}><LifecyclePill status={b.status} /></div>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>by {b.ownerName || "another user"}</div>
              <div className="row" style={{ gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--ink-3)", alignItems: "center" }}>
                <Icon name="clock" size={13} /><span>{expiryLabel(b)}</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>created {fmtDate(b.createdAt)}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                {b.cleanedFileId ? (
                  <button className="btn pri sm" onClick={() => download(b.cleanedFileId)}>
                    <Icon name="download" size={14} />Download cleaned{b.cleanedSizeBytes ? " · " + humanSize(b.cleanedSizeBytes) : ""}
                  </button>
                ) : (
                  <span className="muted" style={{ fontSize: 12.5 }}>No cleaned output yet.</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
