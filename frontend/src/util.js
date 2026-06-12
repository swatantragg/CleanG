/* Small presentation helpers for the lifecycle UI. */

export function humanSize(bytes) {
  if (bytes == null) return "—";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

export function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch (e) { return iso; }
}

// Human countdown to expiry, driven by status + expiresAt.
export function expiryLabel(branch) {
  if (!branch) return "";
  if (branch.status === "deleted") return "Deleted";
  if (branch.status === "purgeFailed" || branch.status === "purge_failed") return "Purge failed";
  if (branch.status === "expired") return "Expired";
  const ms = new Date(branch.expiresAt).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "Expired — pending purge";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return "Expires in " + days + " day" + (days > 1 ? "s" : "");
  const hrs = Math.floor(ms / 3600000);
  if (hrs >= 1) return "Expires in " + hrs + " hour" + (hrs > 1 ? "s" : "");
  const mins = Math.max(1, Math.floor(ms / 60000));
  return "Expires in " + mins + " min";
}

// Trigger a file download from a (signed) URL. Uses a programmatic <a> click rather
// than window.open — window.open after an async call is killed by popup blockers since
// the user-gesture is gone. The stream endpoint serves Content-Disposition: attachment.
export function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { a.remove(); }, 0);
}

export function initials(name) {
  return (name || "?").trim().split(/\s+/).map(function (s) { return s[0]; }).slice(0, 2).join("").toUpperCase();
}
