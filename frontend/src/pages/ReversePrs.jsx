import { useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import { formatBytes, postDownload, postJSON, saveBlob } from "../api/upload.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = [".csv", ".xlsx", ".xlsm"];

const DL_LABEL = {
  uploading: "Uploading file…",
  processing: "Building the MLC workbook…",
  downloading: "Downloading…",
  done: "Saved.",
};

// A file holds at most 300 rows (header included); past that the output is split
// into one complete MLC workbook per part, zipped together.
const MAX_SHEET_ROWS = 300;

/**
 * Reverse PRS: a one-row-per-work sheet (Composer 1, Lyricist 1, Singer 1 …)
 * expanded into the MLC Bulk Work template — one row per writer.
 */
export default function ReversePrs() {
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
      setPreview(await postJSON("/api/mlc/preview", f));
    } catch (e) {
      setError(e.message);
      setFile(null);
    } finally {
      setPhase("");
    }
  }

  async function download() {
    if (!file || busy) return;
    setError("");
    setPhase("downloading");
    setDl({ stage: "uploading", pct: 0 });
    try {
      const { blob, name } = await postDownload(
        "/api/mlc/download",
        file,
        (stage, pct) => setDl({ stage, pct }),
        {},
        split ? "mlc_bulk_work.zip" : "mlc_bulk_work.xlsx"
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

  const dlPct = dl ? Math.round((dl.pct || 0) * 100) : 0;
  const dlIndeterminate = dl?.stage === "processing";
  const parts = preview?.part_rows.length || 1;
  const split = parts > 1; // several workbooks -> the download is a .zip
  const failed = preview?.checks.filter((c) => !c.ok) || [];
  const filled = preview?.mapping.filter((m) => m.source) || [];
  const blank = preview?.mapping.filter((m) => !m.source) || [];

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        The reverse of PRS consolidation. Upload a sheet with{" "}
        <strong>one row per work</strong> and its parties spread sideways
        (Composer 1, Composer 2, Lyricist 1, Singer 1…) and it comes back in the{" "}
        <strong>MLC Bulk Work</strong> format: <strong>one row per writer</strong>,
        with the work, publisher and recording information on the first writer row
        and every further writer grouped underneath. Composers get role code C and
        lyricists A — someone credited as <strong>both on the same work is one row
        with role code CA</strong>, not two. Each CAE becomes the Writer IPI
        Number — and a name carrying its own CAE (“Traditional - 39657154”) keeps
        just the name, the number moving to the IPI field. Names are split into
        first / last, and singers stay with the recording as the artist — they
        never become writer rows. Columns the MLC template has no field for are
        left out, never invented.
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
              <p className="dz-title">Expanding writers…</p>
              <div className="progress indeterminate">
                <span />
              </div>
              <p className="muted small">One row per composer and lyricist</p>
            </div>
          ) : (
            <>
              <div className="dz-icon">
                <Icon name="arrowRight" size={26} />
              </div>
              <p className="dz-title">Drop a work sheet here, or click to browse</p>
              <p className="muted small">
                .csv / .xlsx / .xlsm · up to 20&nbsp;MB · needs Song Name and at
                least one Composer / Lyricist column
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
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div className="stat-card green">
              <div className="stat-num">{preview.total_works.toLocaleString()}</div>
              <div className="stat-lbl">Works read</div>
            </div>
            <div className="stat-card blue">
              <div className="stat-num">{preview.total_writers.toLocaleString()}</div>
              <div className="stat-lbl">Writer rows generated</div>
            </div>
            <div className="stat-card amber">
              <div className="stat-num">
                {preview.composers.toLocaleString()}
                <span className="muted" style={{ fontSize: "1rem" }}>
                  {" "}
                  + {preview.lyricists.toLocaleString()}
                  {preview.combined > 0 && ` + ${preview.combined.toLocaleString()}`}
                </span>
              </div>
              <div className="stat-lbl">
                Composers + lyricists{preview.combined > 0 && " + both (CA)"}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-num" style={{ fontSize: "1.1rem", lineHeight: 1.4 }}>
                {file?.name}
              </div>
              <div className="stat-lbl">
                {preview.source_rows.toLocaleString()} source rows ·{" "}
                {formatBytes(file?.size || 0)}
              </div>
            </div>
          </div>

          <div className="resolved-bar">
            <div className="muted small">
              Showing the first {preview.rows.length} of{" "}
              {preview.total_writers.toLocaleString()} writer rows.
              {split && (
                <>
                  {" "}
                  Past {MAX_SHEET_ROWS} rows a file the output becomes{" "}
                  <strong>{parts} separate MLC workbooks</strong> (
                  {preview.part_rows.join(" + ")} rows), each a complete template
                  of its own, downloaded together as a <strong>.zip</strong>. No
                  song is split between files.
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button className="btn sm" onClick={reset} disabled={busy}>
                <Icon name="x" size={15} /> New file
              </button>
              <button className="btn primary" onClick={download} disabled={busy}>
                <Icon name="download" size={16} />
                {phase === "downloading"
                  ? "Working…"
                  : split
                  ? `Download ${parts} MLC files (.zip)`
                  : "Download MLC Bulk Work .xlsx"}
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

          <div className="prs-panels">
            {/* How every MLC column was filled */}
            <div className="card">
              <h3 className="sec-title">MLC column mapping</h3>
              <div className="std-map">
                {filled.map((m) => (
                  <div key={m.column} className="std-map-row">
                    <span className="std-master">{m.column.trim()}</span>
                    <Icon name="arrowLeft" size={14} className="std-arrow" />
                    <span className="col-tags">
                      <span className="col-tag">{m.source}</span>
                    </span>
                  </div>
                ))}
              </div>
              {blank.length > 0 && (
                <p className="muted small" style={{ marginTop: "0.8rem" }}>
                  <strong>Left blank</strong> (nothing in the source maps here):{" "}
                  {blank.map((m) => m.column.trim()).join(", ")}.
                </p>
              )}
              {preview.unmapped_columns.length > 0 && (
                <p className="muted small" style={{ marginTop: "0.5rem" }}>
                  <strong>Not carried over</strong> (the MLC template has no field
                  for them): {[...new Set(preview.unmapped_columns)].join(", ")}.
                </p>
              )}
            </div>

            {/* Integrity report */}
            <div className="card">
              <h3 className="sec-title">
                Integrity checks{" "}
                {failed.length === 0 ? (
                  <span className="prs-ok">
                    <Icon name="check" size={14} /> all passed
                  </span>
                ) : (
                  <span className="prs-fail">
                    <Icon name="alert" size={14} /> {failed.length} failed
                  </span>
                )}
              </h3>
              <ul className="prs-checks">
                {preview.checks.map((c) => (
                  <li key={c.check} className={c.ok ? "ok" : "bad"}>
                    <Icon name={c.ok ? "check" : "alert"} size={14} />
                    <span>
                      <strong>{c.check}</strong>
                      {c.detail && <em> — {c.detail}</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Sample of the MLC output */}
          <div className="preview-scroll" style={{ marginTop: "1rem", maxHeight: "60vh" }}>
            <table className="preview-table">
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c}>{c.trim()}</th>
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

          <p className="muted small" style={{ marginTop: "0.8rem" }}>
            {split ? "Each file in the zip is" : "The download is"} the MLC Bulk
            Work template itself — same column order, header wording, colour coding
            and the three MLC definition sheets — with your data written into it,
            ready to submit.
          </p>
        </>
      )}
    </>
  );
}
