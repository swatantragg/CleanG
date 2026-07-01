import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, download } from "../api/client.js";
import Icon from "../components/Icon.jsx";

// One pre-filter row: type a name, pick from values that exist in the master
// data, and the chosen values become chips. Suggestions are debounced.
function FilterRow({ field, selected, onAdd, onRemove }) {
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ field: field.key, q });
        const res = await api(`/api/master/suggest?${qs.toString()}`);
        setSuggestions(res.filter((s) => !selected.includes(s.value)));
        setOpen(true);
      } catch {
        setSuggestions([]);
      }
    }, 220);
    return () => timer.current && clearTimeout(timer.current);
  }, [q, field.key, selected]);

  return (
    <div className="filter-row">
      <label className="filter-label">{field.label}</label>
      <div className="filter-input">
        <input
          placeholder={`Type a ${field.label.toLowerCase()}, press Enter…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q.trim()) {
              e.preventDefault();
              onAdd(field.key, q.trim());
              setQ("");
              setSuggestions([]);
              setOpen(false);
            }
          }}
        />
        {open && suggestions.length > 0 && (
          <div className="suggest-box">
            {suggestions.map((s) => (
              <button
                key={s.value}
                type="button"
                className="suggest-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAdd(field.key, s.value);
                  setQ("");
                  setSuggestions([]);
                  setOpen(false);
                }}
              >
                <span>{s.value}</span>
                <em className="suggest-count">{s.count}</em>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((v) => (
            <span key={v} className="chip">
              {v}
              <button type="button" className="chip-x" onClick={() => onRemove(field.key, v)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Export() {
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  // "PDL" | "SVF" | "CUSTOM"
  const [mode, setMode] = useState("PDL");
  const [extras, setExtras] = useState({}); // {presetKey: Set(column)}
  const [customCols, setCustomCols] = useState(new Set());
  const [filters, setFilters] = useState({}); // {column: [values]}

  // Availability check: when filters are entered, the user must verify the
  // values exist in the master data before presets/export unlock.
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);

  // Read-only preview of the (filtered) master data — just a view of the rows.
  const PREVIEW_PAGE_SIZE = 25;
  const [preview, setPreview] = useState({ columns: [], rows: [], total: 0 });
  const [previewPage, setPreviewPage] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setOptions(await api("/api/master/export/options"));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const presetMap = useMemo(() => {
    const m = {};
    (options?.presets || []).forEach((p) => (m[p.key] = p));
    return m;
  }, [options]);

  const allColumns = options?.all_columns || [];

  // The final, ordered list of columns to export.
  const resolved = useMemo(() => {
    if (mode === "CUSTOM") {
      return allColumns.filter((c) => customCols.has(c));
    }
    const preset = presetMap[mode];
    if (!preset) return [];
    const chosenExtras = extras[mode] || new Set();
    // Preset base, then the chosen extras appended at the end (canonical order).
    const appended = preset.custom_columns.filter((c) => chosenExtras.has(c));
    return [...preset.columns, ...appended];
  }, [mode, presetMap, extras, customCols, allColumns]);

  const toggleExtra = useCallback((key, col) => {
    setExtras((prev) => {
      const set = new Set(prev[key] || []);
      set.has(col) ? set.delete(col) : set.add(col);
      return { ...prev, [key]: set };
    });
  }, []);

  const toggleCustom = useCallback((col) => {
    setCustomCols((prev) => {
      const set = new Set(prev);
      set.has(col) ? set.delete(col) : set.add(col);
      return set;
    });
  }, []);

  function addFilter(column, value) {
    setVerifyResult(null); // filters changed -> must re-verify
    setFilters((prev) => {
      const vals = prev[column] || [];
      if (vals.some((v) => v.toLowerCase() === value.toLowerCase())) return prev;
      return { ...prev, [column]: [...vals, value] };
    });
  }
  function removeFilter(column, value) {
    setVerifyResult(null);
    setFilters((prev) => {
      const vals = (prev[column] || []).filter((v) => v !== value);
      const next = { ...prev };
      if (vals.length) next[column] = vals;
      else delete next[column];
      return next;
    });
  }

  const filterValueCount = useMemo(
    () => Object.values(filters).reduce((n, v) => n + v.length, 0),
    [filters]
  );
  const hasFilters = filterValueCount > 0;
  // Proceed when there are no filters (export all) or the entered values verified OK.
  const canProceed = !hasFilters || (verifyResult?.available ?? false);

  async function verifyAvailability() {
    setVerifying(true);
    setError("");
    setDone("");
    try {
      const res = await api("/api/master/verify", {
        method: "POST",
        body: { filters },
      });
      setVerifyResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  async function runExport() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const cleanFilters = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v.length)
      );
      await download("/api/master/export", `${mode.toLowerCase()}_export.xlsx`, {
        method: "POST",
        body: { columns: resolved, filters: cleanFilters, sheet_name: `${mode} export` },
      });
      setDone(`Exported ${resolved.length} columns${
        Object.keys(cleanFilters).length ? " (filtered)" : ""
      }.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Re-fetch the preview when the filters or the chosen columns change (debounced).
  // Serialised into a key so array/object identity churn doesn't over-fire.
  const previewKey = useMemo(
    () => JSON.stringify({ f: filters, c: resolved }),
    [filters, resolved]
  );
  // A filter/column change returns the preview to page 1.
  useEffect(() => {
    setPreviewPage(0);
  }, [previewKey]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewErr("");
      try {
        const cleanFilters = Object.fromEntries(
          Object.entries(filters).filter(([, v]) => v.length)
        );
        const res = await api("/api/master/preview", {
          method: "POST",
          body: {
            filters: cleanFilters,
            columns: resolved,
            limit: PREVIEW_PAGE_SIZE,
            offset: previewPage * PREVIEW_PAGE_SIZE,
          },
        });
        if (!cancelled) setPreview(res);
      } catch (e) {
        if (!cancelled) setPreviewErr(e.message);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewPage]);

  const previewFrom = preview.total === 0 ? 0 : previewPage * PREVIEW_PAGE_SIZE + 1;
  const previewTo = Math.min((previewPage + 1) * PREVIEW_PAGE_SIZE, preview.total);
  const previewMaxPage = Math.max(0, Math.ceil(preview.total / PREVIEW_PAGE_SIZE) - 1);

  const MODES = [
    { key: "PDL", title: "PDL + Custom", desc: "PDL preset columns, plus any extras you add." },
    { key: "SVF", title: "SVF + Custom", desc: "SVF preset columns, plus any extras you add." },
    { key: "CUSTOM", title: "Custom", desc: "Hand-pick exactly the columns you want." },
  ];

  if (loading) {
    return (
      <section>
        <h1>Export</h1>
        <div className="card"><div className="sk sk-bar" style={{ height: 160 }} /></div>
      </section>
    );
  }

  return (
    <section className="export-page">
      <div className="page-head">
        <div>
          <h1>Export</h1>
          <p className="muted">
            Pull data from the master dataset — pick a preset (or build a custom
            column set), optionally narrow the rows, then download as Excel.
          </p>
        </div>
        <div className="master-stat" title="Total cleaned records stored in the master dataset">
          <span className="master-stat-num">{options?.total_records ?? 0}</span>
          <span className="master-stat-label">rows in master data</span>
        </div>
      </div>

      {error && (
        <div className="alert"><Icon name="alert" size={16} /> {error}</div>
      )}
      {done && (
        <div className="ok-bar"><Icon name="check" size={16} /> {done}</div>
      )}

      {/* 1 — Filter the rows (optional) */}
      <div className="card">
        <h3 className="sec-title">1 · Filter rows <span className="muted small">(optional)</span></h3>
        <p className="muted small">
          Type a name; we suggest values that exist in the master data. Leave
          empty to export every record.
        </p>
        <div className="filter-grid">
          {(options?.filter_fields || []).map((f) => (
            <FilterRow
              key={f.key}
              field={f}
              selected={filters[f.key] || []}
              onAdd={addFilter}
              onRemove={removeFilter}
            />
          ))}
        </div>
      </div>

      {/* 1b — Verify the entered values exist before unlocking the rest */}
      {hasFilters && (
        <div className="verify-bar">
          <div className="verify-head">
            <span className="muted small">
              {filterValueCount} value{filterValueCount === 1 ? "" : "s"} entered ·
              check they exist in the master data
            </span>
            <button
              className="btn primary"
              onClick={verifyAvailability}
              disabled={verifying}
            >
              <Icon name="check" size={16} />
              {verifying ? "Checking…" : "Next · Verify availability"}
            </button>
          </div>
          {verifyResult && (
            <div className={`verify-result ${verifyResult.available ? "ok" : "bad"}`}>
              <Icon name={verifyResult.available ? "check" : "alert"} size={16} />
              <div>
                <strong>{verifyResult.message}</strong>
                {verifyResult.values.length > 0 && (
                  <div className="verify-values">
                    {verifyResult.values.map((v) => (
                      <span
                        key={`${v.column}:${v.value}`}
                        className={`verify-pill ${v.available ? "on" : "off"}`}
                        title={
                          v.available
                            ? `${v.count} record(s)`
                            : "Not present in the master data"
                        }
                      >
                        <Icon name={v.available ? "check" : "x"} size={11} />
                        {v.value}
                        {v.available && <em className="vc">{v.count}</em>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Read-only preview of the (filtered) master data */}
      <div className="card">
        <div className="preview-head">
          <h3 className="sec-title">
            Preview <span className="muted small">· read-only view of the master data</span>
          </h3>
          <div className="preview-meta">
            {previewLoading ? (
              <span className="muted small">Loading…</span>
            ) : (
              <span className="muted small">
                {preview.total > 0
                  ? `Showing ${previewFrom}–${previewTo} of ${preview.total} row${
                      preview.total === 1 ? "" : "s"
                    }`
                  : "No matching rows"}
                {hasFilters ? " (filtered)" : ""}
              </span>
            )}
            <button
              className="btn download-preview-btn"
              onClick={runExport}
              disabled={busy || resolved.length === 0 || preview.total === 0}
              title={
                resolved.length === 0
                  ? "Choose at least one column below"
                  : "Download these rows as Excel"
              }
            >
              <Icon name="download" size={15} />
              {busy ? "Downloading…" : "Download Excel"}
            </button>
          </div>
        </div>

        {previewErr && (
          <div className="alert"><Icon name="alert" size={16} /> {previewErr}</div>
        )}

        <div className="preview-table-wrap">
          <table className="table preview-table">
            <thead>
              <tr>
                <th className="preview-idx">#</th>
                {preview.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.length === 0 ? (
                <tr>
                  <td
                    className="muted"
                    colSpan={preview.columns.length + 1}
                    style={{ textAlign: "center", padding: "1.5rem" }}
                  >
                    {previewLoading ? "Loading…" : "No rows to show."}
                  </td>
                </tr>
              ) : (
                preview.rows.map((row, i) => (
                  <tr key={i}>
                    <td className="preview-idx">
                      {previewPage * PREVIEW_PAGE_SIZE + i + 1}
                    </td>
                    {preview.columns.map((c) => (
                      <td key={c} title={row[c] || ""}>
                        {row[c] || <span className="muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {preview.total > PREVIEW_PAGE_SIZE && (
          <div className="preview-pager">
            <button
              className="btn sm"
              disabled={previewPage === 0 || previewLoading}
              onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
            >
              <Icon name="arrowLeft" size={14} /> Prev
            </button>
            <span className="muted small">
              Page {previewPage + 1} of {previewMaxPage + 1}
            </span>
            <button
              className="btn sm"
              disabled={previewPage >= previewMaxPage || previewLoading}
              onClick={() => setPreviewPage((p) => Math.min(previewMaxPage, p + 1))}
            >
              Next <Icon name="arrowRight" size={14} />
            </button>
          </div>
        )}
      </div>

      {/* 2 — Choose the export shape */}
      <div className={`card ${canProceed ? "" : "section-locked"}`}>
        <h3 className="sec-title">
          2 · Choose columns
          {!canProceed && (
            <span className="muted small">
              {" "}
              · <Icon name="lock" size={12} />{" "}
              {verifyResult ? "verify values first" : "verify the filters above to unlock"}
            </span>
          )}
        </h3>
        <div className="preset-cards">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`preset-card ${mode === m.key ? "active" : ""}`}
              onClick={() => setMode(m.key)}
            >
              <span className="preset-radio" />
              <span className="preset-title">{m.title}</span>
              <span className="preset-desc muted small">{m.desc}</span>
            </button>
          ))}
        </div>

        {mode !== "CUSTOM" && presetMap[mode] && (
          <div className="preset-config">
            <div className="preset-base">
              <span className="muted small">
                {presetMap[mode].label} preset · {presetMap[mode].columns.length} columns
              </span>
              <div className="col-tags">
                {presetMap[mode].columns.map((c) => (
                  <span key={c} className="col-tag">{c}</span>
                ))}
              </div>
            </div>
            <div className="preset-extra">
              <span className="muted small">
                Custom — additional columns to append ({presetMap[mode].custom_columns.length})
              </span>
              {presetMap[mode].custom_columns.length === 0 ? (
                <p className="muted small">This preset already includes every master column.</p>
              ) : (
                <div className="col-checklist">
                  {presetMap[mode].custom_columns.map((c) => {
                    const checked = (extras[mode] || new Set()).has(c);
                    return (
                      <label key={c} className={`col-check ${checked ? "on" : ""}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleExtra(mode, c)} />
                        {c}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {mode === "CUSTOM" && (
          <div className="preset-config">
            <div className="preset-extra">
              <span className="muted small">Pick the columns to export ({customCols.size} selected)</span>
              <div className="col-checklist">
                {allColumns.map((c) => {
                  const checked = customCols.has(c);
                  return (
                    <label key={c} className={`col-check ${checked ? "on" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleCustom(c)} />
                      {c}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3 — Resolved output + export */}
      <div className="resolved-bar">
        <div>
          <strong>{resolved.length}</strong> column{resolved.length === 1 ? "" : "s"} ·{" "}
          <span className="muted small">
            {Object.keys(filters).length
              ? `${Object.values(filters).reduce((n, v) => n + v.length, 0)} filter value(s)`
              : "no filters"}
          </span>
          {resolved.length > 0 && (
            <div className="col-tags resolved-tags">
              {resolved.map((c, i) => (
                <span key={c} className="col-tag">
                  <em className="ord">{i + 1}</em> {c}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          className="btn primary"
          onClick={runExport}
          disabled={busy || resolved.length === 0 || !canProceed}
          title={!canProceed ? "Verify the filter values first" : undefined}
        >
          <Icon name="download" size={16} />
          {busy ? "Exporting…" : "Export to Excel"}
        </button>
      </div>

    </section>
  );
}
