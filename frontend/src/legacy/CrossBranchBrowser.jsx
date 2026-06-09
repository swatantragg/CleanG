/* ============================================================
   Cross-Branch Browser — read-only view + cherry-pick / adopt
   ============================================================ */
import React, { useState } from "react";
import { Icon, Avatar, StatusPill, OwnerDot } from "../components/ui.jsx";

export function CrossBranchBrowser({ ctx }) {
  const others = ctx.branches.filter(function (b) { return b.owner !== ctx.currentUserId; });
  const [sel, setSel] = useState(ctx.params && ctx.params.branchId || others[0] && others[0].id);
  const branch = ctx.branches.find(function (b) { return b.id === sel; });
  if (!branch) return React.createElement("div", { className: "page" }, React.createElement("div", { className: "empty" }, "No other branches to browse."));
  const owner = ctx.user(branch.owner);
  const ds = ctx.dataset(branch.dataset);
  const items = branch.decisions || [];
  const myBranch = ctx.branches.find(function (b) { return b.owner === ctx.currentUserId; });

  return React.createElement("div", { className: "page wide fade" },
    React.createElement("div", { className: "page-head" },
      React.createElement("div", { className: "ey" }, "Branching · fork & adopt"),
      React.createElement("h1", null, "Cross-branch browser"),
      React.createElement("div", { className: "sub" }, "Open anyone's branch read-only and cherry-pick the decisions you want. Adopted items land in your branch with provenance — the other branch is never changed, and yours only changes when you choose.")),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "240px 1fr", gap: 22, alignItems: "start" } },
      React.createElement("div", { className: "card", style: { padding: 8 } },
        React.createElement("div", { className: "sb-label" }, "Browse a branch"),
        others.map(function (b) {
          const u = ctx.user(b.owner);
          return React.createElement("button", { key: b.id, className: "sb-item" + (b.id === sel ? " active" : ""), onClick: function () { setSel(b.id); } },
            React.createElement(OwnerDot, { user: u }), React.createElement("span", null, b.name));
        })),
      React.createElement("div", { className: "col", style: { gap: 18 } },
        React.createElement("div", { className: "ro-banner" },
          React.createElement(Icon, { name: "lock", size: 16, className: "ic" }),
          React.createElement("span", null, "Read-only — you're viewing ", React.createElement("b", null, owner.name + "'s"), " branch. Nothing here can be edited.")),
        React.createElement("div", { className: "card pad" },
          React.createElement("div", { className: "between" },
            React.createElement("div", { className: "row", style: { alignItems: "center" } },
              React.createElement(Avatar, { user: owner, size: 38 }),
              React.createElement("div", null,
                React.createElement("div", { style: { fontWeight: 600, fontSize: 17, fontFamily: "var(--display)" } }, branch.name),
                React.createElement("div", { className: "muted", style: { fontSize: 13 } }, owner.name + " · " + ds.name + " · " + ds.file))),
            React.createElement(StatusPill, { status: branch.status }))),
        React.createElement("div", null,
          React.createElement("div", { className: "sectitle" }, "Decisions in this branch · adopt into yours"),
          React.createElement("div", { className: "col", style: { gap: 10 } },
            items.length ? items.map(function (it) {
              const adopted = myBranch && myBranch.adopted && myBranch.adopted[it.id];
              return React.createElement("div", { key: it.id, className: "card pad between", style: { alignItems: "center" } },
                React.createElement("div", { className: "row", style: { alignItems: "flex-start", gap: 12 } },
                  React.createElement("span", { className: "av", style: { width: 30, height: 30, borderRadius: 8, background: adoptKindColor(it.kind), fontSize: 12 } }, adoptKindGlyph(it.kind)),
                  React.createElement("div", null,
                    React.createElement("div", { style: { fontWeight: 600 } }, it.title),
                    React.createElement("div", { className: "muted", style: { fontSize: 12.5 } }, it.detail))),
                adopted
                  ? React.createElement("span", { className: "badge ok" }, React.createElement(Icon, { name: "check", size: 12 }), "Adopted")
                  : React.createElement("button", { className: "btn sm", onClick: function () { ctx.adopt(branch, it); } },
                      React.createElement(Icon, { name: "fork", size: 14 }), "Adopt"));
            }) : React.createElement("div", { className: "empty" }, "No granular decisions exposed for this branch."))),
        React.createElement("div", { className: "card pad", style: { background: "var(--surface-2)" } },
          React.createElement("div", { style: { display: "flex", gap: 12 } },
            React.createElement(Icon, { name: "branch", size: 18, style: { color: "var(--accent)", flex: "none", marginTop: 2 } }),
            React.createElement("div", { style: { fontSize: 13.5, color: "var(--ink-2)" } },
              React.createElement("b", { style: { color: "var(--ink)" } }, "Isolation holds. "),
              owner.name + " resolving a conflict here does not touch your branch. If you adopt an item it is copied into yours with a provenance stamp; you remain free to decide the opposite."))))));
}

function adoptKindColor(k) {
  return { same: "oklch(0.6 0.11 150)", diff: "var(--ink-3)", fix: "var(--accent)", del: "var(--danger)" }[k] || "var(--ink-3)";
}
function adoptKindGlyph(k) {
  return { same: "=", diff: "≠", fix: "✎", del: "−" }[k] || "•";
}
