import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, download } from "../api/client.js";
import Icon from "./Icon.jsx";
import Pager, { effectivePageSize } from "./Pager.jsx";

// Excel-style frozen panes: the row number plus this many leading columns stay
// pinned while the rest of the grid scrolls sideways.
const FROZEN_COLS = 5;
// …unless they'd eat the viewport. Never pin more than this share of the grid's
// visible width, or there'd be nothing left to scroll.
const FROZEN_MAX_SHARE = 0.6;

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
  combined_columns: "#0ea5e9",
  derived_lead_artist: "#0284c7",
  filled_constant: "#0369a1",
  // Human change (merge / inline edit / bulk set) — distinct indigo so a cell you
  // manipulated stands out from the tool's own green auto-fixes.
  corrected: "#6366f1",
};
const tagColor = (t) => TAG_COLORS[t] || "#6b7280";

// Each tab names its own download, so a folder of exports is self-explanatory —
// e.g. "Demo(manual_cleaned_singer_desc).xlsx".
const VIEW_SLUG = {
  all: "all_rows",
  error: "needs_review",
  auto_clean: "auto_cleaned",
  manual_clean: "manual_cleaned",
};

/**
 * Where each frozen column has to be pinned, measured off the live header row.
 * Column widths are content-driven, so the offsets can't be known up front: the
 * Nth pinned column sits at the summed width of the row-number cell and every
 * pinned column before it.
 *
 * Returns one left-offset per pinned column — fewer than FROZEN_COLS (or none)
 * when pinning them all would leave too little of the grid scrollable.
 */
function measureFrozen(scrollEl) {
  const cells = scrollEl.querySelector("thead tr")?.children;
  if (!cells || cells.length < 2) return [];
  const budget = scrollEl.clientWidth * FROZEN_MAX_SHARE;
  const lefts = [];
  let left = cells[0].offsetWidth; // the sticky row-number column
  const last = Math.min(FROZEN_COLS, cells.length - 1);
  for (let i = 1; i <= last; i++) {
    const w = cells[i].offsetWidth;
    if (left + w > budget) break;
    lefts.push(left);
    left += w;
  }
  return lefts;
}

// The empty-grid line, per tab.
const EMPTY_TEXT = {
  error: "Nothing left to review here 🎉",
  auto_clean: "No rows were cleaned automatically.",
  manual_clean: "No rows cleaned manually yet — fix or keep a flagged row and it lands here.",
};

export default function ReviewStep({ file, onCommitted }) {
  const [summary, setSummary] = useState(null);
  const [profile, setProfile] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [view, setView] = useState("all"); // all | error | auto_clean | manual_clean
  const [activeTag, setActiveTag] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50); // 0 = All
  const [drafts, setDrafts] = useState({}); // rowIndex -> {col: value}
  const [bulkValue, setBulkValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // chosen row_index
  const [selectAllPages, setSelectAllPages] = useState(false); // all across pages

  // --- Filters: cleaning categories (match ANY) + sort + a column-value filter ---
  const [showFilters, setShowFilters] = useState(false);
  const [activeTags, setActiveTags] = useState([]); // applied fix-tag filters
  const [sortCol, setSortCol] = useState("");
  const [sortDir, setSortDir] = useState("asc");
  const [containsCol, setContainsCol] = useState(""); // "show unique" value filter
  const [containsVal, setContainsVal] = useState("");
  // Draft selections inside the open filter modal (committed on "Apply filter").
  const [draftTags, setDraftTags] = useState([]);
  const [draftSortCol, setDraftSortCol] = useState("");
  const [draftSortDir, setDraftSortDir] = useState("asc");

  // --- Fill a column with a constant value (empties only) ---
  const [showFill, setShowFill] = useState(false);
  const [fillCol, setFillCol] = useState("");
  const [fillVal, setFillVal] = useState("");
  const [fillBusy, setFillBusy] = useState(false);

  // --- Column header interactions ---
  const [headerMenuCol, setHeaderMenuCol] = useState(null); // open popover column
  const [headerMenuPos, setHeaderMenuPos] = useState(null); // {top,left} for the fixed menu
  const [editCol, setEditCol] = useState(null); // column being edited inline
  const [editConfirmed, setEditConfirmed] = useState(false);
  const [pendingRows, setPendingRows] = useState(() => new Set()); // rows mid-accept

  // --- Unique-values side panel ---
  const [uniqueCol, setUniqueCol] = useState(null);
  const [uniqueValues, setUniqueValues] = useState([]);
  const [uniqueLoading, setUniqueLoading] = useState(false);
  const [uniqueSearch, setUniqueSearch] = useState("");
  const [uniqueSortKey, setUniqueSortKey] = useState("count"); // count | value
  const [uniqueSortDir, setUniqueSortDir] = useState("desc"); // asc | desc

  // --- Merge values (alias a variant into a canonical value) ---
  const [mergeMode, setMergeMode] = useState(false); // checkboxes shown in panel
  const [mergePicked, setMergePicked] = useState(() => new Set()); // chosen variants
  const [mergeTarget, setMergeTarget] = useState(""); // canonical value
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeConfirm, setMergeConfirm] = useState(null); // {from:[], to, count}

  // --- Synced horizontal scrollbar shown above the grid ---
  const gridScrollRef = useRef(null);
  const topScrollRef = useRef(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [hasXOverflow, setHasXOverflow] = useState(false); // grid wider than viewport

  // Left offsets (px) for the frozen leading columns, measured from the rendered
  // header. Its length is how many columns are actually pinned.
  const [frozenLefts, setFrozenLefts] = useState([]);

  // --- Save confirmation ---
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);

  // --- Send manually-cleaned rows back to "Needs review" ---
  const [revertConfirm, setRevertConfirm] = useState(null); // {rows, all, count}

  // --- Near-duplicate review (cleaned row vs. an existing master record) ---
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflicts, setConflicts] = useState(null); // [{row_index, master_id, ...}]
  const [conflictColumns, setConflictColumns] = useState([]); // ordered field list
  const [resolutions, setResolutions] = useState({}); // row_index -> "cleaned"|"master"|"both"

  // Headers come straight from the mapping we already have, so the grid frame
  // renders instantly instead of waiting on the network.
  const columns = useMemo(() => {
    // The server reports the authoritative output columns (mapped + auto-derived
    // Lead Artist + any constant-filled columns) in canonical master order. Fall
    // back to the mapping for the very first paint, before the summary arrives.
    if (summary?.columns?.length) return summary.columns;
    return (file.mapping || [])
      .filter((m) => m.input_header)
      .map((m) => m.master_column);
  }, [file.mapping, summary]);

  // Every master column (mapped or not) — the pick list for "Add column value".
  const allMasterColumns = useMemo(
    () => (file.mapping || []).map((m) => m.master_column),
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

  // Per-column unique-value counts (pipe-aware for name fields) from the profile,
  // shown as a badge in each column header.
  const uniqueByCol = useMemo(() => {
    const m = {};
    (profile?.columns || []).forEach((p) => {
      m[p.name] = p.unique;
    });
    return m;
  }, [profile]);

  // "All" has no page size of its own — ask for more rows than any file holds.
  const apiPageSize = effectivePageSize(pageSize);
  const pages = Math.max(1, Math.ceil(total / apiPageSize));

  // Shared query string so GET /review and the edit/accept mutations all target
  // the same view/tag/page — letting mutations return the refreshed grid in one
  // round-trip instead of a second reload.
  const buildQs = useCallback(
    (withProfile) => {
      const qs = new URLSearchParams({
        view,
        page: String(page),
        page_size: String(apiPageSize),
        include_profile: String(withProfile),
      });
      if (activeTag) qs.set("tag", activeTag);
      if (activeTags.length) qs.set("tags", activeTags.join(","));
      if (sortCol) {
        qs.set("sort", sortCol);
        qs.set("dir", sortDir);
      }
      if (containsCol && containsVal) {
        qs.set("contains_col", containsCol);
        qs.set("contains_val", containsVal);
      }
      return qs.toString();
    },
    [view, page, apiPageSize, activeTag, activeTags, sortCol, sortDir, containsCol, containsVal]
  );

  const applyPayload = useCallback((d) => {
    setSummary(d.summary);
    if (d.profile) setProfile(d.profile);
    setRows(d.rows);
    setTotal(d.total);
  }, []);

  // ONE request gives us summary + quality profile + the current page of rows.
  const load = useCallback(
    async (withProfile) => {
      setLoading(true);
      try {
        applyPayload(await api(`/api/files/${file.id}/review?${buildQs(withProfile)}`));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [file.id, buildQs, applyPayload]
  );

  // Grid rows/summary load on every page/view/tag/filter change. The quality
  // profile is fetched separately (below) so the grid paints without waiting on
  // the heavier profile pass — a noticeable first-load speed-up.
  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Profile only changes when the data does, so fetch it once on mount (its own
  // request, off the critical path). Mutations refresh it via their payload.
  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api(`/api/files/${file.id}/clean/profile`));
    } catch {
      /* non-fatal: the grid works without the profile */
    }
  }, [file.id]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Keep the top scrollbar's width in sync with the grid's full content width so
  // the user can scroll horizontally from the top without reaching the bottom.
  // Only show it when the grid actually overflows (otherwise it's a stray empty
  // bar). A ResizeObserver re-measures on layout shifts (panel open, font load).
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const measure = () => {
      setGridWidth(el.scrollWidth);
      setHasXOverflow(el.scrollWidth > el.clientWidth + 1);
      setFrozenLefts((prev) => {
        const next = measureFrozen(el);
        // Sticky positioning doesn't change layout, so this can't feed back into
        // the ResizeObserver — but bail on an identical result anyway to avoid a
        // pointless re-render of a very large grid.
        return prev.length === next.length && prev.every((v, i) => v === next[i])
          ? prev
          : next;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [rows, displayColumns, loading]);

  function syncFromGrid() {
    if (topScrollRef.current && gridScrollRef.current)
      topScrollRef.current.scrollLeft = gridScrollRef.current.scrollLeft;
  }
  function syncFromTop() {
    if (topScrollRef.current && gridScrollRef.current)
      gridScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
  }

  // Close an open column-header menu when clicking anywhere outside a header.
  // (A document listener, not a backdrop, so the sticky-header stacking context
  // can't hide the menu beneath it.)
  useEffect(() => {
    if (!headerMenuCol) return;
    const onDoc = (e) => {
      if (!e.target.closest(".th-inner") && !e.target.closest(".th-menu")) {
        setHeaderMenuCol(null);
      }
    };
    const close = () => setHeaderMenuCol(null);
    document.addEventListener("mousedown", onDoc);
    // The menu is fixed-positioned, so any scroll would detach it — just close.
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", close, true);
    };
  }, [headerMenuCol]);

  function switchView(v, tag = null) {
    setView(v);
    setActiveTag(tag);
    setPage(0);
    clearSelection();
  }

  // Row count per page. Page 1 is the only page guaranteed to exist afterwards,
  // and a cross-page selection no longer means what it did, so reset both.
  function changePageSize(n) {
    setPageSize(n);
    setPage(0);
    clearSelection();
  }

  // Excel-style frozen panes. `i` is the column's position in displayColumns;
  // the pinned ones get a measured `left` so they stack flush against each other.
  const isFrozen = (i) => i < frozenLefts.length;
  const frozenClass = (i) =>
    isFrozen(i)
      ? ` col-frozen${i === frozenLefts.length - 1 ? " col-frozen-last" : ""}`
      : "";

  function clearSelection() {
    setSelected(new Set());
    setSelectAllPages(false);
  }

  function toggleRow(idx) {
    setSelectAllPages(false);
    setSelected((s) => {
      const n = new Set(s);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });
  }

  // Header checkbox: select / clear every row on the current page.
  function togglePage() {
    const pageIdx = rows.map((r) => r.row_index);
    const allOn = pageIdx.length > 0 && pageIdx.every((i) => selected.has(i));
    setSelectAllPages(false);
    setSelected((s) => {
      const n = new Set(s);
      if (allOn) pageIdx.forEach((i) => n.delete(i));
      else pageIdx.forEach((i) => n.add(i));
      return n;
    });
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

  function markPending(idx, on) {
    setPendingRows((s) => {
      const n = new Set(s);
      on ? n.add(idx) : n.delete(idx);
      return n;
    });
  }

  async function saveRow(row) {
    const values = drafts[row.row_index];
    if (!values) return;
    markPending(row.row_index, true);
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
      markPending(row.row_index, false);
    }
  }

  // Keep one flagged row as-is, with a spinner on that row so the move to the
  // clean set is visibly acknowledged immediately.
  async function keepRow(idx) {
    markPending(idx, true);
    try {
      await acceptRows([idx]);
    } finally {
      markPending(idx, false);
    }
  }

  // Apply ALL pending inline edits in ONE round-trip (the PUT returns the
  // refreshed grid). Rows that become fully clean drop out of review.
  async function applyAllDrafts() {
    if (Object.keys(drafts).length === 0) return;
    setBusy(true);
    setError("");
    try {
      const d = await api(`/api/files/${file.id}/rows?${buildQs(true)}`, {
        method: "PUT",
        body: { edits: drafts },
      });
      setDrafts({});
      applyPayload(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function discardDrafts() {
    setDrafts({});
  }

  // --- Filters ---------------------------------------------------------------
  function openFilters() {
    // Seed the modal with whatever's currently applied so it reflects reality.
    setDraftTags(activeTags);
    setDraftSortCol(sortCol);
    setDraftSortDir(sortDir);
    setShowFilters(true);
  }

  function toggleDraftTag(tag) {
    setDraftTags((t) =>
      t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]
    );
  }

  function applyFilters() {
    setActiveTags(draftTags);
    setSortCol(draftSortCol);
    setSortDir(draftSortDir);
    setPage(0);
    setShowFilters(false);
  }

  function clearFilters() {
    setActiveTags([]);
    setSortCol("");
    setSortDir("asc");
    setDraftTags([]);
    setDraftSortCol("");
    setDraftSortDir("asc");
    setPage(0);
  }

  function removeTagFilter(tag) {
    setActiveTags((t) => t.filter((x) => x !== tag));
    setPage(0);
  }

  // --- Fill a column with a constant value (empty cells only) ----------------
  function openFill(col = "") {
    setHeaderMenuCol(null);
    const chosen = col || allMasterColumns[0] || "";
    setFillCol(chosen);
    setFillVal((file.constants && file.constants[chosen]) || "");
    setShowFill(true);
  }

  // Setting an empty value clears the constant for that column.
  async function applyFill() {
    if (!fillCol) return;
    setFillBusy(true);
    setError("");
    try {
      const d = await api(
        `/api/files/${file.id}/columns/fill?column=${encodeURIComponent(fillCol)}&${buildQs(true)}`,
        { method: "POST", body: { value: fillVal } }
      );
      applyPayload(d);
      setShowFill(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setFillBusy(false);
    }
  }

  // --- Column header menu / editing / unique values --------------------------
  // The grid scrolls with overflow:hidden cells, so an in-flow dropdown would be
  // clipped. Instead we anchor a fixed-position menu to the clicked header.
  function toggleHeaderMenu(col, e) {
    if (headerMenuCol === col) {
      setHeaderMenuCol(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setHeaderMenuPos({ top: r.bottom + 4, left: r.left });
    setHeaderMenuCol(col);
  }

  function startEditCol(col) {
    setHeaderMenuCol(null);
    setEditCol(col);
    setEditConfirmed(false);
  }

  function cancelEditCol() {
    setEditCol(null);
    setEditConfirmed(false);
    discardDrafts();
  }

  async function saveColumnEdits() {
    await applyAllDrafts();
    setEditCol(null);
    setEditConfirmed(false);
  }

  async function openUnique(col) {
    setHeaderMenuCol(null);
    setUniqueCol(col);
    setUniqueSearch("");
    setUniqueValues([]);
    resetMerge();
    setUniqueLoading(true);
    try {
      const d = await api(
        `/api/files/${file.id}/columns/unique?column=${encodeURIComponent(col)}`
      );
      setUniqueValues(d.values || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setUniqueLoading(false);
    }
  }

  // Refresh the unique-values list (after a merge the variant is gone and the
  // canonical value's count has grown).
  async function reloadUnique(col) {
    try {
      const d = await api(
        `/api/files/${file.id}/columns/unique?column=${encodeURIComponent(col)}`
      );
      setUniqueValues(d.values || []);
    } catch (e) {
      setError(e.message);
    }
  }

  function pickUnique(value) {
    setContainsCol(uniqueCol);
    setContainsVal(value);
    setPage(0);
  }

  function clearContains() {
    setContainsCol("");
    setContainsVal("");
    setPage(0);
  }

  // Unique-panel sort: clicking the active key flips its direction; clicking the
  // other key switches to it with a sensible default (count→high first, value→A–Z).
  function pickUniqueSort(key) {
    if (uniqueSortKey === key) {
      setUniqueSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setUniqueSortKey(key);
      setUniqueSortDir(key === "count" ? "desc" : "asc");
    }
  }

  // --- Merge values -----------------------------------------------------------
  function resetMerge() {
    setMergeMode(false);
    setMergePicked(new Set());
    setMergeTarget("");
    setMergeConfirm(null);
  }

  function toggleMergePick(value) {
    setMergePicked((s) => {
      const n = new Set(s);
      n.has(value) ? n.delete(value) : n.add(value);
      return n;
    });
    // Seed the canonical target with the highest-count pick for convenience.
    setMergeTarget((t) => t || value);
  }

  // Step 1: ask the server how many rows the merge would touch, then confirm.
  async function requestMerge() {
    const from = [...mergePicked];
    const to = mergeTarget.trim();
    if (from.length === 0 || !to) return;
    setMergeBusy(true);
    setError("");
    try {
      const d = await api(
        `/api/files/${file.id}/columns/remap/preview?column=${encodeURIComponent(uniqueCol)}`,
        { method: "POST", body: { from_values: from, to } }
      );
      setMergeConfirm({ from, to, count: d.affected_rows });
    } catch (err) {
      setError(err.message);
    } finally {
      setMergeBusy(false);
    }
  }

  // Step 2: apply the confirmed merge — rewrites all matching cells, returns the
  // refreshed grid, then reloads the unique list.
  async function confirmMerge() {
    if (!mergeConfirm) return;
    const col = uniqueCol;
    setMergeBusy(true);
    setError("");
    try {
      const d = await api(
        `/api/files/${file.id}/columns/remap?column=${encodeURIComponent(col)}&${buildQs(true)}`,
        {
          method: "POST",
          body: { from_values: mergeConfirm.from, to: mergeConfirm.to },
        }
      );
      applyPayload(d);
      resetMerge();
      await reloadUnique(col);
    } catch (err) {
      setError(err.message);
    } finally {
      setMergeBusy(false);
    }
  }

  // "Keep as-is": accept rows without changing their values — clears the flags
  // and moves them to clean. `rows: []` + an active tag accepts the whole group;
  // `selectAll` accepts every flagged row in the current view/tag filter.
  async function acceptRows(rowIndexes, selectAll = false) {
    setBusy(true);
    setError("");
    try {
      const qs = buildQs(true) + (selectAll ? "&select_all=true" : "");
      const d = await api(`/api/files/${file.id}/accept?${qs}`, {
        method: "POST",
        body: { rows: rowIndexes },
      });
      applyPayload(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Keep every selected row as-is (or all flagged rows when "select all pages").
  async function keepSelected() {
    if (selectAllPages) await acceptRows([], true);
    else if (selected.size > 0) await acceptRows([...selected]);
    clearSelection();
  }

  // --- Undo a manual clean: back to "Needs review" ---------------------------
  // Destructive (any inline edits on those rows are thrown away), so every entry
  // point routes through a confirmation first.
  function askRevert(rowIndexes, all = false) {
    const count = all ? total : rowIndexes.length;
    if (count > 0) setRevertConfirm({ rows: all ? [] : rowIndexes, all, count });
  }

  // Drops the rows' "kept as-is" acceptance and their corrections, so they
  // re-clean from the original values and their flags come back.
  async function confirmRevert() {
    const req = revertConfirm;
    if (!req) return;
    setRevertConfirm(null);
    // One row reverted from its own button gets the same inline spinner as a keep.
    const single = !req.all && req.rows.length === 1 ? req.rows[0] : null;
    if (single !== null) markPending(single, true);
    setBusy(true);
    setError("");
    try {
      const qs = buildQs(true) + (req.all ? "&select_all=true" : "");
      const d = await api(`/api/files/${file.id}/revert?${qs}`, {
        method: "POST",
        body: { rows: req.rows },
      });
      applyPayload(d);
      clearSelection();
    } catch (err) {
      setError(err.message);
    } finally {
      if (single !== null) markPending(single, false);
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

  // Step 1 of the save: look for clean rows that nearly match a record already
  // in the master dataset. If any are found, the reviewer resolves each pair
  // (which is correct?) before the write; otherwise the save runs straight on.
  async function checkConflicts() {
    setBusy(true);
    setCheckingConflicts(true);
    setError("");
    try {
      const res = await api(`/api/files/${file.id}/conflicts`, { method: "POST" });
      if (!res.conflicts || res.conflicts.length === 0) {
        await commit();
        return;
      }
      setConflictColumns(res.columns || []);
      setConflicts(res.conflicts);
      // Default every pair to "both are correct" — the safe, non-destructive call
      // (store the new row, leave the existing one untouched) until the user picks.
      setResolutions(
        Object.fromEntries(res.conflicts.map((c) => [c.row_index, "both"]))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingConflicts(false);
      setBusy(false);
    }
  }

  // Apply the reviewer's near-duplicate decisions. Any on-the-spot edits are
  // persisted as row corrections FIRST (so the corrected values are what get
  // pushed to the master dataset), then the save runs with the resolutions.
  async function saveConflicts(edits) {
    const hasEdits = edits && Object.keys(edits).length > 0;
    if (hasEdits) {
      setBusy(true);
      setError("");
      try {
        await api(`/api/files/${file.id}/rows`, {
          method: "PUT",
          body: { edits },
        });
      } catch (err) {
        setError(err.message);
        setBusy(false);
        return;
      }
    }
    await commit(conflicts);
  }

  // `pairs` are the resolved near-duplicates (omitted on a conflict-free save).
  async function commit(pairs = null) {
    setBusy(true);
    setSaving(true);
    setProgress(6);
    setError("");
    const body = pairs
      ? {
          resolutions: Object.fromEntries(
            pairs.map((c) => [
              String(c.row_index),
              { decision: resolutions[c.row_index] || "both", master_id: c.master_id },
            ])
          ),
        }
      : undefined;
    // The save is a single request, so we animate an indeterminate bar that
    // creeps toward ~92% while the server de-duplicates and writes, then snaps
    // to 100% on success — so the user can see it's working, not frozen.
    const timer = setInterval(() => {
      setProgress((p) => (p >= 92 ? 92 : p + Math.max(1, (92 - p) * 0.08)));
    }, 280);
    try {
      setConflicts(null);
      const res = await api(`/api/files/${file.id}/commit`, { method: "POST", body });
      clearInterval(timer);
      setProgress(100);
      // Let the full bar register before swapping to the success screen.
      setTimeout(() => {
        setSaving(false);
        setCommitted(res);
        onCommitted?.({ ...file, status: "committed" });
      }, 450);
    } catch (err) {
      clearInterval(timer);
      setSaving(false);
      setProgress(0);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A human-readable descriptor of exactly which filters are active, used to name
  // the download so a folder of exports is self-explanatory — e.g.
  // "Demo(needs_review_manually_corrected_singer_desc).xlsx".
  function buildDownloadName() {
    const slug = (s) =>
      String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const parts = [VIEW_SLUG[view] || "all_rows"];
    if (activeTag) parts.push(tagLabel[activeTag] || activeTag);
    activeTags.forEach((t) => parts.push(tagLabel[t] || t));
    if (sortCol) parts.push(`${sortCol}_${sortDir}`);
    if (containsCol && containsVal) parts.push(`${containsCol}_${containsVal}`);
    const descriptor = parts.map(slug).filter(Boolean).join("_");
    const base =
      slug((file.original_name || "file").replace(/\.[^.]+$/, "")) || "file";
    return `${base}(${descriptor}).xlsx`;
  }

  // Download exactly what the grid is showing: same view + tag + filters + sort,
  // so e.g. "All rows sorted by Singer descending" or "Clean rows containing one
  // singer" come out of Excel matching the screen. No paging — every matching row.
  async function downloadFiltered() {
    setExporting(true);
    setError("");
    try {
      const name = buildDownloadName();
      const qs = new URLSearchParams({ view, filename: name });
      if (activeTag) qs.set("tag", activeTag);
      if (activeTags.length) qs.set("tags", activeTags.join(","));
      if (sortCol) {
        qs.set("sort", sortCol);
        qs.set("dir", sortDir);
      }
      if (containsCol && containsVal) {
        qs.set("contains_col", containsCol);
        qs.set("contains_val", containsVal);
      }
      await download(`/api/files/${file.id}/export?${qs.toString()}`, name);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  // Already saved on a previous visit — show the saved state, not the editable
  // grid, so the same cleaned data isn't offered up for re-saving.
  const alreadySaved = !committed && file.status === "committed";

  if (committed || alreadySaved) {
    const c = committed; // null when arriving at an already-committed batch
    return (
      <div className="theme-light review-page">
        <div className="card empty">
          <div className="success-mark">
            <Icon name="check" size={32} />
          </div>
          <h2>Saved to the master dataset</h2>
          {c ? (
            <p className="muted">
              {c.inserted} new record{c.inserted !== 1 ? "s" : ""} added
              {c.updated > 0 &&
                ` · ${c.updated} existing record${c.updated !== 1 ? "s" : ""} updated to the latest label/publisher`}
              {c.duplicates > 0 &&
                ` · ${c.duplicates} already in the master data (skipped, not stored twice)`}
              {c.skipped_errors > 0 &&
                ` · ${c.skipped_errors} row(s) still had errors and were skipped`}
              .
            </p>
          ) : (
            <p className="muted">
              This batch has already been saved to the master dataset, so it
              isn’t shown again here.
            </p>
          )}
          <Link className="btn primary" to="/" style={{ marginTop: "0.75rem" }}>
            <Icon name="arrowRight" size={16} />
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  const errorsLeft = summary?.errors ?? 0;
  const editedRows = Object.keys(drafts).length;
  const editedCells = Object.values(drafts).reduce(
    (n, o) => n + Object.keys(o).length,
    0
  );

  // Selection state for "select all → keep all at once".
  const pageAllSelected =
    selectAllPages ||
    (rows.length > 0 && rows.every((r) => selected.has(r.row_index)));
  const selectedCount = selectAllPages ? total : selected.size;
  // Offer "all across pages" once the whole page is ticked and more pages exist.
  const canSelectAllPages =
    !selectAllPages && pageAllSelected && total > rows.length;

  return (
    <div className="theme-light review-page">
      {saving && (
        <div className="save-overlay">
          <div className="save-modal">
            <div className="save-spark">
              <Icon name="sparkles" size={22} />
            </div>
            <h3>Saving to the master dataset…</h3>
            <div className="save-progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="muted small">
              {Math.round(progress)}% · de-duplicating and writing records
            </p>
          </div>
        </div>
      )}

      {checkingConflicts && (
        <div className="save-overlay">
          <div className="save-modal">
            <div className="save-spark">
              <Icon name="sparkles" size={22} />
            </div>
            <h3>Checking against the master dataset…</h3>
            <div className="save-progress indeterminate">
              <span />
            </div>
            <p className="muted small">
              Looking for rows that nearly match a record already saved.
            </p>
          </div>
        </div>
      )}

      {conflicts && conflicts.length > 0 && (
        <ConflictReview
          conflicts={conflicts}
          columns={conflictColumns}
          resolutions={resolutions}
          setResolutions={setResolutions}
          busy={busy}
          onCancel={() => setConflicts(null)}
          onConfirm={saveConflicts}
        />
      )}

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
          onClick={() => setShowSaveConfirm(true)}
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

      {/* View tabs + Filters (grouped left), Download (right) */}
      <div className="view-bar">
        <div className="view-left">
          <div className="view-tabs">
            <button className={view === "all" ? "active" : ""} onClick={() => switchView("all")}>
              All rows
            </button>
            <button className={view === "error" ? "active" : ""} onClick={() => switchView("error")}>
              Needs review ({errorsLeft})
            </button>
            <button
              className={view === "auto_clean" ? "active" : ""}
              onClick={() => switchView("auto_clean")}
              title="Rows the tool cleaned on its own — no human touched them"
            >
              Auto Cleaned ({summary?.auto_clean ?? 0})
            </button>
            <button
              className={view === "manual_clean" ? "active" : ""}
              onClick={() => switchView("manual_clean")}
              title="Rows you reviewed — edited or kept as-is — and sent to the clean set"
            >
              Manual Cleaned ({summary?.manual_clean ?? 0})
            </button>
          </div>
          <button className="btn sm filter-btn" onClick={openFilters}>
            <Icon name="filter" size={14} />
            Filters
            {(activeTags.length > 0 || sortCol) && (
              <span className="filter-n">{activeTags.length + (sortCol ? 1 : 0)}</span>
            )}
          </button>
          <button
            className="btn sm"
            onClick={() => openFill()}
            title="Fill every empty cell of a column with one value (filled cells are left untouched)"
          >
            <Icon name="plus" size={14} />
            Add column value
          </button>
        </div>
        <button
          className="btn sm primary"
          onClick={downloadFiltered}
          disabled={exporting || total === 0}
          title="Download these rows (current view, filters and sort) as Excel"
        >
          <Icon name="download" size={14} />
          {exporting ? "Exporting…" : "Download Excel"}
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
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => acceptRows([])}
                title="Keep all these rows as-is and mark them reviewed"
              >
                Keep all as-is
              </button>
              <button className="btn sm" disabled={busy} onClick={() => runBulk("drop")}>
                Drop all
              </button>
            </div>
          )}
        </>
      )}

      {/* Active-filter chips — what's currently applied via the Filters popup */}
      {(activeTags.length > 0 || sortCol || containsCol) && (
        <div className="review-toolbar">
          <div className="active-filters">
            {activeTags.map((t) => (
              <span className="filter-chip" key={t}>
                {tagLabel[t] || t}
                <button onClick={() => removeTagFilter(t)} title="Remove filter">
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            {sortCol && (
              <span className="filter-chip">
                <Icon name="sort" size={12} />
                {sortCol} · {sortDir === "asc" ? "Ascending" : "Descending"}
                <button
                  onClick={() => {
                    setSortCol("");
                    setPage(0);
                  }}
                  title="Remove sort"
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            )}
            {containsCol && (
              <span className="filter-chip alt">
                {containsCol}: “{containsVal}”
                <button onClick={clearContains} title="Clear value filter">
                  <Icon name="x" size={11} />
                </button>
              </span>
            )}
            <button className="link-btn" onClick={() => { clearFilters(); clearContains(); }}>
              Clear all
            </button>
          </div>
        </div>
      )}

      {/* Legend — what the cell colours mean */}
      <div className="grid-legend">
        <span><i className="lg-dot green" /> Auto-fixed (labelled by what changed)</span>
        <span><i className="lg-dot" style={{ background: tagColor("corrected") }} /> Manually corrected</span>
        <span><i className="lg-dot red" /> Needs your review</span>
        <span><i className="lg-dot blank" /> Empty cell</span>
        <span className="muted small lg-hint">
          {view === "manual_clean"
            ? "Ringed cells are the ones you changed · “kept” rows were accepted as-is · tick rows (or use ←) to send them back to review"
            : "Hover a cell to see the original value · click a flagged cell to edit"}
        </span>
      </div>

      {/* Pager above the grid too, so changing page never means scrolling to the
          bottom of a 50-row table first. */}
      <Pager
        page={page}
        pages={pages}
        total={total}
        disabled={loading}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={changePageSize}
      />

      {/* Top horizontal scrollbar, synced with the grid — scroll across columns
          without having to reach the bottom of the table first. Shown only when
          the grid overflows horizontally. */}
      {hasXOverflow && (
        <div
          className="grid-xscroll"
          ref={topScrollRef}
          onScroll={syncFromTop}
          aria-label="Scroll table columns"
          title="Drag to scroll across columns"
        >
          <div className="grid-xscroll-spacer" style={{ width: gridWidth }} />
        </div>
      )}

      {/* Data grid */}
      <div className="grid-scroll" ref={gridScrollRef} onScroll={syncFromGrid}>
        <table className="grid-table">
          <thead>
            <tr>
              <th className="rownum">
                <input
                  type="checkbox"
                  className="row-check"
                  checked={pageAllSelected}
                  onChange={togglePage}
                  title="Select all rows on this page"
                />
              </th>
              {displayColumns.map((c, ci) => (
                <th
                  key={c}
                  className={`${focusSet.has(c) ? "col-focus" : ""}${
                    editCol === c ? " col-editing" : ""
                  }${frozenClass(ci)}`}
                  style={{
                    ...(focusSet.has(c) ? { "--tag": tagColor(activeTag) } : null),
                    ...(isFrozen(ci) ? { left: frozenLefts[ci] } : null),
                  }}
                >
                  <div className="th-inner">
                    <button
                      className="th-label"
                      onClick={(e) => toggleHeaderMenu(c, e)}
                      title="Column options"
                    >
                      {focusSet.has(c) && <span className="col-focus-dot" />}
                      <span className="th-name">{c}</span>
                      {uniqueByCol[c] != null && (
                        <span
                          className="th-unique"
                          title={`${uniqueByCol[c]} unique value${
                            uniqueByCol[c] === 1 ? "" : "s"
                          }`}
                        >
                          {uniqueByCol[c]}
                        </span>
                      )}
                      <span className="th-caret">▾</span>
                    </button>
                  </div>
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
                    {displayColumns.map((c, ci) => (
                      <td
                        key={c}
                        className={frozenClass(ci).trim()}
                        style={isFrozen(ci) ? { left: frozenLefts[ci] } : undefined}
                      >
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
                    <tr
                      key={row.row_index}
                      className={`${row.status === "error" ? "row-err" : ""}${
                        selectAllPages || selected.has(row.row_index) ? " row-sel" : ""
                      }${
                        view === "manual_clean" && row.manual_kind ? " row-manual" : ""
                      }`}
                    >
                      <td className="rownum">
                        <input
                          type="checkbox"
                          className="row-check"
                          checked={selectAllPages || selected.has(row.row_index)}
                          onChange={() => toggleRow(row.row_index)}
                        />
                        <span className="rownum-n">{row.row_index + 1}</span>
                        {pendingRows.has(row.row_index) ? (
                          <span className="row-spin" title="Saving…" />
                        ) : hasDraft ? (
                          <button
                            className="cell-save"
                            title="Apply this row's edits"
                            onClick={() => saveRow(row)}
                          >
                            <Icon name="check" size={12} />
                          </button>
                        ) : row.status === "error" ? (
                          <button
                            className="cell-keep"
                            title="Keep this row as-is (mark reviewed)"
                            onClick={() => keepRow(row.row_index)}
                          >
                            <Icon name="check" size={12} />
                          </button>
                        ) : view === "manual_clean" && row.manual_kind ? (
                          <>
                            {row.manual_kind === "kept" && (
                              // Nothing on this row changed — the reviewer accepted it
                              // as-is, so there's no cell to highlight. Mark the row.
                              <span className="row-kept" title="Kept as-is by a reviewer — values unchanged">
                                kept
                              </span>
                            )}
                            <button
                              className="cell-revert"
                              title="Send this row back to Needs review (undoes the manual clean)"
                              onClick={() => askRevert([row.row_index])}
                            >
                              <Icon name="arrowLeft" size={12} />
                            </button>
                          </>
                        ) : null}
                      </td>
                      {displayColumns.map((c, ci) => {
                        const issue = errs[c];
                        const val = drafts[row.row_index]?.[c] ?? row.values[c] ?? "";
                        // A pinned cell needs the same measured offset as its header.
                        const pin = isFrozen(ci) ? { left: frozenLefts[ci] } : null;
                        // Whole-column edit mode: every cell of this column on the
                        // page becomes a plain editable input (page-only scope).
                        if (editCol === c) {
                          return (
                            <td
                              key={c}
                              className={`cell-edit${frozenClass(ci)}`}
                              style={pin || undefined}
                            >
                              <input
                                value={val}
                                onChange={(e) =>
                                  setDraft(row.row_index, c, e.target.value)
                                }
                              />
                            </td>
                          );
                        }
                        if (issue) {
                          return (
                            <td
                              key={c}
                              className={`cell-flagged${frozenClass(ci)}`}
                              style={{ "--tag": tagColor(issue.tag), ...pin }}
                              title={issue.message}
                            >
                              <input
                                value={val}
                                onChange={(e) => setDraft(row.row_index, c, e.target.value)}
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
                          // A cell a human changed gets a stronger wash + border than the
                          // tool's own green auto-fixes, so it's obvious on a later review.
                          const manual = fix.tag === "corrected";
                          return (
                            <td
                              key={c}
                              className={`cell-fixed${manual ? " cell-manual" : ""}${frozenClass(ci)}`}
                              style={{ "--tag": tagColor(fix.tag), ...pin }}
                              title={`${
                                manual ? "Manually corrected" : tagLabel[fix.tag] || "Auto-fixed"
                              }${from ? ` — was “${from}”` : ""}`}
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
                            className={`${val === "" ? "cell-blank" : ""}${frozenClass(ci)}`}
                            style={pin || undefined}
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
                  {EMPTY_TEXT[view] || "No rows to show."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Sticky selection bar — keep many rows as-is in one go */}
      {selectedCount > 0 && editedRows === 0 && !saving && (
        <div className="edits-bar select-bar">
          <div className="edits-bar-info">
            <span className="edits-bar-dot sel">
              <Icon name="check" size={15} />
            </span>
            <span>
              <strong>{selectedCount}</strong> row{selectedCount !== 1 ? "s" : ""} selected
              {selectAllPages && " (all pages)"}
              {canSelectAllPages && (
                <button className="link-btn" onClick={() => setSelectAllPages(true)}>
                  Select all {total}
                </button>
              )}
            </span>
          </div>
          <div className="edits-bar-actions">
            <button className="btn sm" onClick={clearSelection} disabled={busy}>
              Clear
            </button>
            {view === "manual_clean" ? (
              // These rows are already clean — the only useful bulk action is to
              // undo the manual clean and send them back to the review queue.
              <button
                className="btn danger sm"
                onClick={() => askRevert([...selected], selectAllPages)}
                disabled={busy}
                title="Undo the manual clean and put these rows back in Needs review"
              >
                <Icon name="arrowLeft" size={15} />
                {busy ? "Reverting…" : "Send back to review"}
              </button>
            ) : (
              <button className="btn primary sm" onClick={keepSelected} disabled={busy}>
                <Icon name="check" size={15} />
                {busy ? "Keeping…" : "Keep selected as-is"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Column-edit bar — confirm + save the whole-column edits on this page */}
      {editCol && !saving && (
        <div className="edits-bar col-edit-bar">
          <div className="edits-bar-info">
            <span className="edits-bar-dot">
              <Icon name="edit" size={15} />
            </span>
            <span>
              Editing <strong>{editCol}</strong> on this page —{" "}
              <strong>{editedCells}</strong> change{editedCells !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="edits-bar-actions">
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={editConfirmed}
                onChange={(e) => setEditConfirmed(e.target.checked)}
              />
              Confirm edits
            </label>
            <button className="btn sm" onClick={cancelEditCol} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary sm"
              onClick={saveColumnEdits}
              disabled={busy || !editConfirmed || editedCells === 0}
            >
              <Icon name="check" size={15} />
              {busy ? "Saving…" : "Save column changes"}
            </button>
          </div>
        </div>
      )}

      {/* Sticky "you have unsaved edits" bar — explicit apply/discard, batch-wide */}
      {editedRows > 0 && !editCol && !saving && (
        <div className="edits-bar">
          <div className="edits-bar-info">
            <span className="edits-bar-dot">
              <Icon name="check" size={15} />
            </span>
            <span>
              <strong>{editedCells}</strong> edit{editedCells !== 1 ? "s" : ""} in{" "}
              <strong>{editedRows}</strong> row{editedRows !== 1 ? "s" : ""} — not applied yet
            </span>
          </div>
          <div className="edits-bar-actions">
            <button className="btn sm" onClick={discardDrafts} disabled={busy}>
              Discard
            </button>
            <button className="btn primary sm" onClick={applyAllDrafts} disabled={busy}>
              <Icon name="check" size={15} />
              {busy ? "Applying…" : "Apply edits & move clean rows out"}
            </button>
          </div>
        </div>
      )}

      {/* Pagination */}
      <Pager
        page={page}
        pages={pages}
        total={total}
        disabled={loading}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={changePageSize}
      />

      {/* Column-header menu — fixed-positioned so the scroll container can't clip it */}
      {headerMenuCol && headerMenuPos && (
        <div
          className="th-menu"
          style={{ top: headerMenuPos.top, left: headerMenuPos.left }}
        >
          <button onClick={() => startEditCol(headerMenuCol)}>
            <Icon name="edit" size={13} /> Edit column
          </button>
          <button onClick={() => openFill(headerMenuCol)}>
            <Icon name="plus" size={13} /> Fill empty cells…
          </button>
          <button onClick={() => openUnique(headerMenuCol)}>
            <Icon name="table" size={13} /> Show unique values
            {uniqueByCol[headerMenuCol] != null
              ? ` (${uniqueByCol[headerMenuCol]})`
              : ""}
          </button>
        </div>
      )}

      {/* Filter popup — cleaning categories (match ANY) + sort */}
      {showFilters && (
        <div className="save-overlay" onClick={() => setShowFilters(false)}>
          <div className="filter-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filter-modal-head">
              <h3>
                <Icon name="filter" size={16} /> Filters
              </h3>
              <button className="icon-btn" onClick={() => setShowFilters(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="filter-section">
              <label className="filter-section-label">What the tool cleaned</label>
              {(summary?.fix_tags || []).length === 0 ? (
                <p className="muted small">No cleaning categories to filter by.</p>
              ) : (
                <div className="filter-checks">
                  {summary.fix_tags.map((t) => (
                    <label className="filter-check" key={t.tag}>
                      <input
                        type="checkbox"
                        checked={draftTags.includes(t.tag)}
                        onChange={() => toggleDraftTag(t.tag)}
                      />
                      <span className="tag-dot" style={{ "--tag": tagColor(t.tag) }} />
                      {t.label}
                      <span className="n">{t.count}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="filter-section">
              <label className="filter-section-label">Sort rows</label>
              <div className="filter-sort">
                <select value={draftSortDir} onChange={(e) => setDraftSortDir(e.target.value)}>
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <select value={draftSortCol} onChange={(e) => setDraftSortCol(e.target.value)}>
                  <option value="">No sorting</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="filter-modal-actions">
              <button className="btn sm" onClick={clearFilters}>
                Clear
              </button>
              <button className="btn primary sm" onClick={applyFilters}>
                Apply filter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fill-a-column popup — broadcast a constant into empty cells only */}
      {showFill && (
        <div className="save-overlay" onClick={() => setShowFill(false)}>
          <div className="filter-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filter-modal-head">
              <h3>
                <Icon name="plus" size={16} /> Add a column value
              </h3>
              <button className="icon-btn" onClick={() => setShowFill(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="filter-section">
              <label className="filter-section-label">Column</label>
              <select
                value={fillCol}
                onChange={(e) => {
                  const c = e.target.value;
                  setFillCol(c);
                  setFillVal((file.constants && file.constants[c]) || "");
                }}
              >
                {allMasterColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-section">
              <label className="filter-section-label">
                Value to fill into empty cells
              </label>
              <input
                placeholder="e.g. Artium | Goongoonalo  or  50 | 50"
                value={fillVal}
                onChange={(e) => setFillVal(e.target.value)}
                autoFocus
              />
              <p className="muted small" style={{ marginTop: "0.5rem" }}>
                This fills <strong>every empty cell</strong> of{" "}
                <strong>{fillCol || "the column"}</strong> with this value. Cells
                that already have a value are <strong>left untouched</strong>.
                Clear the box and apply to remove the fill.
              </p>
            </div>

            <div className="filter-modal-actions">
              <button className="btn sm" onClick={() => setShowFill(false)} disabled={fillBusy}>
                Cancel
              </button>
              <button
                className="btn primary sm"
                onClick={applyFill}
                disabled={fillBusy || !fillCol}
              >
                {fillBusy ? "Filling…" : fillVal.trim() ? "Fill empty cells" : "Clear fill"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save confirmation popup */}
      {showSaveConfirm && (
        <div className="save-overlay" onClick={() => setShowSaveConfirm(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-spark">
              <Icon name="check" size={22} />
            </div>
            <h3>Save to the master dataset?</h3>
            <p className="muted">
              This will save <strong>{summary?.clean ?? 0}</strong> clean row
              {summary?.clean === 1 ? "" : "s"} to the master dataset. Rows that
              still need review are skipped.
            </p>
            <div className="confirm-actions">
              <button className="btn sm" onClick={() => setShowSaveConfirm(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn primary sm"
                onClick={() => {
                  setShowSaveConfirm(false);
                  checkConflicts();
                }}
                disabled={busy}
              >
                <Icon name="check" size={15} />
                Save {summary?.clean ?? 0} row{summary?.clean === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* "Send back to review" confirmation — it discards manual edits, so ask */}
      {revertConfirm && (
        <div className="save-overlay" onClick={() => setRevertConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-spark danger">
              <Icon name="arrowLeft" size={22} />
            </div>
            <h3>
              Send {revertConfirm.count} row{revertConfirm.count === 1 ? "" : "s"} back to
              review?
            </h3>
            <p className="muted">
              <strong>Manual edits on these rows are discarded</strong> — the tool’s own
              cleaned values come back, along with any flags, so they’ll need reviewing
              again. A row that had no flags to begin with just moves to Auto Cleaned.
            </p>
            <div className="confirm-actions">
              <button className="btn sm" onClick={() => setRevertConfirm(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger sm" onClick={confirmRevert} disabled={busy}>
                <Icon name="arrowLeft" size={15} />
                {busy ? "Reverting…" : "Send back to review"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unique-values side panel — click a value to filter the grid by it */}
      {uniqueCol && (
        <div className="unique-overlay" onClick={() => setUniqueCol(null)}>
          <aside className="unique-panel" onClick={(e) => e.stopPropagation()}>
            <div className="unique-head">
              <div>
                <h3>Unique values</h3>
                <span className="muted small">{uniqueCol}</span>
              </div>
              <button className="icon-btn" onClick={() => setUniqueCol(null)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="unique-search">
              <Icon name="search" size={14} />
              <input
                placeholder="Search values…"
                value={uniqueSearch}
                onChange={(e) => setUniqueSearch(e.target.value)}
              />
            </div>
            <div className="unique-sortbar">
              <span className="muted small">
                {uniqueValues.length} value{uniqueValues.length === 1 ? "" : "s"}
              </span>
              <div className="unique-sort-opts">
                <span className="muted small">Sort by</span>
                <button
                  className={`unique-sort ${uniqueSortKey === "count" ? "active" : ""}`}
                  onClick={() => pickUniqueSort("count")}
                  title="Sort by how many rows carry each value"
                >
                  <span className="sort-key-label">Count</span>
                  {uniqueSortKey === "count" && (
                    <span className="sort-arrow">{uniqueSortDir === "desc" ? "↓" : "↑"}</span>
                  )}
                </button>
                <button
                  className={`unique-sort ${uniqueSortKey === "value" ? "active" : ""}`}
                  onClick={() => pickUniqueSort("value")}
                  title={`Sort by ${uniqueCol} alphabetically`}
                >
                  <span className="sort-key-label">{uniqueCol}</span>
                  {uniqueSortKey === "value" && (
                    <span className="sort-arrow">{uniqueSortDir === "desc" ? "↓" : "↑"}</span>
                  )}
                </button>
              </div>
            </div>

            {/* Merge variants into one canonical value — tick the duplicates,
                type the correct spelling, confirm. Applies to every matching cell
                (pipe-aware) but only when the reviewer confirms. */}
            <div className="unique-mergebar">
              <button
                className={`btn sm ${mergeMode ? "primary" : ""}`}
                onClick={() => (mergeMode ? resetMerge() : setMergeMode(true))}
                title="Merge spelling variants of the same name into one"
              >
                <Icon name="check" size={14} />
                {mergeMode ? "Cancel merge" : "Merge values"}
              </button>
              {mergeMode && (
                <span className="muted small">
                  Tick the variants to merge, then choose the correct value.
                </span>
              )}
            </div>
            <div className="unique-list">
              {uniqueLoading ? (
                <p className="muted small" style={{ padding: "0.75rem" }}>
                  Loading…
                </p>
              ) : (
                (() => {
                  const q = uniqueSearch.trim().toLowerCase();
                  const filtered = q
                    ? uniqueValues.filter((u) => u.value.toLowerCase().includes(q))
                    : uniqueValues;
                  const shown = [...filtered].sort((a, b) => {
                    if (uniqueSortKey === "value") {
                      const cmp = a.value.localeCompare(b.value, undefined, {
                        numeric: true,
                        sensitivity: "base",
                      });
                      return uniqueSortDir === "desc" ? -cmp : cmp;
                    }
                    return uniqueSortDir === "desc"
                      ? b.count - a.count
                      : a.count - b.count;
                  });
                  if (shown.length === 0)
                    return (
                      <p className="muted small" style={{ padding: "0.75rem" }}>
                        No matching values.
                      </p>
                    );
                  if (mergeMode) {
                    return shown.map((u) => (
                      <label
                        className={`unique-row${
                          mergePicked.has(u.value) ? " picked" : ""
                        }`}
                        key={u.value}
                        title="Select this variant to merge into the canonical value"
                      >
                        <input
                          type="checkbox"
                          className="row-check"
                          checked={mergePicked.has(u.value)}
                          onChange={() => toggleMergePick(u.value)}
                        />
                        <span className="unique-val">{u.value}</span>
                        <span className="unique-count">{u.count}</span>
                      </label>
                    ));
                  }
                  return shown.map((u) => (
                    <button
                      className={`unique-row${
                        containsCol === uniqueCol && containsVal === u.value
                          ? " active"
                          : ""
                      }`}
                      key={u.value}
                      onClick={() => pickUnique(u.value)}
                      title="Filter the grid to rows containing this value"
                    >
                      <span className="unique-val">{u.value}</span>
                      <span className="unique-count">{u.count}</span>
                    </button>
                  ));
                })()
              )}
            </div>
            {mergeMode && (
              <div className="unique-merge-foot">
                <datalist id="merge-target-list">
                  {uniqueValues.map((u) => (
                    <option key={u.value} value={u.value} />
                  ))}
                </datalist>
                <label className="muted small">
                  Merge {mergePicked.size} selected into:
                </label>
                <input
                  list="merge-target-list"
                  placeholder="correct value (e.g. Shreya Ghoshal)"
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value)}
                />
                <button
                  className="btn primary sm"
                  disabled={mergeBusy || mergePicked.size === 0 || !mergeTarget.trim()}
                  onClick={requestMerge}
                >
                  {mergeBusy ? "Checking…" : "Merge…"}
                </button>
              </div>
            )}
            {!mergeMode && containsCol === uniqueCol && containsVal && (
              <div className="unique-foot">
                <span className="muted small">
                  Filtering by “{containsVal}”
                </span>
                <button className="link-btn" onClick={clearContains}>
                  Clear
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Merge confirmation — shows the blast radius before any cell changes */}
      {mergeConfirm && (
        <div className="save-overlay" onClick={() => !mergeBusy && setMergeConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-spark">
              <Icon name="check" size={22} />
            </div>
            <h3>Merge values?</h3>
            <p className="muted">
              Rename{" "}
              {mergeConfirm.from.map((v, i) => (
                <span key={v}>
                  {i > 0 && ", "}
                  <strong>“{v}”</strong>
                </span>
              ))}{" "}
              → <strong>“{mergeConfirm.to}”</strong> across{" "}
              <strong>{mergeConfirm.count}</strong> row
              {mergeConfirm.count === 1 ? "" : "s"} in {uniqueCol}.
            </p>
            <p className="muted small">
              Stored as reviewable corrections — the changed cells show as
              auto-fixed and can be merged back if needed.
            </p>
            <div className="confirm-actions">
              <button
                className="btn sm"
                onClick={() => setMergeConfirm(null)}
                disabled={mergeBusy}
              >
                Cancel
              </button>
              <button
                className="btn primary sm"
                onClick={confirmMerge}
                disabled={mergeBusy || mergeConfirm.count === 0}
              >
                <Icon name="check" size={15} />
                {mergeBusy ? "Merging…" : `Merge ${mergeConfirm.count} row${mergeConfirm.count === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The three calls a reviewer can make on a near-duplicate pair.
const CHOICES = [
  { key: "cleaned", label: "Cleaned is correct", hint: "Update the master record with this row" },
  { key: "master", label: "Master is correct", hint: "Keep the existing record, skip this row" },
  { key: "both", label: "Both are correct", hint: "Keep both — add this row as a new record" },
];

// Mirror of the backend's value normalization so the "differs" highlight updates
// live as the reviewer edits a cleaned cell.
const normVal = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// A full-screen review of clean rows that nearly match an existing master record.
// Each pair is stacked (cleaned above master) with the differing fields
// highlighted so the reviewer can cross-verify, edit on the spot, and pick which
// one is right.
function ConflictReview({
  conflicts,
  columns,
  resolutions,
  setResolutions,
  busy,
  onCancel,
  onConfirm,
}) {
  // On-the-spot corrections to the cleaned rows: { row_index: { column: value } }.
  // These are saved as row corrections before the push, so the master dataset
  // gets the edited values.
  const [edits, setEdits] = useState({});

  const setOne = (rowIndex, decision) =>
    setResolutions((prev) => ({ ...prev, [rowIndex]: decision }));
  const setAll = (decision) =>
    setResolutions(Object.fromEntries(conflicts.map((c) => [c.row_index, decision])));

  // The effective cleaned value for a cell — the reviewer's edit if any, else
  // the originally cleaned value.
  const cleanedVal = (c, col) => {
    const e = edits[c.row_index]?.[col];
    return e !== undefined ? e : c.cleaned[col] ?? "";
  };
  const setCell = (rowIndex, col, value) =>
    setEdits((prev) => ({
      ...prev,
      [rowIndex]: { ...prev[rowIndex], [col]: value },
    }));

  return (
    <div className="save-overlay">
      <div className="conflict-modal">
        <div className="conflict-head">
          <div>
            <h3>
              <Icon name="alert" size={18} />
              {conflicts.length} possible duplicate
              {conflicts.length === 1 ? "" : "s"} found
            </h3>
            <p className="muted small">
              These clean rows almost match a record already in the master
              dataset. The cleaned row is shown above the existing master record —
              the highlighted cells are what differ. Edit the cleaned values to fix
              them on the spot, then tell us which is correct before saving.
            </p>
          </div>
          <div className="conflict-bulk">
            <span className="muted small">Apply to all:</span>
            {CHOICES.map((ch) => (
              <button
                key={ch.key}
                className="btn sm ghost"
                onClick={() => setAll(ch.key)}
                title={ch.hint}
              >
                {ch.label}
              </button>
            ))}
          </div>
        </div>

        <div className="conflict-body">
          {conflicts.map((c) => {
            const choice = resolutions[c.row_index] || "both";
            // Live diff: a cell is highlighted while the (possibly edited)
            // cleaned value still differs from the master value.
            const isDiff = (col) => normVal(cleanedVal(c, col)) !== normVal(c.master[col]);
            const liveDiffs = c.differences.filter(isDiff);
            return (
              <div className="conflict-card" key={c.row_index}>
                <div className="conflict-card-head">
                  <span className="conflict-badge">
                    <Icon name="alert" size={14} />
                    Possible duplicate
                  </span>
                  <span className="muted small">
                    {liveDiffs.length} of {c.differences.length} field
                    {c.differences.length === 1 ? "" : "s"} still differ
                  </span>
                </div>

                {/* Quick scan of the differing fields — cleaned side is editable */}
                <div className="conflict-diffs">
                  <div className="conflict-diff-row conflict-diff-header">
                    <span className="conflict-diff-field">Field</span>
                    <span className="conflict-diff-cleaned">Cleaned (editable)</span>
                    <span className="conflict-diff-master">In master dataset</span>
                  </div>
                  {c.differences.map((col) => (
                    <div
                      className={`conflict-diff-row${isDiff(col) ? "" : " resolved"}`}
                      key={col}
                    >
                      <span className="conflict-diff-field">{col}</span>
                      <span className="conflict-diff-cleaned">
                        <input
                          value={cleanedVal(c, col)}
                          onChange={(e) => setCell(c.row_index, col, e.target.value)}
                          placeholder="—"
                        />
                      </span>
                      <span className="conflict-diff-master">
                        {c.master[col] || "—"}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Full records, stacked: cleaned on top, master below */}
                <div className="conflict-table-wrap">
                  <table className="conflict-table">
                    <thead>
                      <tr>
                        <th className="rowlabel" />
                        {columns.map((col) => (
                          <th key={col} className={isDiff(col) ? "diff" : ""}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="cleaned-row">
                        <th className="rowlabel">
                          <span className="conflict-tag cleaned">Cleaned</span>
                        </th>
                        {columns.map((col) => (
                          <td key={col} className={isDiff(col) ? "diff" : ""}>
                            {cleanedVal(c, col) || "—"}
                          </td>
                        ))}
                      </tr>
                      <tr className="master-row">
                        <th className="rowlabel">
                          <span className="conflict-tag master">Master</span>
                        </th>
                        {columns.map((col) => (
                          <td key={col} className={isDiff(col) ? "diff" : ""}>
                            {c.master[col] || "—"}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Decision */}
                <div className="conflict-choices">
                  {CHOICES.map((ch) => (
                    <button
                      key={ch.key}
                      className={`conflict-choice${choice === ch.key ? " active" : ""}`}
                      onClick={() => setOne(c.row_index, ch.key)}
                      title={ch.hint}
                    >
                      {ch.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="conflict-foot">
          <button className="btn sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary sm"
            onClick={() => onConfirm(edits)}
            disabled={busy}
          >
            <Icon name="check" size={15} />
            Apply &amp; save
          </button>
        </div>
      </div>
    </div>
  );
}
