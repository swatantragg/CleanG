/* ============================================================
   Master & Talent — derived trusted master + talent summary
   ============================================================ */
import React from "react";
import { Icon, cell } from "../components/ui.jsx";
import { StatCard, PageHead, outputColumns, colValue } from "./helpers.jsx";

// Apply the branch's review decisions (deletes + edits) onto the source records.
export function deriveMaster(b, records, reviewRow, fieldMap) {
  let recs = (records || []).slice();
  const rv = b.review || { edits: {}, deleted: [] };
  const delRecs = (rv.deleted || []).map(function (id) { return reviewRow(id); }).filter(Boolean).map(function (r) { return r.rec; });
  recs = recs.filter(function (r) { return delRecs.indexOf(r.rec) < 0; });
  Object.keys(rv.edits || {}).forEach(function (id) {
    const row = reviewRow(id); if (!row) return;
    const key = (fieldMap || {})[row.field]; if (!key) return;
    recs = recs.map(function (r) { return r.rec === row.rec ? Object.assign({}, r, (function () { const o = {}; o[key] = rv.edits[id]; return o; })()) : r; });
  });
  return recs;
}

export function talentFrom(recs) {
  const map = {};
  recs.forEach(function (r) {
    [["singer", "Singer"], ["lyricist", "Lyric writer"], ["composer", "Composer"]].forEach(function (pair) {
      const v = r[pair[0]]; if (!v) return;
      v.split(" | ").forEach(function (n) { n = n.trim(); if (!n) return; const k = n + "|" + pair[1]; if (!map[k]) map[k] = { name: n, role: pair[1], tracks: 0 }; map[k].tracks++; });
    });
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.tracks - a.tracks || a.name.localeCompare(b.name); });
}

export function MasterTalent({ ctx }) {
  const b = ctx.activeBranch;
  const ready = b.status === "sealed" || b.review && b.review.submitted;
  if (!ready) {
    return React.createElement("div", { className: "page fade" },
      PageHead("Output · Step 7", "Master & talent", "The trusted master is built once you submit your review."),
      React.createElement("div", { className: "empty" },
        React.createElement(Icon, { name: "table", size: 30, style: { color: "var(--ink-3)" } }),
        React.createElement("div", { className: "big" }, "Submit your review to build the master"),
        React.createElement("button", { className: "btn pri", style: { marginTop: 16 }, onClick: function () { ctx.go("review"); } }, "Go to review →")));
  }
  const fieldMap = (ctx.config && ctx.config.fieldMap) || {};
  const recs = deriveMaster(b, ctx.records, ctx.reviewRow, fieldMap);
  const cols = outputColumns(b, ctx.config);
  const talent = talentFrom(recs);
  const delCount = b.review && b.review.deleted ? b.review.deleted.length : b.deleted || 0;
  const editCount = b.review && b.review.edits ? Object.keys(b.review.edits).length : 0;

  return React.createElement("div", { className: "page wide fade" },
    React.createElement("div", { className: "page-head between" },
      React.createElement("div", null,
        React.createElement("div", { className: "ey" }, "Output · Step 7"),
        React.createElement("h1", null, "Master & talent"),
        React.createElement("div", { className: "sub" }, "Formatted to the ", React.createElement("b", null, b.preset), " preset. Primary key ", React.createElement("b", { className: "mono", style: { color: "var(--accent-ink)" } }, b.primaryKey), " is the first column. Empty fields are explicit null.")),
      React.createElement("button", { className: "btn", onClick: function () { ctx.go("exports"); } }, React.createElement(Icon, { name: "export", size: 15 }), "Exports →")),
    React.createElement("div", { className: "stats", style: { marginBottom: 24 } },
      StatCard("Rows in", b.rowsIn.toLocaleString(), ""),
      StatCard("Trusted rows", (b.rowsOut != null ? b.rowsOut : b.rowsIn - delCount).toLocaleString(), "after review", "accent"),
      StatCard("Deleted", delCount, "in review", "danger"),
      StatCard("Values corrected", editCount, "by you", "human")),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 22, alignItems: "start" } },
      React.createElement("div", null,
        React.createElement("div", { className: "sectitle" }, "Master list · sample (" + cols.length + " columns)"),
        React.createElement("div", { className: "tbl-wrap" },
          React.createElement("table", { className: "tbl" },
            React.createElement("thead", null, React.createElement("tr", null,
              React.createElement("th", null, "#"),
              cols.map(function (c, i) { return React.createElement("th", { key: c, style: i === 0 ? { color: "var(--accent-ink)" } : null }, c, i === 0 ? " ★" : ""); }))),
            React.createElement("tbody", null,
              recs.map(function (r) {
                return React.createElement("tr", { key: r.rec },
                  React.createElement("td", { className: "mono" }, r.rec),
                  cols.map(function (c, i) {
                    const v = colValue(r, c, fieldMap);
                    return React.createElement("td", { key: c, className: i === 0 ? "isrc" : "" }, cell(v));
                  }));
              })))) ),
      React.createElement("div", null,
        React.createElement("div", { className: "sectitle" }, "Talent summary · auto-built"),
        React.createElement("div", { className: "tbl-wrap", style: { maxHeight: 520 } },
          React.createElement("table", { className: "tbl" },
            React.createElement("thead", null, React.createElement("tr", null,
              React.createElement("th", null, "Talent"), React.createElement("th", null, "Role"), React.createElement("th", null, "Tracks"))),
            React.createElement("tbody", null,
              talent.map(function (t, i) {
                return React.createElement("tr", { key: i },
                  React.createElement("td", { style: { whiteSpace: "normal" } }, t.name),
                  React.createElement("td", null, React.createElement("span", { className: "muted" }, t.role)),
                  React.createElement("td", { className: "mono" }, t.tracks));
              })))) )));
}
