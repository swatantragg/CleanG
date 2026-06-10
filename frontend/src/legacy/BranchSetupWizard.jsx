/* ============================================================
   Branch Setup Wizard — Upload → Primary key → Preset / Custom
   Operates on the active branch (status "setup").
   ============================================================ */
import React, { useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { Icon } from "../components/ui.jsx";

const MB_20 = 20 * 1024 * 1024;

export function BranchSetupWizard({ ctx }) {
  const b = ctx.activeBranch;
  if (!b) return React.createElement("div", { className: "page" }, React.createElement("div", { className: "empty" }, "No branch in setup."));
  const [step, setStep] = useState(b.files && b.files.length ? b.primaryKey ? 2 : 1 : 0);
  const steps = ["Upload files", "Choose primary key", "Pick a preset"];

  return React.createElement("div", { className: "page fade" },
    React.createElement("div", { className: "page-head between" },
      React.createElement("div", null,
        React.createElement("div", { className: "ey" }, "New branch · " + b.name),
        React.createElement("h1", null, "Set up cleansing")),
      React.createElement("button", { className: "btn danger sm", onClick: function () { ctx.confirmDelete(b.id); } },
        React.createElement(Icon, { name: "alert", size: 14 }), "Delete branch")),
    React.createElement("div", { className: "wizard-steps" },
      steps.map(function (s, i) {
        return React.createElement(React.Fragment, { key: i },
          React.createElement("div", { className: "wstep " + (step === i ? "active" : step > i ? "done" : "") },
            React.createElement("span", { className: "wn" }, step > i ? React.createElement(Icon, { name: "check", size: 14 }) : i + 1),
            React.createElement("span", { className: "wl" }, s)),
          i < steps.length - 1 ? React.createElement("span", { className: "wbar" + (step > i ? " done" : ""), style: { display: "inline-block" } }) : null);
      })),
    step === 0 ? React.createElement(UploadStep, { ctx: ctx, b: b, next: function () { setStep(1); } })
    : step === 1 ? React.createElement(PrimaryKeyStep, { ctx: ctx, b: b, back: function () { setStep(0); }, next: function () { setStep(2); } })
    : React.createElement(PresetStep, { ctx: ctx, b: b, back: function () { setStep(1); } }));
}

function humanSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

function UploadStep({ ctx, b, next }) {
  const maxBytes = (ctx.config && ctx.config.maxBytes) || MB_20;
  const files = b.files || [];
  const hasError = files.some(function (f) { return f.error; });
  const validCount = files.filter(function (f) { return !f.error; }).length;
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  function ingest(fileList) {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;
    setBusy(true);
    let pending = arr.length;
    function settle() { pending--; if (pending <= 0) setBusy(false); }

    arr.forEach(function (file) {
      const id = "up_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const base = { id: id, file: file.name, size: humanSize(file.size), bytes: file.size, rows: 0, columns: [] };
      const lower = file.name.toLowerCase();
      const okType = lower.endsWith(".csv") || lower.endsWith(".xlsx");
      function done(extra) { ctx.addFile(b.id, Object.assign({}, base, extra)); settle(); }

      if (!okType) { done({ error: "Unsupported type — only CSV or XLSX files are allowed." }); return; }
      if (file.size === 0) { done({ error: "Empty file — 0 KB. Nothing to read." }); return; }
      if (file.size > maxBytes) { done({ error: "Exceeds the 20 MB per-file limit." }); return; }

      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
          const columns = (rows[0] || []).map(function (c) { return String(c).trim(); }).filter(Boolean);
          if (!columns.length) { done({ error: "Could not read column headers from the file." }); return; }
          done({ rows: Math.max(0, rows.length - 1), columns: columns, error: null });
        } catch (err) {
          done({ error: "File is corrupted — could not be parsed." });
        }
      };
      reader.onerror = function () { done({ error: "Could not read the file." }); };
      reader.readAsArrayBuffer(file);
    });
  }

  function onPick(e) { ingest(e.target.files); e.target.value = ""; }

  return React.createElement("div", null,
    React.createElement("div", { className: "criteria" },
      crit("doc", "CSV or XLSX only"), crit("upload", "Up to 20 MB per file"), crit("table", "Multiple files allowed")),

    React.createElement("input", {
      ref: inputRef, type: "file", accept: ".csv,.xlsx", multiple: true,
      style: { display: "none" }, onChange: onPick,
    }),
    React.createElement("div", {
      className: "dropzone" + (over ? " over" : ""), role: "button", tabIndex: 0,
      onClick: function () { if (inputRef.current) inputRef.current.click(); },
      onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current && inputRef.current.click(); } },
      onDragOver: function (e) { e.preventDefault(); setOver(true); },
      onDragLeave: function () { setOver(false); },
      onDrop: function (e) { e.preventDefault(); setOver(false); ingest(e.dataTransfer.files); },
      style: { marginBottom: 18, cursor: "pointer" },
    },
      React.createElement(Icon, { name: "upload", size: 30, style: { color: "var(--accent)" } }),
      React.createElement("div", { className: "big" }, busy ? "Reading files…" : "Drop a .csv or .xlsx file here"),
      React.createElement("p", { style: { maxWidth: 440, margin: "8px auto 0" } }, "or click to browse. Files are read in your browser — type and size are checked on upload.")),

    files.length ? React.createElement(React.Fragment, null,
      React.createElement("div", { className: "sectitle" }, "Uploaded · " + files.length + " file" + (files.length > 1 ? "s" : "")),
      React.createElement("div", { className: "uploaded" },
        files.map(function (f) {
          return React.createElement("div", { key: f.id, className: "ufile" + (f.error ? " err" : "") },
            React.createElement("span", { className: "fi" }, React.createElement(Icon, { name: f.error ? "alert" : "doc", size: 16 })),
            React.createElement("div", null,
              React.createElement("div", { className: "fn" }, f.file),
              f.error
                ? React.createElement("div", { className: "errmsg" }, f.error)
                : React.createElement("div", { className: "sub" }, f.size + " · " + (f.rows ? f.rows.toLocaleString() + " rows · " + (f.columns ? f.columns.length : 0) + " columns" : "read OK"))),
            React.createElement("button", { className: "rm", onClick: function () { ctx.removeFile(b.id, f.id); }, "aria-label": "Remove" }, "✕"));
        }))) : null,

    hasError ? React.createElement("div", { className: "errbanner" },
      React.createElement(Icon, { name: "alert", size: 18 }),
      React.createElement("div", null,
        React.createElement("div", { className: "t" }, "One or more files could not be read"),
        React.createElement("div", { className: "d" }, "A corrupted or empty file, an unsupported type, or one over 20 MB was detected. Remove the bad file, or delete this branch and restart from a clean state."),
        React.createElement("div", { style: { marginTop: 10, display: "flex", gap: 8 } },
          React.createElement("button", { className: "btn danger sm", onClick: function () { ctx.confirmDelete(b.id); } },
            React.createElement(Icon, { name: "alert", size: 13 }), "Delete branch & restart")))) : null,

    React.createElement("div", { style: { marginTop: 24, display: "flex", gap: 10 } },
      React.createElement("button", { className: "btn pri", disabled: hasError || validCount === 0 || busy, onClick: next }, "Continue →"),
      React.createElement("span", { className: "muted", style: { alignSelf: "center", fontSize: 13 } },
        hasError ? "Resolve the file error to continue" : validCount ? validCount + " valid file" + (validCount > 1 ? "s" : "") + " ready" : "Upload at least one file")));
}
function crit(icon, label) { return React.createElement("span", { className: "crit", key: label }, React.createElement(Icon, { name: icon, size: 14 }), label); }

function PrimaryKeyStep({ ctx, b, back, next }) {
  const files = (b.files || []).filter(function (f) { return !f.error && f.columns; });
  const common = useMemo(function () {
    if (!files.length) return [];
    let set = files[0].columns.slice();
    files.slice(1).forEach(function (f) { set = set.filter(function (c) { return f.columns.indexOf(c) >= 0; }); });
    return set;
  }, [b.id, files.length]);
  const [pk, setPk] = useState(b.primaryKey || (common.indexOf("ISRC") >= 0 ? "ISRC" : common[0]) || null);

  return React.createElement("div", null,
    React.createElement("p", { style: { maxWidth: 680, marginTop: -6 } }, "Pick the one column present in every uploaded file. G-Cleanser uses it as the ", React.createElement("b", null, "primary key"), " to link rows across files and merge them — and it becomes the first column of your output."),
    common.length
      ? React.createElement("div", { className: "pk-note" },
          React.createElement(Icon, { name: "check", size: 16 }),
          React.createElement("span", null, common.length + " column" + (common.length > 1 ? "s are" : " is") + " common to all " + files.length + " files. Highlighted columns are selectable."))
      : React.createElement("div", { className: "errbanner", style: { marginBottom: 16 } },
          React.createElement(Icon, { name: "alert", size: 16 }),
          React.createElement("div", null, React.createElement("div", { className: "t" }, "No shared column"), React.createElement("div", { className: "d" }, "These files have no column name in common, so they can't be merged. Go back and check your files."))),
    files.map(function (f) {
      return React.createElement("div", { className: "filecols", key: f.id },
        React.createElement("div", { className: "fch" },
          React.createElement(Icon, { name: "doc", size: 14, style: { color: "var(--ink-3)" } }),
          React.createElement("span", { className: "fn" }, f.file),
          React.createElement("span", { className: "muted", style: { marginLeft: "auto", fontSize: 11.5, fontFamily: "var(--mono)" } }, f.columns.length + " cols")),
        React.createElement("div", { className: "colchips" },
          f.columns.map(function (c) {
            const isCommon = common.indexOf(c) >= 0;
            const isSel = pk === c;
            return React.createElement("span", {
              key: c, className: "colchip" + (isCommon ? " common" : "") + (isSel ? " sel" : ""),
              onClick: isCommon ? function () { setPk(c); } : null,
            }, isSel ? React.createElement("span", { className: "pkdot" }, "● ") : null, c);
          })));
    }),
    React.createElement("div", { style: { marginTop: 22, display: "flex", gap: 10 } },
      React.createElement("button", { className: "btn ghost", onClick: back }, "← Back"),
      React.createElement("button", { className: "btn pri", disabled: !pk, onClick: function () { ctx.setPrimaryKey(b.id, pk); next(); } }, "Continue →"),
      pk ? React.createElement("span", { className: "muted", style: { alignSelf: "center", fontSize: 13 } }, "Primary key: ", React.createElement("b", { className: "mono", style: { color: "var(--accent-ink)" } }, pk)) : null));
}

function PresetStep({ ctx, b, back }) {
  const [sel, setSel] = useState(b.preset || "Metadata (PDL)");
  const pk = b.primaryKey || "ISRC";
  const isCustom = sel === "Custom";
  const allCols = useMemo(function () {
    const s = {};
    (b.files || []).forEach(function (f) { (f.columns || []).forEach(function (c) { s[c] = true; }); });
    return Object.keys(s).filter(function (c) { return c !== pk; });
  }, [b.id]);
  const [custCols, setCustCols] = useState([]);

  function addCust(name) { setCustCols(function (l) { return l.concat([{ name: name, type: "plain", source2: "", formula: "" }]); }); }
  function updateCust(i, patch) { setCustCols(function (l) { return l.map(function (c, j) { return j === i ? Object.assign({}, c, patch) : c; }); }); }
  function removeCust(i) { setCustCols(function (l) { return l.filter(function (_, j) { return j !== i; }); }); }
  function start() {
    const custom = isCustom ? [{ name: pk, type: "key" }].concat(custCols) : null;
    ctx.finishSetup(b.id, sel, custom);
  }
  const presets = (ctx.config && ctx.config.presets) || {};
  const presetOrder = (ctx.config && ctx.config.presetOrder) || [];
  const preset = presets[sel];

  return React.createElement("div", null,
    React.createElement("p", { style: { maxWidth: 680, marginTop: -6 } }, "Choose how G-Cleanser cleans and shapes the output. Each preset carries its own cleaning rules and column set. Your primary key ", React.createElement("b", { className: "mono", style: { color: "var(--accent-ink)" } }, pk), " is always the first output column."),
    React.createElement("div", { className: "preset-grid" },
      presetOrder.map(function (name) {
        const p = presets[name];
        return React.createElement("button", { key: name, className: "preset" + (sel === name ? " sel" : "") + (name === "Custom" ? " custom" : ""), onClick: function () { setSel(name); } },
          React.createElement("div", { className: "pt" }, name === "Custom" ? "Build your own" : p.tag),
          React.createElement("h4", null, name),
          React.createElement("p", null, name === "Custom" ? "Hand-pick output columns, concatenate, or apply formulas." : p.desc));
      })),
    !isCustom ? React.createElement("div", { className: "preset-detail" },
      React.createElement("div", { className: "card pad" },
        React.createElement("div", { className: "sectitle" }, "Output columns"),
        React.createElement("div", { className: "coltrack" },
          [React.createElement("span", { className: "c pk", key: "pk" }, pk + " · key")].concat(
            preset.columns.map(function (c) { return React.createElement("span", { className: "c", key: c }, c); })))),
      React.createElement("div", { className: "card pad" },
        React.createElement("div", { className: "sectitle" }, "Cleaning rules"),
        React.createElement("ul", { className: "bullets", style: { margin: 0 } },
          preset.rules.map(function (r, i) { return React.createElement("li", { key: i, style: { fontSize: 13.5 } }, r); })))
    ) : React.createElement("div", { className: "card pad", style: { marginTop: 18 } },
      React.createElement("div", { className: "sectitle" }, "Custom output builder"),
      React.createElement("div", { className: "custcol pk" },
        React.createElement("span", { className: "ord" }, "1"),
        React.createElement("span", { className: "nm" }, pk, " ", React.createElement("span", { className: "tag", style: { marginLeft: 6 } }, "primary key · locked")),
        React.createElement("span", null)),
      custCols.map(function (c, i) {
        return React.createElement("div", { className: "custcol", key: i },
          React.createElement("span", { className: "ord" }, i + 2),
          React.createElement("span", { className: "nm" }, c.name),
          React.createElement("div", { className: "tools" },
            React.createElement("select", { className: "miniselect", value: c.type, onChange: function (e) { updateCust(i, { type: e.target.value }); } },
              React.createElement("option", { value: "plain" }, "As-is"),
              React.createElement("option", { value: "concat" }, "Concatenate…"),
              React.createElement("option", { value: "formula" }, "Formula…")),
            c.type === "concat" ? React.createElement("select", { className: "miniselect", value: c.source2, onChange: function (e) { updateCust(i, { source2: e.target.value }); } },
              [React.createElement("option", { value: "", key: "_" }, "+ column…")].concat(allCols.filter(function (x) { return x !== c.name; }).map(function (x) { return React.createElement("option", { value: x, key: x }, x); }))) : null,
            c.type === "formula" ? React.createElement("input", { className: "miniinput", placeholder: "=UPPER(" + c.name + ")", value: c.formula, onChange: function (e) { updateCust(i, { formula: e.target.value }); } }) : null,
            React.createElement("button", { className: "rm", onClick: function () { removeCust(i); }, "aria-label": "Remove" }, "✕")));
      }),
      React.createElement("div", { className: "sectitle", style: { marginTop: 16 } }, "Add an output column"),
      React.createElement("div", { className: "cust-add" },
        allCols.length
          ? allCols.map(function (c) {
              const used = custCols.some(function (x) { return x.name === c; });
              return React.createElement("button", { key: c, className: "ca", disabled: used, onClick: function () { addCust(c); } }, "+ " + c);
            })
          : React.createElement("span", { className: "muted", style: { fontSize: 13 } }, "No extra columns detected in the uploaded files."))),
    React.createElement("div", { style: { marginTop: 24, display: "flex", gap: 10 } },
      React.createElement("button", { className: "btn ghost", onClick: back }, "← Back"),
      React.createElement("button", { className: "btn pri", disabled: isCustom && custCols.length === 0, onClick: start },
        React.createElement(Icon, { name: "pipeline", size: 16 }), "Start cleansing →"),
      isCustom && custCols.length === 0 ? React.createElement("span", { className: "muted", style: { alignSelf: "center", fontSize: 13 } }, "Add at least one output column") : null));
}
