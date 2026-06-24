import { useRef, useState } from "react";
import Icon from "../components/Icon.jsx";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = [".csv", ".xlsx", ".xlsm"];

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Multipart POST returning parsed JSON (the preview). The session cookie rides
// along automatically.
async function postJSON(path, file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(path, { method: "POST", credentials: "include", body: form });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data.detail;
    throw new Error(
      (typeof detail === "object" && detail?.message) ||
        detail ||
        `Request failed (${res.status})`
    );
  }
  return res.json();
}

// Multipart POST that streams a file back, reported via XHR so we get real
// upload + download progress (and clear errors instead of an opaque fetch
// "NetworkError"). `onStage(stage, pct)` drives the progress bar.
function postDownload(path, file, onStage) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "blob";

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onStage("uploading", e.loaded / e.total);
    };
    // Bytes are up — the server is now building the workbook.
    xhr.upload.onload = () => onStage("processing", 0);
    xhr.onprogress = (e) => {
      if (e.lengthComputable) onStage("downloading", e.loaded / e.total);
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const cd = xhr.getResponseHeader("Content-Disposition") || "";
        const match = /filename="?([^"]+)"?/.exec(cd);
        resolve({ blob: xhr.response, name: match ? match[1] : "standardized.xlsx" });
        return;
      }
      // Error responses still arrive as a blob — read the JSON detail out of it.
      let message = `Download failed (${xhr.status})`;
      try {
        const text = await xhr.response.text();
        const detail = JSON.parse(text).detail;
        message = (typeof detail === "object" && detail?.message) || detail || message;
      } catch {
        /* keep the generic message */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during download. Please try again."));

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Standardize() {
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
    <section className="standardize-page">
      <div className="page-head">
        <div>
          <h1>Standardize data</h1>
          <p className="muted">
            Upload a messy file with any column names. We allocate every column
            into the master format — merging split fields (Singer 1 / Singer 2 →
            Singer) and unpacking bundled credits (composer / lyricist / label) —
            and hand back all {preview ? preview.columns.length : 30} master
            columns, ready for cleaning. No flagging, just a clean re-shape.
          </p>
        </div>
      </div>

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
    </section>
  );
}
