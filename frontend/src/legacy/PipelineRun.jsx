/* ============================================================
   Pipeline Run — animated 7-step cleansing pipeline
   ============================================================ */
import React, { useState, useEffect, useRef } from "react";
import { Icon } from "../components/ui.jsx";

function n(v) { return v == null ? null : Number(v).toLocaleString(); }
function rows(b) { return (b.rowsIn || 0).toLocaleString(); }

const PSTEPS = [
  { n: 1, t: "Upload & ingest", lane: "auto", out: function (b) { return rows(b) + " rows · stamped"; } },
  { n: 2, t: "Clean & standardize", lane: "auto", out: function (b) { return rows(b) + " standardized"; } },
  { n: 3, t: "Fill missing (ISRC lookup)", lane: "auto", out: function (b) { var m = b.metrics || {}; return m.enriched != null ? n(m.enriched) + " enriched" : "—"; } },
  { n: 4, t: "Find duplicates", lane: "auto", out: function (b) { var m = b.metrics || {}; return m.duplicates != null ? n(m.duplicates) + " duplicates" : "—"; } },
  { n: 5, t: "Score & route", lane: "gate", out: function (b) { var m = b.metrics || {}; var rev = (b.flaggedRows || []).length; return m.autoMerged != null ? "auto " + n(m.autoMerged) + " · review " + rev + " · drop " + n(m.dropped || 0) : "review " + rev; } },
  { n: 6, t: "Human review", lane: "human", out: function (b) { return (b.flaggedRows || []).length + " records await you"; } },
  { n: 7, t: "Build master & outputs", lane: "auto", out: function (b) { return rows(b) + " → " + (b.rowsOut != null ? b.rowsOut.toLocaleString() : "—"); } },
];

export function PipelineRun({ ctx }) {
  const b = ctx.activeBranch;
  const sealed = b.status === "sealed";
  const initialDone = sealed ? 7 : b.status === "awaiting-review" ? 5 : 0;
  const [done, setDone] = useState(initialDone);
  const [running, setRunning] = useState(b.status === "running" && !(ctx.params && ctx.params.static));
  const timer = useRef(null);

  useEffect(function () {
    if (!running) return;
    timer.current = setInterval(function () {
      setDone(function (d) {
        if (d >= 5) { clearInterval(timer.current); setRunning(false); ctx.setAwaitingReview(b.id); return 5; }
        return d + 1;
      });
    }, 950);
    return function () { clearInterval(timer.current); };
  }, [running]);

  const active = running ? done + 1 : 0;

  return React.createElement("div", { className: "page fade" },
    React.createElement("div", { className: "page-head between" },
      React.createElement("div", null,
        React.createElement("div", { className: "ey" }, "Pipeline · Steps 2–7"),
        React.createElement("h1", null, "Pipeline run"),
        React.createElement("div", { className: "sub" }, "Steps 1–5 and 7 run automatically. Step 6 is the only place a person is needed — and only for the uncertain records.")),
      sealed
        ? React.createElement("span", { className: "badge ok" }, React.createElement(Icon, { name: "check", size: 13 }), "Sealed")
        : running
            ? React.createElement("button", { className: "btn ghost", onClick: function () { clearInterval(timer.current); setRunning(false); setDone(5); ctx.setAwaitingReview(b.id); } }, "Skip animation")
            : null),
    React.createElement("div", { className: "pl-steps" },
      PSTEPS.map(function (s) {
        const isDone = done >= s.n && !(s.n === 6 && !sealed) && !(s.n === 7 && !sealed);
        const isActive = active === s.n;
        const isHumanWait = s.n === 6 && done >= 5 && !sealed;
        const cls = "pl-step " + (s.lane === "human" ? "human " : "") + (isDone ? "done " : "") + (isActive ? "active" : "");
        return React.createElement("div", { className: cls, key: s.n },
          React.createElement("div", { className: "n" }, isDone ? React.createElement(Icon, { name: "check", size: 16 }) : s.n),
          React.createElement("div", null,
            React.createElement("h4", null, s.t, " ",
              s.lane !== "auto" ? React.createElement("span", { className: "tag " + (s.lane === "human" ? "human" : ""), style: { marginLeft: 6 } }, s.lane === "human" ? "human" : "gate") : null),
            React.createElement("div", { className: "meta" }, isHumanWait ? "Waiting for your review" : isActive ? "Processing…" : isDone ? "Complete" : "Queued")),
          React.createElement("div", { className: "out" },
            isActive ? React.createElement("div", { className: "spin", style: { marginLeft: "auto" } }) : isDone || isHumanWait ? s.out(b) : "—"));
      })),
    !sealed && done >= 5
      ? React.createElement("div", { className: "decided-banner", style: { marginTop: 22, background: "var(--accent-soft)", borderColor: "var(--accent-line)" } },
          React.createElement(Icon, { name: "review", size: 20, style: { color: "var(--accent-ink)" } }),
          React.createElement("div", { style: { flex: 1 } },
            React.createElement("div", { style: { fontWeight: 600 } }, "Auto-resolve done — " + (b.flaggedRows || []).length + " records need your eye"),
            React.createElement("div", { className: "muted", style: { fontSize: 13 } }, "Everything ≥ 95 was merged automatically. The rest is waiting in your review queue.")),
          React.createElement("button", { className: "btn human", onClick: function () { ctx.go("review"); } }, "Open review queue →"))
      : null,
    sealed
      ? React.createElement("div", { className: "decided-banner", style: { marginTop: 22 } },
          React.createElement(Icon, { name: "check", size: 20, style: { color: "var(--ok)" } }),
          React.createElement("div", { style: { flex: 1 } },
            React.createElement("div", { style: { fontWeight: 600 } }, "Master sealed · " + (b.rowsOut != null ? b.rowsOut.toLocaleString() : "—") + " trusted rows"),
            React.createElement("div", { className: "muted", style: { fontSize: 13 } }, (b.deleted != null ? b.deleted : 0) + " records removed in review.")),
          React.createElement("button", { className: "btn", onClick: function () { ctx.go("master"); } }, "View master →"))
      : null);
}
