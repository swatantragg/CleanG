// Workflow state machine. Holds UI state only; every data operation
// (meta, parse, clean, validate, master writes, extract) calls the backend.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { workflowApi } from "../api/workflow";
import { titleCase, slug } from "../utils/text";

const EMPTY_PRESETS = { PDL: [], SVF: [], Custom: [] };

export function useWorkflow() {
  const [step, setStep] = useState(0);

  // config fetched from backend
  const [presets, setPresets] = useState(EMPTY_PRESETS);

  // ingest result
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [fields, setFields] = useState([]); // master schema (builtins + dynamic)
  const [mapping, setMapping] = useState({}); // fieldKey -> [sourceHeader]
  const [suggestions, setSuggestions] = useState({}); // fieldKey -> [sourceHeader]

  // pipeline results
  const [cleanRows, setCleanRows] = useState(null);
  const [reviewRows, setReviewRows] = useState(null);
  const [master, setMaster] = useState([]);
  const [dedupLog, setDedupLog] = useState([]);
  const [cleanUploaded, setCleanUploaded] = useState(false);

  // extraction
  const [preset, setPreset] = useState("PDL");
  const [extra, setExtra] = useState([]);
  const [csv, setCsv] = useState("");

  // ui
  const [toast, setToast] = useState(null);
  const [hot, setHot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ingestError, setIngestError] = useState("");
  const fileRef = useRef();
  const reviewDebounce = useRef();
  const pendingRevalidate = useRef([]);

  const flash = useCallback((m) => {
    setToast(m);
    clearTimeout(window.__t);
    window.__t = setTimeout(() => setToast(null), 2800);
  }, []);

  /* ---- bootstrap: load config + any existing master ---- */
  useEffect(() => {
    (async () => {
      try {
        const meta = await workflowApi.meta();
        setPresets(meta.presets || EMPTY_PRESETS);
        setFields(meta.builtins || []);
        const m = await workflowApi.getMaster();
        setMaster(m.master || []);
        setDedupLog(m.dedupLog || []);
      } catch (e) {
        flash(e.message || "Could not load configuration");
      }
    })();
  }, [flash]);

  /* ---- ingest ---- */
  const onFile = async (file) => {
    if (!file) return;
    setIngestError("");
    setBusy(true);
    try {
      const res = await workflowApi.ingest(file);
      setHeaders(res.headers);
      setRawRows(res.rows);
      setFileName(res.fileName);
      setFields(res.fields);
      setMapping(res.mapping || {});
      setSuggestions(res.suggestions || {});
      setCleanRows(null);
      setReviewRows(null);
      setCleanUploaded(false);
      setStep(1);
      flash(`Loaded ${res.rows.length} rows · ${res.headers.length} columns`);
    } catch (e) {
      setIngestError(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  /* ---- mapping ops ---- */
  const toggleMap = (fk, src) => {
    setMapping((prev) => {
      const cur = prev[fk] || [];
      const next = cur.includes(src) ? cur.filter((s) => s !== src) : [...cur, src];
      return { ...prev, [fk]: next };
    });
  };
  const mappedSources = useMemo(() => {
    const s = new Set();
    Object.values(mapping).forEach((a) => (a || []).forEach((x) => s.add(x)));
    return s;
  }, [mapping]);
  const unmapped = headers.filter((h) => !mappedSources.has(h));
  const addColumn = (src) => {
    const key = "x_" + slug(src);
    if (fields.some((f) => f.key === key)) {
      flash("Column already added");
      return;
    }
    setFields((prev) => [...prev, { key, label: titleCase(src), sub: "new master column", type: "text", dynamic: true }]);
    setMapping((prev) => ({ ...prev, [key]: [src] }));
    flash(`Created master column “${titleCase(src)}”`);
  };
  const requiredMapped = fields
    .filter((f) => !f.dynamic)
    .every((b) => (mapping[b.key] || []).length > 0);

  /* ---- clean ---- */
  const runClean = async () => {
    setBusy(true);
    try {
      const res = await workflowApi.clean(rawRows, fields, mapping);
      setCleanRows(res.clean);
      setReviewRows(res.review);
      setCleanUploaded(false);
      setStep(3);
      flash(`Cleaned ${rawRows.length} rows → ${res.clean.length} clean · ${res.review.length} for review`);
    } catch (e) {
      flash(e.message || "Cleaning failed");
    } finally {
      setBusy(false);
    }
  };

  /* ---- clean-grid edits (validation happens at upload) ---- */
  const editClean = (id, key, val) =>
    setCleanRows((rows) => rows.map((r) => (r._id === id ? { ...r, [key]: val } : r)));

  /* ---- review edits with debounced backend revalidation ---- */
  const revalidateReview = async (rows) => {
    try {
      const res = await workflowApi.validate(rows);
      const map = Object.fromEntries(res.results.map((x) => [x._id, x]));
      setReviewRows((cur) =>
        cur.map((r) => {
          const v = map[r._id];
          return v ? { ...r, issues: v.issues, isrcDisplay: v.isrcDisplay } : r;
        })
      );
    } catch {
      /* leave issues as-is on transient errors */
    }
  };
  const editReview = (id, key, val) => {
    setReviewRows((rows) => {
      const next = rows.map((r) => (r._id === id ? { ...r, [key]: val } : r));
      pendingRevalidate.current = next;
      return next;
    });
    clearTimeout(reviewDebounce.current);
    reviewDebounce.current = setTimeout(() => revalidateReview(pendingRevalidate.current), 350);
  };

  /* ---- master writes ---- */
  const uploadClean = async () => {
    setBusy(true);
    try {
      const res = await workflowApi.uploadClean(cleanRows);
      setMaster(res.master);
      setDedupLog(res.dedupLog);
      setCleanRows([]);
      setCleanUploaded(true);
      if (res.moved.length) setReviewRows((rev) => [...(rev || []), ...res.moved]);
      flash(
        `Uploaded ${res.added} to Master DB${res.dups ? ` · ${res.dups} duplicate(s) skipped` : ""}${
          res.moved.length ? ` · ${res.moved.length} sent to review` : ""
        }`
      );
      setStep(res.moved.length ? 4 : 5);
    } catch (e) {
      flash(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  const approveReview = async (id) => {
    const rec = reviewRows.find((r) => r._id === id);
    if (!rec || (rec.issues || []).length) return;
    try {
      const res = await workflowApi.approve(rec);
      setMaster(res.master);
      setDedupLog(res.dedupLog);
      setReviewRows((rows) => rows.filter((r) => r._id !== id));
      flash(res.dups ? "Duplicate found on upload — record skipped" : "Record corrected & uploaded to Master DB");
    } catch (e) {
      flash(e.message || "Approve failed");
    }
  };
  const resetMaster = async () => {
    try {
      const res = await workflowApi.resetMaster();
      setMaster(res.master);
      setDedupLog(res.dedupLog);
      flash("Master database cleared");
    } catch (e) {
      flash(e.message || "Reset failed");
    }
  };

  /* ---- extraction ---- */
  const presetCols = presets[preset] || [];
  const extractCols = [...presetCols, ...extra.filter((e) => !presetCols.includes(e))];
  const extraOptions = fields.filter((f) => !presetCols.includes(f.key));
  const toggleExtra = (k) => setExtra((e) => (e.includes(k) ? e.filter((x) => x !== k) : [...e, k]));

  // Refresh the CSV preview whenever the export shape changes (on the extract step).
  useEffect(() => {
    if (step !== 6) return;
    let alive = true;
    (async () => {
      try {
        const res = await workflowApi.extract(preset, extra, fields);
        if (alive) setCsv(res.csv);
      } catch {
        if (alive) setCsv("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [step, preset, extra, fields, master]);

  const extract = async () => {
    try {
      const res = await workflowApi.extract(preset, extra, fields);
      const blob = new Blob([res.csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      flash(`Extracted ${res.count} records · ${preset} preset`);
    } catch (e) {
      flash(e.message || "Download blocked — copy the CSV preview below");
    }
  };

  /* ---- step gating ---- */
  const reviewCount = reviewRows ? reviewRows.length : 0;
  const steps = [
    { t: "Ingest",           s: "upload file",                                  done: rawRows.length > 0,                                              enabled: true },
    { t: "Map columns",      s: "source → master",                              done: cleanRows !== null,                                              enabled: rawRows.length > 0 },
    { t: "Clean & validate", s: "run pipeline",                                 done: cleanRows !== null,                                              enabled: requiredMapped && rawRows.length > 0 },
    { t: "Cleaned review",   s: cleanRows ? `${cleanRows.length} rows` : "—",   done: cleanUploaded,                                                   enabled: cleanRows !== null },
    { t: "Human review",     s: reviewRows ? `${reviewCount} flagged` : "—",    done: cleanRows !== null && reviewCount === 0 && cleanUploaded,         enabled: reviewRows !== null },
    { t: "Master data",      s: `${master.length} records`,                     done: false,                                                           enabled: master.length > 0 || cleanRows !== null },
    { t: "Extraction",       s: "presets",                                      done: false,                                                           enabled: master.length > 0 },
  ];

  return {
    step, setStep, steps,
    fields, headers, rawRows, fileName, mapping, suggestions,
    cleanRows, reviewRows, master, dedupLog, cleanUploaded, reviewCount,
    toast, hot, setHot, busy, ingestError, fileRef,
    onFile,
    toggleMap, mappedSources, unmapped, addColumn, requiredMapped,
    runClean, editClean, editReview, uploadClean, approveReview, resetMaster,
    preset, setPreset, presets, extractCols, extraOptions, extra, toggleExtra, extract, csv,
  };
}
