/* ============================================================
   Exports — full master / per-label / per-artist file generation.
   File lists come from the backend once the engine has built outputs.
   ============================================================ */
import React, { useState, useEffect } from "react";
import { Icon } from "../components/ui.jsx";
import { api } from "../api/index.js";
import { PageHead, outputColumns } from "./helpers.jsx";

export function Exports({ ctx }) {
  const b = ctx.activeBranch;
  const [view, setView] = useState("full");
  const [files, setFiles] = useState({ full: [], label: [], artist: [] });
  const cols = outputColumns(b, ctx.config);

  useEffect(function () {
    let alive = true;
    api.branches.exports(b.id)
      .then(function (f) { if (alive) setFiles({ full: f.full || [], label: f.label || [], artist: f.artist || [] }); })
      .catch(function () { if (alive) setFiles({ full: [], label: [], artist: [] }); });
    return function () { alive = false; };
  }, [b.id]);

  // The full master is always one file; describe it from the sealed branch.
  const fullList = files.full.length ? files.full : [{
    n: b.name.replace(/\s+/g, "_") + "_master.xlsx",
    s: cols.length + " columns · " + (b.rowsOut != null ? b.rowsOut.toLocaleString() : "—") + " rows",
  }];
  const current = view === "full" ? fullList : files[view];

  const opts = [
    { id: "full", t: "Full master", d: "Everything, in your " + b.preset + " column set." },
    { id: "label", t: "Label view", d: "One file per unique label value." },
    { id: "artist", t: "Artist view", d: "Per-artist subsets matched to the G Artist list." },
  ];

  return React.createElement("div", { className: "page fade" },
    PageHead("Output · Step 7", "Exports", "Pick a view and G-Cleanser produces the files — primary key " + b.primaryKey + " first, formatted to your preset."),
    React.createElement("div", { className: "exp-grid", style: { marginBottom: 22 } },
      opts.map(function (o) {
        return React.createElement("button", { key: o.id, className: "exp-opt" + (view === o.id ? " sel" : ""), onClick: function () { setView(o.id); } },
          React.createElement("div", { className: "between" }, React.createElement("h4", null, o.t), view === o.id ? React.createElement(Icon, { name: "check", size: 16, style: { color: "var(--accent)" } }) : null),
          React.createElement("p", null, o.d));
      })),
    view === "full" ? React.createElement("div", { className: "card pad", style: { marginBottom: 16 } },
      React.createElement("div", { className: "sectitle" }, "Column order"),
      React.createElement("div", { className: "coltrack" },
        cols.map(function (c, i) { return React.createElement("span", { className: "c" + (i === 0 ? " pk" : ""), key: c }, c, i === 0 ? " ★" : ""); }))) : null,
    React.createElement("div", { className: "between", style: { marginBottom: 12 } },
      React.createElement("div", { className: "sectitle", style: { margin: 0 } }, current.length + " file" + (current.length !== 1 ? "s" : "") + " to generate"),
      React.createElement("button", { className: "btn pri sm", disabled: !current.length, onClick: function () { ctx.toast("Generated " + current.length + " " + view + " file(s)"); } },
        React.createElement(Icon, { name: "export", size: 14 }), "Generate & download")),
    current.length
      ? React.createElement("div", { className: "card filelist" },
          current.map(function (f, i) {
            return React.createElement("div", { className: "fileitem", key: i },
              React.createElement(Icon, { name: "doc", size: 16, style: { color: "var(--ink-3)" } }),
              React.createElement("span", { className: "fn" }, f.n),
              React.createElement("span", { className: "sz" }, f.s),
              React.createElement("button", { className: "btn ghost sm", onClick: function () { ctx.toast("Downloaded " + f.n); } }, "Download"));
          }))
      : React.createElement("div", { className: "empty" }, "No " + view + " files yet — they are generated once the master is built."));
}
