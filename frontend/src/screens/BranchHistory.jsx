/* ============================================================
   Branch History — branches that are no longer active
   (deleted / expired / purged). Read-only records kept for audit.
   ============================================================ */
import React from "react";
import { Icon, LifecyclePill } from "../components/ui.jsx";
import { fmtDate } from "../util.js";

export function BranchHistory({ ctx }) {
  // Everything past its active life: soft-deleted, expired, or failed-to-purge.
  const past = ctx.branches
    .filter((b) => b.status !== "active")
    .sort((a, b) => new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt));

  return (
    <div className="page fade">
      <div className="page-head between">
        <div>
          <div className="ey">Workspace</div>
          <h1>Branch History</h1>
          <div className="sub">Branches you’ve deleted or that have expired. Records are kept for history; their files are purged from storage after expiry.</div>
        </div>
      </div>

      <div className="sectitle">Deleted &amp; expired branches</div>
      {past.length ? (
        <div className="branchlist">
          {past.map((b) => (
            <HistoryRow key={b.id} branch={b} onOpen={() => ctx.openBranch(b.id)} />
          ))}
        </div>
      ) : (
        <div className="empty">No deleted branches yet — branches you delete will appear here.</div>
      )}
    </div>
  );
}

function HistoryRow({ branch, onOpen }) {
  const purged = !!branch.purgedAt;
  return (
    <div className="branchrow" onClick={onOpen}>
      <span className="nm">{branch.name}</span>
      <LifecyclePill status={branch.status} />
      <div className="rmeta">
        <Icon name={branch.visibility === "shared" ? "globe" : "lock"} size={13} />
        <span>{branch.visibility === "shared" ? "Shared" : "Private"}</span>
        <span className="sep hide-sm">·</span>
        <Icon name={purged ? "trash" : "clock"} size={13} className="hide-sm" />
        <span className="hide-sm">{purged ? "files purged" : "files purge after expiry"}</span>
        {branch.deletedAt ? <><span className="sep hide-sm">·</span><span className="hide-sm">deleted {fmtDate(branch.deletedAt)}</span></> : null}
      </div>
      <div className="spacer" />
      <span className="open">view →</span>
    </div>
  );
}
