/* ============================================================
   Shared screen helpers — stat cards, page heads, output columns
   ============================================================ */
import React from "react";

export function StatCard(k, v, d, cls) {
  return React.createElement("div", { className: "stat", key: k },
    React.createElement("div", { className: "k" }, k),
    React.createElement("div", { className: "v " + (cls || "") }, v),
    d ? React.createElement("div", { className: "d" }, d) : null);
}

export function PageHead(ey, title, sub) {
  return React.createElement("div", { className: "page-head" },
    React.createElement("div", { className: "ey" }, ey),
    React.createElement("h1", null, title),
    React.createElement("div", { className: "sub" }, sub));
}

/* output columns for a branch — primary key always first */
export function outputColumns(branch, config) {
  const pk = branch.primaryKey || "ISRC";
  if (branch.preset === "Custom" && branch.customColumns) {
    const names = branch.customColumns.map(function (c) { return c.name; });
    return names.indexOf(pk) >= 0 ? names : [pk].concat(names.filter(function (n) { return n !== pk; }));
  }
  const presets = (config && config.presets) || {};
  const p = presets[branch.preset];
  const cols = p && p.columns ? p.columns.slice() : ["Track Name", "Singer", "Composer", "Label"];
  return [pk].concat(cols.filter(function (c) { return c !== pk; }));
}

export function colValue(rec, colName, fieldMap) {
  const key = (fieldMap || {})[colName];
  if (!key) return null;
  return rec[key];
}
