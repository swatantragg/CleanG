import { useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import PrsStandardize from "./PrsStandardize.jsx";
import ReversePrs from "./ReversePrs.jsx";
import { formatBytes, postDownload, postJSON, saveBlob } from "../api/upload.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = [".csv", ".xlsx", ".xlsm"];

function MasterStandardize() {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState(""); // "" | "loading" | "downloading"
  const [dl, setDl] = useState(null); // { stage, pct } while downloading
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const busy = phase !== "";

  function validate(f) {
    const ok = ACCEPT.some((ext) => f.name.toLowerCase().endsWith(ext));
    if (!ok) return "Unsupported file. Upload a .csv, .xlsx or .xlsm file.";
    if (f.size > MAX_BYTES) return `That file is ${formatBytes(f.size)} — the limit is 20 MB.`;
    if (f.size === 0) return "That file is empty.";
    return "";
  }

  async function choose(f) {
    if (!f || busy) return;
    const problem = validate(f);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setFile(f);
    setPreview(null);
    setPhase("loading");
    try {
      setPreview(await postJSON("/api/standardize/preview", f));
    } catch (e) {
      setError(e.message);
      setFile(null);
    } finally {
      setPhase("");
    }
  }

  async function downloadFull() {
    if (!file || busy) return;
    setError("");
    setPhase("downloading");
    setDl({ stage: "uploading", pct: 0 });
    try {
      const { blob, name } = await postDownload(
        "/api/standardize/download",
        file,
        (stage, pct) => setDl({ stage, pct })
      );
      saveBlob(blob, name);
      setDl({ stage: "done", pct: 1 });
    } catch (e) {
      setError(e.message);
      setDl(null);
    } finally {
      setPhase("");
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setError("");
    setDl(null);
  }

  const matched = preview?.mapping.filter((m) => m.matched) || [];
  const blank = preview?.mapping.filter((m) => !m.matched) || [];

  const DL_LABEL = {
    uploading: "Uploading file…",
    processing: "Standardizing on the server…",
    downloading: "Downloading…",
    done: "Saved.",
  };
  const dlPct = dl ? Math.round((dl.pct || 0) * 100) : 0;
  const dlIndeterminate = dl?.stage === "processing";

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload a messy file with any column names. We allocate every column into
        the master format — merging split fields (Singer 1 / Singer 2 → Singer)
        and unpacking bundled credits (composer / lyricist / label) — and hand
        back all {preview ? preview.columns.length : 30} master columns, ready
        for cleaning. No flagging, just a clean re-shape.
      </p>

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}

      {!preview && (
        <div
          className={`dropzone ${dragOver ? "over" : ""} ${busy ? "busy" : ""}`}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-busy={busy}
          onDragOver={(e) => {
            if (busy) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            choose(e.dataTransfer.files[0]);
          }}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !busy) {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT.join(",")}
            hidden
            onChange={(e) => choose(e.target.files[0])}
          />
          {busy ? (
            <div className="dz-progress">
              <p className="dz-title">Standardizing…</p>
              <div className="progress indeterminate">
                <span />
              </div>
              <p className="muted small">Allocating columns to the master format</p>
            </div>
          ) : (
            <>
              <div className="dz-icon">
                <Icon name="sparkles" size={26} />
              </div>
              <p className="dz-title">Drop a file here, or click to browse</p>
              <p className="muted small">
                .csv / .xlsx / .xlsm · up to 20&nbsp;MB · any column names
              </p>
            </>
          )}
        </div>
      )}

      {preview && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div className="stat-card green">
              <div className="stat-num">{preview.total_rows.toLocaleString()}</div>
              <div className="stat-lbl">Rows standardized</div>
            </div>
            <div className="stat-card blue">
              <div className="stat-num">
                {preview.matched_columns}
                <span className="muted" style={{ fontSize: "1rem" }}>
                  {" "}
                  / {preview.columns.length}
                </span>
              </div>
              <div className="stat-lbl">Master columns allocated</div>
            </div>
            <div className="stat-card amber">
              <div className="stat-num" style={{ fontSize: "1.1rem", lineHeight: 1.4 }}>
                {file?.name}
              </div>
              <div className="stat-lbl">{formatBytes(file?.size || 0)}</div>
            </div>
          </div>

          <div className="resolved-bar">
            <div className="muted small">
              Showing the first {preview.rows.length} of{" "}
              {preview.total_rows.toLocaleString()} rows. Download for the full file.
            </div>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button className="btn sm" onClick={reset} disabled={busy}>
                <Icon name="x" size={15} /> New file
              </button>
              <button className="btn primary" onClick={downloadFull} disabled={busy}>
                <Icon name="download" size={16} />
                {phase === "downloading" ? "Working…" : "Download standardized .xlsx"}
              </button>
            </div>
          </div>

          {/* Download progress */}
          {dl && (
            <div className="dl-bar">
              <div className="dl-head">
                <span className="dl-label">
                  {dl.stage === "done" ? (
                    <Icon name="check" size={15} />
                  ) : (
                    <span className="spinner" />
                  )}
                  {DL_LABEL[dl.stage]}
                </span>
                {!dlIndeterminate && dl.stage !== "done" && (
                  <span className="muted small">{dlPct}%</span>
                )}
              </div>
              <div className={`progress ${dlIndeterminate ? "indeterminate" : ""}`}>
                <span style={{ width: dlIndeterminate ? undefined : `${dlPct}%` }} />
              </div>
            </div>
          )}

          {/* Column allocation map */}
          <div className="card">
            <h3 className="sec-title">Column allocation</h3>
            <div className="std-map">
              {matched.map((m) => (
                <div key={m.master_column} className="std-map-row">
                  <span className="std-master">{m.master_column}</span>
                  <Icon name="arrowRight" size={14} className="std-arrow" />
                  <span className="col-tags">
                    {m.sources.map((s) => (
                      <span key={s} className="col-tag">
                        {s}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            {blank.length > 0 && (
              <p className="muted small" style={{ marginTop: "0.8rem" }}>
                <strong>Left blank</strong> (no matching column in your file):{" "}
                {blank.map((m) => m.master_column).join(", ")}.
              </p>
            )}
          </div>

          {/* Sample of the standardized output */}
          <div className="preview-scroll" style={{ marginTop: "1rem", maxHeight: "60vh" }}>
            <table className="preview-table">
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i}>
                    {preview.columns.map((c) => (
                      <td key={c} className={row[c] ? "" : "blank"}>
                        {row[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// The Standardize section holds one tab per standardization flow: the generic
// master-format re-shape, the PRS work-report consolidation, and its reverse —
// a work sheet expanded into the MLC Bulk Work format.
const TABS = [
  { id: "master", label: "Master format", icon: "sparkles", view: MasterStandardize },
  { id: "prs", label: "PRS standardization", icon: "table", view: PrsStandardize },
  { id: "reverse", label: "Reverse PRS", icon: "arrowRight", view: ReversePrs },
];

export default function Standardize() {
  const [tab, setTab] = useState("master");
  const View = TABS.find((t) => t.id === tab).view;

  return (
    <section className="standardize-page">
      <div className="page-head">
        <div>
          <h1>Standardize data</h1>
        </div>
      </div>

      <div className="view-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      <View />
    </section>
  );
}
