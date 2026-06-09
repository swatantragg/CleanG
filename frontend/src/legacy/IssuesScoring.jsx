/* ============================================================
   Issues & Scoring — confidence distribution + issue triage.
   Driven by branch.metrics from the backend scoring stage.
   ============================================================ */
import React from "react";
import { Icon } from "../components/ui.jsx";
import { StatCard } from "./helpers.jsx";

export function IssuesScoring({ ctx }) {
  const b = ctx.activeBranch;
  const m = b && b.metrics;

  const head = React.createElement("div", { className: "page-head" },
    React.createElement("div", { className: "ey" }, "Routing · Step 5"),
    React.createElement("h1", null, "Issues & scoring"),
    React.createElement("div", { className: "sub" }, "Every flagged record gets a 0–100 confidence score. The score — not a guess — decides whether the engine resolves it or a person does."));

  if (!m) {
    return React.createElement("div", { className: "page fade" }, head,
      React.createElement("div", { className: "empty" },
        React.createElement(Icon, { name: "scale", size: 30, style: { color: "var(--ink-3)" } }),
        React.createElement("div", { className: "big" }, "No scores yet"),
        React.createElement("p", { style: { maxWidth: 460, margin: "8px auto 0" } }, "Confidence scores appear here once the scoring stage of the pipeline has run for this branch.")));
  }

  const buckets = m.buckets || [];
  const max = buckets.length ? Math.max.apply(null, buckets.map(function (x) { return x.v; })) : 1;
  const laneColor = { drop: "var(--surface-3)", human: "var(--human)", auto: "var(--accent)" };
  const issueTypes = m.issueTypes || [];

  return React.createElement("div", { className: "page fade" }, head,
    React.createElement("div", { className: "stats", style: { marginBottom: 26 } },
      StatCard("Auto-merged", num(m.autoMerged), "≥ 95 confidence", "accent"),
      StatCard("Sent to review", num(m.sentToReview), "80–94 + conflicts", "human"),
      StatCard("Dropped / flagged", num(m.dropped), "< 80 · no action"),
      StatCard("Clean, no issue", num(m.clean), "straight to master")),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 22, alignItems: "start" } },
      React.createElement("div", null,
        React.createElement("div", { className: "sectitle" }, "Confidence distribution"),
        React.createElement("div", { className: "histo", style: { marginBottom: 30 } },
          buckets.map(function (bk, i) {
            return React.createElement("div", { key: i, className: "bar", style: { height: bk.v / max * 100 + "%", background: laneColor[bk.lane] } },
              React.createElement("span", { className: "val" }, bk.v),
              React.createElement("span", { className: "lab" }, bk.l));
          })),
        React.createElement("div", { className: "row", style: { gap: 16, fontSize: 12.5, color: "var(--ink-3)", fontFamily: "var(--mono)" } },
          legendSwatch("var(--surface-3)", "< 80 dropped"),
          legendSwatch("var(--human)", "80–94 human"),
          legendSwatch("var(--accent)", "95–100 auto"))),
      React.createElement("div", null,
        React.createElement("div", { className: "sectitle" }, "Issues by type"),
        React.createElement("div", { className: "card" },
          issueTypes.map(function (it, i) {
            return React.createElement("div", { key: it.k, style: { display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < issueTypes.length - 1 ? "1px solid var(--line)" : "none" } },
              React.createElement(Icon, { name: it.icon || "table", size: 17, style: { color: "var(--ink-3)" } }),
              React.createElement("span", { style: { fontSize: 14 } }, it.k),
              React.createElement("span", { className: "mono", style: { marginLeft: "auto", fontWeight: 600 } }, it.v),
              React.createElement("span", { className: "tag " + (it.lane === "auto" ? "auto" : it.lane === "human" ? "human" : "") }, it.lane === "auto" ? "auto" : it.lane === "human" ? "review" : "flag"));
          })))));
}

function num(v) { return v == null ? "—" : Number(v).toLocaleString(); }

function legendSwatch(c, l) {
  return React.createElement("span", { key: l, style: { display: "inline-flex", alignItems: "center", gap: 6 } },
    React.createElement("span", { style: { width: 11, height: 11, borderRadius: 3, background: c, border: "1px solid var(--line)" } }), l);
}
