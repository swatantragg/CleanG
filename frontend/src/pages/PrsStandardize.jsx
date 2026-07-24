import { useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import { formatBytes, postDownload, postJSON, saveBlob } from "../api/upload.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = [".csv", ".xlsx", ".xlsm"];

const DL_LABEL = {
  uploading: "Uploading file…",
  processing: "Consolidating on the server…",
  downloading: "Downloading…",
  done: "Saved.",
};

// The two output shapes the backend can build from one upload.
const VARIANTS = [
  {
    id: "full",
    label: "Full report",
    hint: "Every mapped party field — Name, Role, IPI, ICE Agreement Number, Performance + Mechanical Society and Share, Claim Status, UA Flag, CAR.",
  },
  {
    id: "core",
    label: "Core report",
    hint: "Only Name, Role, IPI Number, Performance Society and Performance Share per party.",
  },
];

export default function PrsStandardize() {
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
      setPreview(await postJSON("/api/prs/preview", f));
    } catch (e) {
      setError(e.message);
      setFile(null);
    } finally {
      setPhase("");
    }
  }

  async function download(variant) {
    if (!file || busy) return;
    setError("");
    setPhase("downloading");
    setDl({ stage: "uploading", pct: 0 });
    try {
      const { blob, name } = await postDownload(
        "/api/prs/download",
        file,
        (stage, pct) => setDl({ stage, pct }),
        { variant },
        variant === "both" ? "prs_consolidated.zip" : "prs_consolidated.xlsx"
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
  const failed = preview?.checks.filter((c) => !c.ok) || [];
  const workCount = preview?.work_columns.length || 0;

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload a raw PRS <em>List of works</em> export — one row per interested party,
        so each Tune Code repeats. It comes back as <strong>one row per work</strong>:
        work-level fields written once, and every composer, author and publisher
        expanded sideways into numbered role columns. Column counts are read from
        your file, so a work with six composers gets Composer 1–6. Roles that
        contain a “C” (CA, AC, CP…) go under Composer only, keeping their own role
        value. Names are flipped to “First Last”, society codes lose the numeric
        prefix, dates become DD-MM-YYYY — everything else is passed through as given.
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
              <p className="dz-title">Consolidating…</p>
              <div className="progress indeterminate">
                <span />
              </div>
              <p className="muted small">Grouping works and expanding interested parties</p>
            </div>
          ) : (
            <>
              <div className="dz-icon">
                <Icon name="table" size={26} />
              </div>
              <p className="dz-title">Drop a PRS report here, or click to browse</p>
              <p className="muted small">
                .csv / .xlsx / .xlsm · up to 20&nbsp;MB · needs ALLIANCE_TUNECODE (or
                WORKKEY) and ROLE_CLASS
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
              <div className="stat-lbl">Works (one row each)</div>
            </div>
            <div className="stat-card blue">
              <div className="stat-num">{preview.total_parties.toLocaleString()}</div>
              <div className="stat-lbl">Interested parties placed</div>
            </div>
            <div className="stat-card amber">
              <div className="stat-num">
                {workCount}
                <span className="muted" style={{ fontSize: "1rem" }}>
                  {" "}
                  + {preview.columns.length - workCount}
                </span>
              </div>
              <div className="stat-lbl">Work columns + party columns</div>
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
              Grouped by <strong>{preview.work_key}</strong>. Showing the first{" "}
              {preview.rows.length} of {preview.total_works.toLocaleString()} works.
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button className="btn sm" onClick={reset} disabled={busy}>
                <Icon name="x" size={15} /> New file
              </button>
              <button className="btn" onClick={() => download("core")} disabled={busy}>
                <Icon name="download" size={16} /> Core .xlsx
              </button>
              <button className="btn primary" onClick={() => download("full")} disabled={busy}>
                <Icon name="download" size={16} />
                {phase === "downloading" ? "Working…" : "Full .xlsx"}
              </button>
              <button className="btn" onClick={() => download("both")} disabled={busy}>
                <Icon name="download" size={16} /> Both (.zip)
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
            {/* Role blocks created from this dataset */}
            <div className="card">
              <h3 className="sec-title">Role columns created</h3>
              <table className="table" style={{ marginTop: "0.6rem" }}>
                <thead>
                  <tr>
                    <th>Block</th>
                    <th>Source roles</th>
                    <th>Columns</th>
                    <th>Parties</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.groups.map((g) => (
                    <tr key={g.group}>
                      <td>
                        <strong>{g.group}</strong>
                      </td>
                      <td>
                        <span className="col-tags">
                          {g.roles.map((r) => (
                            <span key={r} className="col-tag">
                              {r}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        {g.group} 1–{g.columns}
                      </td>
                      <td>{g.parties.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small" style={{ marginTop: "0.7rem" }}>
                Core report keeps 5 fields per party, full report{" "}
                {(preview.columns.length - workCount) /
                  preview.groups.reduce((n, g) => n + g.columns, 0)}
                . Unused slots stay blank.
              </p>
            </div>

            {/* Integrity report — the same checks are written into the workbook */}
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

          {/* Sample of the consolidated output */}
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

          <p className="muted small" style={{ marginTop: "0.8rem" }}>
            {VARIANTS.map((v) => (
              <span key={v.id} style={{ display: "block" }}>
                <strong>{v.label}:</strong> {v.hint}
              </span>
            ))}
            Both files carry identical work-level columns, and each workbook ships a
            Validation sheet with the checks above.
          </p>
        </>
      )}
    </>
  );
}
