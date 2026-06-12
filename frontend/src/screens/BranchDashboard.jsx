/* ============================================================
   Branch Dashboard — your branches and their retention lifecycle.
   ============================================================ */
import React, { useState } from "react";
import { Icon, Modal, LifecyclePill } from "../components/ui.jsx";
import { expiryLabel } from "../util.js";

export function BranchDashboard({ ctx }) {
  const [modal, setModal] = useState(null); // {name, presetId, visibility, busy, err}
  const [delId, setDelId] = useState(null);
  const branches = ctx.branches;
  const presetName = (id) => { const p = ctx.presets.find((x) => x.id === id); return p ? p.name : "No preset"; };

  const active = branches.filter((b) => b.status === "active");
  const shared = active.filter((b) => b.visibility === "shared");

  function openCreate() {
    // Preset selection moves to a later phase — branches start with no preset.
    setModal({ name: "", presetId: null, visibility: "shared", busy: false, err: null });
  }
  function submitCreate() {
    const name = (modal.name || "").trim();
    if (!name) { setModal((m) => ({ ...m, err: "Branch name is required." })); return; }
    setModal((m) => ({ ...m, busy: true, err: null }));
    ctx.createBranch({ name, presetId: modal.presetId, visibility: modal.visibility })
      .then((b) => { setModal(null); ctx.openBranch(b.id); })
      .catch((e) => setModal((m) => ({ ...m, busy: false, err: e.message || "Could not create branch." })));
  }
  function confirmDelete() { const id = delId; setDelId(null); ctx.deleteBranch(id).catch((e) => ctx.toast(e.message || "Delete failed.")); }

  return (
    <div className="page fade">
      <div className="page-head between">
        <div>
          <div className="ey">Workspace</div>
          <h1>Branches</h1>
          <div className="sub">Each branch holds your uploaded source files and one cleaned output. Branches expire and are purged automatically — the row stays as history.</div>
        </div>
        <button className="btn pri" onClick={openCreate}><Icon name="plus" size={16} />New branch</button>
      </div>

      <div className="stats" style={{ marginBottom: 28 }}>
        <Stat k="Total branches" v={branches.length} />
        <Stat k="Active" v={active.length} cls="accent" />
        <Stat k="Shared" v={shared.length} d="visible to your team" />
        <Stat k="Deleted" v={branches.filter((b) => b.status !== "active").length} d="history kept" />
      </div>

      <div className="sectitle">Your active branches</div>
      {active.length ? (
        <div className="branchlist">
          {active.map((b) => (
            <BranchRow key={b.id} branch={b} presetName={presetName(b.presetId)} onOpen={() => ctx.openBranch(b.id)}
              onDelete={() => setDelId(b.id)} />
          ))}
        </div>
      ) : (
        <div className="empty">No active branches — start one with <b>New branch</b>{branches.length ? <> · deleted ones are under <b>Branch History</b></> : null}.</div>
      )}

      {modal ? (
        <Modal title="New branch" onClose={() => setModal(null)} width={480}>
          <label className="field-label">Branch name<span className="req">*</span></label>
          <input className={"tinput" + (modal.err ? " err" : "")} autoFocus value={modal.name} placeholder="e.g. PDL Q2 catalog cleanse"
            disabled={modal.busy} onChange={(e) => setModal((m) => ({ ...m, name: e.target.value, err: null }))}
            onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }} />
          {modal.err ? <div className="field-err">{modal.err}</div> : null}

          <label className="field-label" style={{ marginTop: 14 }}>Visibility</label>
          <div className="row" style={{ gap: 10 }}>
            {["shared", "private"].map((v) => (
              <button key={v} type="button" className={"chip-toggle" + (modal.visibility === v ? " on" : "")}
                onClick={() => setModal((m) => ({ ...m, visibility: v }))}
                style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: modal.visibility === v ? "var(--accent-soft)" : "var(--surface)", cursor: "pointer", textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                  <Icon name={v === "shared" ? "globe" : "lock"} size={15} />{v === "shared" ? "Shared" : "Private"}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{v === "shared" ? "Team can download the cleaned file" : "Only you can access it"}</div>
              </button>
            ))}
          </div>

          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn pri" disabled={modal.busy} onClick={submitCreate}>{modal.busy ? "Creating…" : "Create & upload →"}</button>
          </div>
        </Modal>
      ) : null}

      {delId ? (
        <Modal title="Delete this branch?" onClose={() => setDelId(null)} width={440}>
          <p style={{ marginTop: -4, fontSize: 14 }}>The branch is soft-deleted — it stays as a history record and its files are purged from storage after expiry. This can't be undone.</p>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setDelId(null)}>Cancel</button>
            <button className="btn" style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }} onClick={confirmDelete}>
              <Icon name="alert" size={15} />Delete branch
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Stat({ k, v, d, cls }) {
  return <div className="stat"><div className="k">{k}</div><div className={"v " + (cls || "")}>{v}</div>{d ? <div className="d">{d}</div> : null}</div>;
}

function BranchRow({ branch, presetName, onOpen, onDelete }) {
  return (
    <div className="branchrow" onClick={onOpen}>
      <span className="nm">{branch.name}</span>
      <LifecyclePill status={branch.status} />
      <div className="rmeta">
        <Icon name={branch.visibility === "shared" ? "globe" : "lock"} size={13} />
        <span>{branch.visibility === "shared" ? "Shared" : "Private"}</span>
        <span className="sep hide-sm">·</span>
        <span className="hide-sm">{presetName}</span>
        <span className="sep hide-sm">·</span>
        <Icon name="clock" size={13} className="hide-sm" />
        <span className="hide-sm">{expiryLabel(branch)}</span>
      </div>
      <div className="spacer" />
      <span className="open">open →</span>
      {onDelete ? (
        <button className="row-del" title="Delete branch" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <Icon name="trash" size={15} />
        </button>
      ) : null}
    </div>
  );
}
