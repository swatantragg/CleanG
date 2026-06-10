/* ============================================================
   G-Cleanser prototype — shared UI primitives
   ============================================================ */
import React, { useState, useEffect, useRef, useMemo } from "react";

const ICONS = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  pipeline: "M4 6h10M4 12h16M4 18h7M18 4l2 2-2 2M14 16l2 2-2 2",
  scale: "M12 3v18M5 8l-3 6h6zM19 8l-3 6h6zM7 20h10",
  review: "M4 5h16v10H4zM8 19h8M3 9h4M17 9h4",
  table: "M3 5h18v14H3zM3 10h18M9 5v14",
  export: "M12 4v10M8 10l4 4 4-4M5 20h14",
  branch: "M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM6 3a3 3 0 100 .01M18 6a3 3 0 100 .01M18 6v3a4 4 0 01-4 4H6",
  cross: "M7 4v10M7 18a2 2 0 100 .01M7 14a4 4 0 004 4h6M17 14l-3-3M17 14l-3 3M17 4a2 2 0 100 .01",
  chevron: "M9 6l6 6-6 6",
  chevronUp: "M6 15l6-6 6 6",
  check: "M5 12l5 5L20 7",
  lock: "M6 10V8a6 6 0 1112 0v2M5 10h14v10H5z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M12 9a3 3 0 100 6 3 3 0 000-6z",
  eyeOff: "M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.9 5.1A9.6 9.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.1 3.9M6.3 6.3A16.7 16.7 0 002 12s4 7 10 7a9.6 9.6 0 003.7-.7",
  fork: "M12 3v6M12 21v-6M12 9a3 3 0 100-6 3 3 0 000 6zM12 21a3 3 0 100-6 3 3 0 000 6zM19 9a3 3 0 100-6 3 3 0 000 6zM19 6c0 5-7 4-7 9",
  plus: "M12 5v14M5 12h14",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  doc: "M6 3h9l5 5v13H6zM15 3v5h5",
  alert: "M12 4l9 16H3zM12 10v5M12 18v.5",
  dup: "M8 8h12v12H8zM4 4h12v3M4 4v12h3",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  trash: "M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  clock: "M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  refresh: "M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5",
};

export function Icon({ name, size = 18, className = "", style = {} }) {
  const d = ICONS[name] || "";
  return React.createElement("svg", {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round",
    strokeLinejoin: "round", className, style, "aria-hidden": true,
  }, React.createElement("path", { d }));
}

export function Avatar({ user, size = 30 }) {
  if (!user) return null;
  const bg = `oklch(0.6 0.11 ${user.hue})`;
  return React.createElement("span", {
    className: "av",
    style: { width: size, height: size, background: bg, fontSize: size * 0.4 },
  }, user.initials);
}

export const STATUS_LABEL = {
  "setup": "Setup",
  "running": "Running",
  "awaiting-review": "Awaiting review",
  "sealed": "Sealed",
};

export function StatusPill({ status }) {
  return React.createElement("span", { className: "status " + status }, STATUS_LABEL[status] || status);
}

// Lifecycle status (matches the DB branches.status enum).
export const LIFECYCLE_LABEL = {
  active: "Active",
  expired: "Expired",
  deleted: "Deleted",
  purge_failed: "Purge failed",
};

export function LifecyclePill({ status }) {
  return React.createElement("span", { className: "status lc-" + status }, LIFECYCLE_LABEL[status] || status);
}

export function OwnerDot({ user }) {
  if (!user) return null;
  return React.createElement("span", { className: "dot-own", style: { background: `oklch(0.6 0.11 ${user.hue})` } });
}

export function cell(v) {
  if (v === null || v === undefined || v === "")
    return React.createElement("span", { className: "nullcell" }, "null");
  return v;
}

export function confBand(score) {
  if (score == null) return { label: "conflict", color: "var(--danger-ink)" };
  if (score >= 95) return { label: "high · auto", color: "var(--accent-ink)" };
  if (score >= 90) return { label: "medium", color: "var(--human-ink)" };
  if (score >= 80) return { label: "low", color: "var(--human-ink)" };
  return { label: "weak", color: "var(--ink-3)" };
}

export function Modal({ title, onClose, children, width }) {
  return React.createElement("div", { className: "modal-backdrop", onMouseDown: function (e) { if (e.target === e.currentTarget && onClose) onClose(); } },
    React.createElement("div", { className: "modal", style: { width: width || 460 } },
      React.createElement("div", { className: "modal-head" },
        React.createElement("h3", null, title),
        onClose ? React.createElement("button", { className: "modal-x", onClick: onClose, "aria-label": "Close" }, "✕") : null),
      React.createElement("div", { className: "modal-body" }, children)));
}

export { useState, useEffect, useRef, useMemo };
