/* ============================================================
   Review Queue — single bulk table of all sub-100% records
   ============================================================ */
import React, { useState, useEffect } from "react";
import { Icon, confBand } from "../components/ui.jsx";

export function ReviewQueue({ ctx }) {
  const b = ctx.activeBranch;
  const rv = b.review || { edits: {}, deleted: [], submitted: false };
  const allIds = b.flaggedRows || [];
  const liveIds = allIds.filter(function (id) { return rv.deleted.indexOf(id) < 0; });
  const [selected, setSelected] = useState([]);
  useEffect(function () { setSelected([]); }, [b.id]);

  function shell(inner) {
    return React.createElement("div", { className: "page wide fade" },
      React.createElement("div", { className: "page-head" },
        React.createElement("div", { className: "ey" }, "Human step · Step 6"),
        React.createElement("h1", null, "Review"),
        React.createElement("div", { className: "sub" }, "Every record scoring below 100% confidence is listed here in one view. Fix a value inline, or select rows to delete. When you're done, submit to build the final output. Decisions are written to your branch only.")),
      inner);
  }

  if (!ctx.canEdit) {
    return shell(React.createElement("div", { className: "ro-banner" },
      React.createElement(Icon, { name: "lock", size: 16, className: "ic" }),
      React.createElement("span", null, "Read-only — this is ", React.createElement("b", null, ctx.user(b.owner).name + "'s"), " branch. Only the owner can review.")));
  }

  if (rv.submitted || b.status === "sealed") {
    return shell(React.createElement("div", { className: "decided-banner" },
      React.createElement(Icon, { name: "check", size: 22, style: { color: "var(--ok)" } }),
      React.createElement("div", { style: { flex: 1 } },
        React.createElement("div", { style: { fontWeight: 600, fontSize: 16 } }, "Review submitted · output built"),
        React.createElement("div", { className: "muted", style: { fontSize: 13 } }, rv.deleted.length + " records deleted · " + Object.keys(rv.edits).length + " values corrected.")),
      React.createElement("button", { className: "btn", onClick: function () { ctx.go("master"); } }, "View master →")));
  }

  const editedCount = Object.keys(rv.edits).length;
  const allChecked = liveIds.length > 0 && selected.length === liveIds.length;
  function toggleAll() { setSelected(allChecked ? [] : liveIds.slice()); }
  function toggle(id) { setSelected(function (s) { return s.indexOf(id) >= 0 ? s.filter(function (x) { return x !== id; }) : s.concat([id]); }); }

  return shell(React.createElement("div", null,
    React.createElement("div", { className: "rev-toolbar" },
      React.createElement("span", { className: "sel-count" }, React.createElement("b", null, liveIds.length), " flagged record" + (liveIds.length !== 1 ? "s" : "") + " below 100%"),
      React.createElement("span", { style: { width: 1, height: 18, background: "var(--line)" } }),
      React.createElement("span", { className: "sel-count" }, React.createElement("b", null, selected.length), " selected"),
      React.createElement("button", { className: "btn ghost sm", onClick: toggleAll }, allChecked ? "Clear all" : "Select all"),
      React.createElement("button", { className: "btn danger sm", disabled: !selected.length, onClick: function () { ctx.deleteRows(b.id, selected); setSelected([]); } },
        React.createElement(Icon, { name: "alert", size: 13 }), "Delete selected (" + selected.length + ")"),
      React.createElement("span", { style: { marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" } }, editedCount + " edited · " + rv.deleted.length + " to delete")),
    React.createElement("div", { className: "rev-table-wrap" },
      React.createElement("table", { className: "rev-table" },
        React.createElement("thead", null, React.createElement("tr", null,
          React.createElement("th", { style: { width: 36 } }, React.createElement("span", { className: "cbx" + (allChecked ? " on" : ""), onClick: toggleAll }, allChecked ? React.createElement(Icon, { name: "check", size: 12 }) : null)),
          React.createElement("th", null, "Rec"),
          React.createElement("th", null, "ISRC"),
          React.createElement("th", null, "Track"),
          React.createElement("th", null, "Field"),
          React.createElement("th", null, "Value (editable)"),
          React.createElement("th", null, "Suggested"),
          React.createElement("th", null, "Conf"),
          React.createElement("th", null, "Issue"))),
        React.createElement("tbody", null,
          liveIds.map(function (id) {
            const row = ctx.reviewRow(id);
            if (!row) return null;
            const isSel = selected.indexOf(id) >= 0;
            const curVal = rv.edits[id] != null ? rv.edits[id] : row.value == null ? "" : row.value;
            const isEdited = rv.edits[id] != null;
            const band = confBand(row.confidence);
            return React.createElement("tr", { key: id, className: isSel ? "markdel" : isEdited ? "edited" : "" },
              React.createElement("td", null, React.createElement("span", { className: "cbx" + (isSel ? " on" : ""), onClick: function () { toggle(id); } }, isSel ? React.createElement(Icon, { name: "check", size: 12 }) : null)),
              React.createElement("td", { className: "mono" }, row.rec),
              React.createElement("td", null, React.createElement("span", { className: "isrc" }, row.isrc)),
              React.createElement("td", null, row.track),
              React.createElement("td", { className: "mono", style: { fontSize: 11.5, color: "var(--ink-3)" } }, row.field),
              React.createElement("td", { className: "editcell" },
                React.createElement("input", { value: curVal, placeholder: "null", onChange: function (e) { ctx.setRowEdit(b.id, id, e.target.value); } })),
              React.createElement("td", null, row.suggested && row.suggested.indexOf("Delete") < 0 && row.suggested.indexOf("—") < 0 && row.suggested !== row.value
                ? React.createElement("span", { className: "sugg" }, row.suggested, React.createElement("button", { className: "applybtn", onClick: function () { ctx.setRowEdit(b.id, id, row.suggested); } }, "apply"))
                : React.createElement("span", { className: "muted", style: { fontSize: 12 } }, row.suggested || "—")),
              React.createElement("td", null, React.createElement("span", { className: "conf-chip", style: { color: band.color, background: row.confidence == null ? "var(--danger-soft)" : row.confidence >= 95 ? "var(--accent-soft)" : "var(--human-soft)" } }, row.confidence == null ? "dup" : row.confidence + "%")),
              React.createElement("td", { style: { whiteSpace: "normal", fontSize: 12.5, color: "var(--ink-3)" } }, row.issue));
          }),
          liveIds.length === 0 ? React.createElement("tr", null, React.createElement("td", { colSpan: 9, style: { textAlign: "center", padding: 30, color: "var(--ink-3)" } }, "All flagged rows deleted. Submit to build the output.")) : null))),
    React.createElement("div", { className: "rev-submitbar" },
      React.createElement(Icon, { name: "review", size: 18, style: { color: "var(--accent)" } }),
      React.createElement("div", { className: "summ" }, "Output preset: ", React.createElement("b", null, b.preset), " · primary key ", React.createElement("b", { className: "mono" }, b.primaryKey), " · ", React.createElement("b", null, rv.deleted.length), " to delete, ", React.createElement("b", null, editedCount), " corrected"),
      React.createElement("button", { className: "btn pri", style: { marginLeft: "auto" }, onClick: function () { ctx.submitReview(b.id); ctx.go("master"); } },
        React.createElement(Icon, { name: "check", size: 16 }), "Submit & build output"))));
}
