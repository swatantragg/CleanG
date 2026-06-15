// Stage 1 — Ingest: drag/drop or pick a file. The backend parses & validates
// (type, 20 MB limit, non-empty); errors surface inline.

export default function IngestStep({ hot, setHot, fileRef, onFile, busy, error, fileName }) {
  return (
    <div>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Stage 1 — Ingest</div>
          <h1>Upload the input file</h1>
        </div>
      </div>
      <p className="lede">
        Drop an Excel (.xlsx / .xls) or CSV file. Headers don’t need to match the master schema — you’ll map them in
        the next step. Files are sent to the server, where they’re validated (type, size, contents) and parsed.
      </p>

      <div className="card">
        <div
          className={"drop" + (hot ? " hot" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            onFile(e.dataTransfer.files[0]);
          }}
        >
          <div className="big">{busy ? "Uploading & parsing…" : "Drag & drop your file here"}</div>
          <div className="sm2">.xlsx · .xls · .csv · .tsv — max 20 MB, must contain data</div>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn" onClick={() => fileRef.current.click()} disabled={busy}>
              {busy ? "Working…" : "Choose file"}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,.tsv"
            style={{ display: "none" }}
            onChange={(e) => {
              onFile(e.target.files[0]);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
        </div>

        {error && (
          <div className="note" style={{ marginTop: 16, color: "#9F1239", background: "#FFF1F2", borderColor: "#FECDD3" }}>
            <span>!</span>
            <span>{error}</span>
          </div>
        )}
        {!error && fileName && (
          <div className="row" style={{ marginTop: 16 }}>
            <span className="pill teal">✓ {fileName}</span>
          </div>
        )}
      </div>
    </div>
  );
}
