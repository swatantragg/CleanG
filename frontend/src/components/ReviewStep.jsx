import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import Icon from "./Icon.jsx";
import QualityCockpit from "./QualityCockpit.jsx";

const PAGE_SIZE = 50;

// A distinct colour per error type so the grid, chips and captions all agree —
// you can tell at a glance which kind of problem each red cell is.
const TAG_COLORS = {
  invalid_isrc: "#e11d48",
  invalid_upc: "#ea580c",
  invalid_date: "#d97706",
  implausible_date: "#b45309",
  invalid_duration: "#7c3aed",
  invalid_percent: "#0891b2",
  invalid_category: "#2563eb",
  suspect_value: "#db2777",
  missing_required: "#dc2626",
  garbled_value: "#9333ea",
  duplicate: "#0d9488",
  possible_duplicate: "#14b8a6",
  upc_album_mismatch: "#f59e0b",
  // Cleaning (auto-fix) categories — calm green/teal hues.
  trimmed: "#16a34a",
  removed_junk: "#0d9488",
  reformatted_date: "#0891b2",
  normalized_duration: "#059669",
  normalized_isrc: "#10b981",
  normalized_upc: "#0ea5e9",
  normalized_code: "#14b8a6",
  normalized_path: "#22c55e",
  standardized_category: "#16a34a",
  normalized_language: "#10b981",
  normalized_percent: "#06b6d4",
};
const tagColor = (t) => TAG_COLORS[t] || "#6b7280";

export default function ReviewStep({ file, onCommitted }) {
  const [summary, setSummary] = useState(null);
  const [profile, setProfile] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [showCockpit, setShowCockpit] = useState(false);
  const [view, setView] = useState("all"); // all | error | clean
  const [activeTag, setActiveTag] = useState(null);
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState({}); // rowIndex -> {col: value}
  const [bulkValue, setBulkValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(null);

  // Headers come straight from the mapping we already have, so the grid frame
  // renders instantly instead of waiting on the network.
  const columns = useMemo(
    () =>
      (file.mapping || [])
        .filter((m) => m.input_header)
        .map((m) => m.master_column),
    [file.mapping]
  );

  const tagLabel = useMemo(() => {
    const map = {};
    (summary?.tags || []).forEach((t) => (map[t.tag] = t.label));
    (summary?.fix_tags || []).forEach((t) => (map[t.tag] = t.label));
    return map;
  }, [summary]);

  // When a specific error type is selected, figure out which column(s) carry it
  // and float them to the front so the user doesn't have to hunt/scroll for them.
  const focusCols = useMemo(() => {
    if (!activeTag) return [];
    const s = new Set();
    rows.forEach((r) =>
      r.issues.forEach((i) => {
        if (i.tag === activeTag) s.add(i.column); // error OR cleaning tag
      })
    );
    return columns.filter((c) => s.has(c)); // keep master order among the focused
  }, [rows, activeTag, columns]);

  const displayColumns = useMemo(() => {
    if (focusCols.length === 0) return columns;
    const focus = new Set(focusCols);
    return [...focusCols, ...columns.filter((c) => !focus.has(c))];
  }, [columns, focusCols]);

  const focusSet = useMemo(() => new Set(focusCols), [focusCols]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ONE request gives us summary + quality profile + the current page of rows.
  const load = useCallback(
    async (withProfile) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({
          view,
          page: String(page),
          page_size: String(PAGE_SIZE),
          include_profile: String(withProfile),
        });
        // Filter by the selected tag in any view (error tag or cleaning tag).
        if (activeTag) qs.set("tag", activeTag);
        const d = await api(`/api/files/${file.id}/review?${qs.toString()}`);
        setSummary(d.summary);
        if (d.profile) setProfile(d.profile);
        setRows(d.rows);
        setTotal(d.total);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [file.id, view, activeTag, page]
  );

  // Profile only changes when the data does (edits/bulk), not when paging —
  // so we fetch it on first load and refresh it after a mutation.
  useEffect(() => {
    load(!profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  function switchView(v, tag = null) {
    setView(v);
    setActiveTag(tag);
    setPage(0);
  }

  function errorMap(row) {
    // When a specific error type is selected, highlight ONLY that type so the
    // user can focus on one problem at a time — other issues stay quiet.
    const m = {};
    row.issues.forEach((i) => {
      if (i.action === "error" && (!activeTag || i.tag === activeTag)) {
        m[i.column] = i;
      }
    });
    return m;
  }

  function fixedMap(row) {
    // When a cleaning type is selected, mark only those fixes so the user can
    // focus on one kind of correction at a time.
    const m = {};
    row.issues.forEach((i) => {
      if (i.action === "fixed" && (!activeTag || i.tag === activeTag)) {
        m[i.column] = i;
      }
    });
    return m;
  }

  function setDraft(rowIndex, col, value) {
    setDrafts((d) => ({ ...d, [rowIndex]: { ...d[rowIndex], [col]: value } }));
  }

  async function saveRow(row) {
    const values = drafts[row.row_index];
    if (!values) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/files/${file.id}/rows/${row.row_index}`, {
        method: "PUT",
        body: { values },
      });
      setDrafts((d) => {
        const n = { ...d };
        delete n[row.row_index];
        return n;
      });
      await load(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(action) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/files/${file.id}/clean/bulk`, {
        method: "POST",
        body: { tag: activeTag, action, value: bulkValue },
      });
      setBulkValue("");
      await load(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError("");
    try {
      const res = await api(`/api/files/${file.id}/commit`, { method: "POST" });
      setCommitted(res);
      onCommitted?.({ ...file, status: "committed" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (committed) {
    return (
      <div className="card empty">
        <div className="success-mark">
          <Icon name="check" size={32} />
        </div>
        <h2>Saved to the master dataset</h2>
        <p className="muted">
          {committed.committed} clean record{committed.committed !== 1 ? "s" : ""} added
          {committed.skipped_errors > 0 &&
            ` · ${committed.skipped_errors} row(s) still had errors and were skipped`}
          .
        </p>
      </div>
    );
  }

  const errorsLeft = summary?.errors ?? 0;

  return (
    <div className="theme-light review-page">
      <div className="page-head">
        <div>
          <h1>Review &amp; save</h1>
          <p className="muted">
            Fix flagged cells inline, or resolve a whole error type at once — then
            save the clean rows.
          </p>
        </div>
        <button
          className="btn primary"
          onClick={commit}
          disabled={busy || !summary || summary.clean === 0}
        >
          <Icon name="check" size={16} />
          Save {summary?.clean ?? 0} clean row{summary?.clean === 1 ? "" : "s"}
        </button>
      </div>

      {error && (
        <div className="alert">
          <Icon name="alert" size={16} />
          {error}
        </div>
      )}

      {/* At-a-glance stat cards */}
      <div className="review-stats">
        <div className="rstat green">
          <Icon name="check" size={18} />
          <div>
            <b>{summary?.clean ?? "—"}</b>
            <span>Clean &amp; ready</span>
          </div>
        </div>
        <div className="rstat amber">
          <Icon name="alert" size={18} />
          <div>
            <b>{summary?.errors ?? "—"}</b>
            <span>Need review</span>
          </div>
        </div>
        <div className="rstat blue">
          <Icon name="sparkles" size={18} />
          <div>
            <b>{summary?.auto_fixed ?? "—"}</b>
            <span>Auto-fixed cells</span>
          </div>
        </div>
        <div className="rstat plain">
          <Icon name="table" size={18} />
          <div>
            <b>{summary?.total ?? "—"}</b>
            <span>Total rows</span>
          </div>
        </div>
      </div>

      {/* Quality cockpit (collapsible) */}
      {profile && (
        <div className="cockpit-shell">
          <button className="cockpit-toggle" onClick={() => setShowCockpit((s) => !s)}>
            <Icon name="sparkles" size={15} />
            Data quality cockpit
            <span className="muted small">
              score {profile.score} · grade {profile.grade}
            </span>
            <span className="cockpit-caret">{showCockpit ? "▾" : "▸"}</span>
          </button>
          {showCockpit && (
            <QualityCockpit profile={profile} onPickColumn={() => switchView("error", null)} />
          )}
        </div>
      )}

      {/* View tabs */}
      <div className="view-tabs">
        <button className={view === "all" ? "active" : ""} onClick={() => switchView("all")}>
          All rows
        </button>
        <button className={view === "error" ? "active" : ""} onClick={() => switchView("error")}>
          Needs review ({errorsLeft})
        </button>
        <button className={view === "clean" ? "active" : ""} onClick={() => switchView("clean")}>
          Clean ({summary?.clean ?? 0})
        </button>
      </div>

      {/* Colour-coded error legend + bulk fixer */}
      {view === "error" && summary && summary.tags.length > 0 && (
        <>
          <div className="tag-filter">
            <button
              className={`tag-chip ${!activeTag ? "active" : ""}`}
              onClick={() => switchView("error", null)}
            >
              All errors <span className="n">{summary.errors}</span>
            </button>
            {summary.tags.map((t) => (
              <button
                key={t.tag}
                className={`tag-chip ${activeTag === t.tag ? "active" : ""}`}
                style={{ "--tag": tagColor(t.tag) }}
                onClick={() => switchView("error", t.tag)}
              >
                <span className="tag-dot" />
                {t.label} <span className="n">{t.count}</span>
              </button>
            ))}
          </div>
          {activeTag && (
            <div className="bulk-bar" style={{ "--tag": tagColor(activeTag) }}>
              <span className="tag-dot lg" />
              <span>
                Resolve all <strong>{total}</strong> “{tagLabel[activeTag] || activeTag}”
                rows at once:
              </span>
              {activeTag !== "duplicate" && (
                <>
                  <input
                    style={{ width: 170 }}
                    placeholder="set flagged cells to…"
                    value={bulkValue}
                    onChange={(e) => setBulkValue(e.target.value)}
                  />
                  <button
                    className="btn sm primary"
                    disabled={busy || !bulkValue}
                    onClick={() => runBulk("set")}
                  >
                    Apply to all
                  </button>
                </>
              )}
              <button className="btn sm" disabled={busy} onClick={() => runBulk("drop")}>
                Drop all
              </button>
            </div>
          )}
        </>
      )}

      {/* What the tool cleaned (accuracy breakdown). Shown in "All rows" and
          "Clean"; pick one to highlight those cells. Note: some fixes (e.g. junk
          cleared from a required field) leave the row needing review, so they only
          appear under "All rows". */}
      {(view === "all" || view === "clean") &&
        summary &&
        summary.fix_tags?.length > 0 && (
          <>
            <div className="breakdown-label muted small">
              <Icon name="sparkles" size={13} /> What the tool cleaned — pick one to highlight it
            </div>
            <div className="tag-filter">
              <button
                className={`tag-chip ${!activeTag ? "active" : ""}`}
                onClick={() => switchView(view, null)}
              >
                {view === "clean" ? "All clean" : "All rows"}{" "}
                <span className="n">{view === "clean" ? summary.clean : summary.total}</span>
              </button>
              {summary.fix_tags.map((t) => (
                <button
                  key={t.tag}
                  className={`tag-chip ${activeTag === t.tag ? "active" : ""}`}
                  style={{ "--tag": tagColor(t.tag) }}
                  onClick={() => switchView(view, t.tag)}
                  title={`${t.count} cell${t.count === 1 ? "" : "s"} cleaned across the dataset`}
                >
                  <span className="tag-dot" />
                  {t.label} <span className="n">{t.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

      {/* Legend — what the cell colours mean */}
      <div className="grid-legend">
        <span><i className="lg-dot green" /> Auto-fixed (labelled by what changed)</span>
        <span><i className="lg-dot red" /> Needs your review</span>
        <span><i className="lg-dot blank" /> Empty cell</span>
        <span className="muted small lg-hint">Hover a cell to see the original value · click a flagged cell to edit</span>
      </div>

      {/* Data grid */}
      <div className="grid-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {displayColumns.map((c) => (
                <th
                  key={c}
                  className={focusSet.has(c) ? "col-focus" : ""}
                  style={focusSet.has(c) ? { "--tag": tagColor(activeTag) } : undefined}
                >
                  {focusSet.has(c) && <span className="col-focus-dot" />}
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td className="rownum">
                      <span className="sk sk-line" style={{ width: 20, height: 10 }} />
                    </td>
                    {displayColumns.map((c) => (
                      <td key={c}>
                        <span className="sk sk-line" style={{ width: "80%", height: 10 }} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => {
                  const errs = errorMap(row);
                  const fixes = fixedMap(row);
                  const hasDraft = !!drafts[row.row_index];
                  return (
                    <tr key={row.row_index} className={row.status === "error" ? "row-err" : ""}>
                      <td className="rownum">
                        {row.row_index + 1}
                        {hasDraft && (
                          <button
                            className="cell-save"
                            title="Save row"
                            onClick={() => saveRow(row)}
                          >
                            <Icon name="check" size={12} />
                          </button>
                        )}
                      </td>
                      {displayColumns.map((c) => {
                        const issue = errs[c];
                        const val = drafts[row.row_index]?.[c] ?? row.values[c] ?? "";
                        if (issue) {
                          return (
                            <td
                              key={c}
                              className="cell-flagged"
                              style={{ "--tag": tagColor(issue.tag) }}
                              title={issue.message}
                            >
                              <input
                                value={val}
                                onChange={(e) => setDraft(row.row_index, c, e.target.value)}
                                onBlur={() =>
                                  drafts[row.row_index]?.[c] !== undefined && saveRow(row)
                                }
                              />
                              <span className="cell-tag">
                                {tagLabel[issue.tag] || issue.tag}
                                {issue.related_rows?.length > 0 && (
                                  <em className="cell-tag-rows">
                                    {" ↔ row "}
                                    {issue.related_rows.join(", ")}
                                  </em>
                                )}
                              </span>
                            </td>
                          );
                        }
                        const fix = fixes[c];
                        if (fix) {
                          const from = (fix.original || "").trim();
                          return (
                            <td
                              key={c}
                              className="cell-fixed"
                              style={{ "--tag": tagColor(fix.tag) }}
                              title={`${tagLabel[fix.tag] || "Auto-fixed"}${
                                from ? ` — was “${from}”` : ""
                              }`}
                            >
                              <span className="fixed-val">
                                <span className="fix-mark">
                                  <Icon name="check" size={11} />
                                </span>
                                {val ? (
                                  val
                                ) : from ? (
                                  <s className="orig-removed">{from}</s>
                                ) : (
                                  "—"
                                )}
                              </span>
                              <span className="cell-fix-tag">
                                {tagLabel[fix.tag] || "Cleaned"}
                              </span>
                            </td>
                          );
                        }
                        return (
                          <td
                            key={c}
                            className={val === "" ? "cell-blank" : ""}
                            title={val || undefined}
                          >
                            {val || "—"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={displayColumns.length + 1} className="grid-empty">
                  <Icon name="check" size={20} />
                  {view === "error" ? "Nothing left to review here 🎉" : "No rows to show."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="pager">
          <button className="btn sm" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span className="muted small">
            Page {page + 1} of {pages} · {total} row{total === 1 ? "" : "s"}
          </span>
          <button
            className="btn sm"
            disabled={page >= pages - 1 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
