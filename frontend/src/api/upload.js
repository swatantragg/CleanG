/* Shared multipart-upload helpers for the Standardize tabs (master format and
   PRS). The session cookie rides along automatically; the CSRF token is added
   to every request. */
import { CSRF_HEADER_NAME, csrfToken } from "./client.js";

/** Multipart POST returning parsed JSON (a preview). */
export async function postJSON(path, file, fields = {}) {
  const form = new FormData();
  form.append("file", file);
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  const csrf = csrfToken();
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: csrf ? { [CSRF_HEADER_NAME]: csrf } : {},
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data.detail;
    throw new Error(
      (typeof detail === "object" && detail?.message) ||
        detail ||
        `Request failed (${res.status})`
    );
  }
  return res.json();
}

/**
 * Multipart POST that streams a file back, reported via XHR so we get real
 * upload + download progress (and clear errors instead of an opaque fetch
 * "NetworkError"). `onStage(stage, pct)` drives the progress bar.
 */
export function postDownload(path, file, onStage, fields = {}, fallbackName = "download.xlsx") {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "blob";
    const csrf = csrfToken();
    if (csrf) xhr.setRequestHeader(CSRF_HEADER_NAME, csrf);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onStage("uploading", e.loaded / e.total);
    };
    // Bytes are up — the server is now building the workbook.
    xhr.upload.onload = () => onStage("processing", 0);
    xhr.onprogress = (e) => {
      if (e.lengthComputable) onStage("downloading", e.loaded / e.total);
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const cd = xhr.getResponseHeader("Content-Disposition") || "";
        const match = /filename="?([^"]+)"?/.exec(cd);
        resolve({ blob: xhr.response, name: match ? match[1] : fallbackName });
        return;
      }
      // Error responses still arrive as a blob — read the JSON detail out of it.
      let message = `Download failed (${xhr.status})`;
      try {
        const text = await xhr.response.text();
        const detail = JSON.parse(text).detail;
        message = (typeof detail === "object" && detail?.message) || detail || message;
      } catch {
        /* keep the generic message */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during download. Please try again."));

    const form = new FormData();
    form.append("file", file);
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    xhr.send(form);
  });
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
