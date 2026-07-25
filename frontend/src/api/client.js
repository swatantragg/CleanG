// CSRF double-submit: the server sets a readable `mrm_csrf` cookie at login; we
// echo its value back in a header on every state-changing request so the server
// can confirm the call came from our own app (a cross-site page can ride the
// session cookie but cannot read this one to forge the header).
const CSRF_COOKIE = "mrm_csrf";
const CSRF_HEADER = "X-CSRF-Token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readCookie(name) {
  const m = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
  );
  return m ? decodeURIComponent(m[1]) : "";
}

// The current CSRF token + its header name, for callers that build their own
// requests (multipart uploads via fetch/XHR that don't go through `api`).
export const CSRF_HEADER_NAME = CSRF_HEADER;
export function csrfToken() {
  return readCookie(CSRF_COOKIE);
}

// The API answers an unreachable database with an explanatory 503. A 502/504 has
// no JSON body at all — it comes from the proxy, not the app, and means the API
// itself is down or restarting. Either way "Request failed (502)" tells the user
// nothing they can act on, so gateway statuses get a plain-English message.
const GATEWAY_MESSAGE = {
  502: "The server is restarting. Please try again in a minute.",
  503: "The service is temporarily unavailable. Please try again in a minute.",
  504: "The server took too long to respond. Please try again.",
};

// FastAPI reports errors under `detail`, but the shape varies: a plain string
// for HTTPExceptions, an ARRAY of {loc,msg,type} for request-validation (422)
// errors, or occasionally an object. Coerce every shape to a readable sentence so
// the UI never surfaces a raw "[object Object]" (which is what `new Error(obj)`
// produces). Returns null when nothing usable is found, so the caller can fall
// back to a status-based message.
function detailToMessage(detail) {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d.msg === "string") {
          // Pydantic prefixes custom validator errors with "Value error, ";
          // drop it, and label with the offending field when we can.
          const msg = d.msg.replace(/^Value error,\s*/i, "");
          const loc = Array.isArray(d.loc) ? d.loc : [];
          const field = loc.filter((p) => p !== "body").pop();
          return field && typeof field === "string" ? `${field}: ${msg}` : msg;
        }
        return null;
      })
      .filter(Boolean);
    return msgs.length ? msgs.join(" ") : null;
  }
  if (typeof detail === "object") {
    if (typeof detail.message === "string") return detail.message;
    if (typeof detail.msg === "string") return detail.msg;
    try {
      return JSON.stringify(detail);
    } catch {
      return null;
    }
  }
  return null;
}

function errorMessage(status, data) {
  const fromDetail = data ? detailToMessage(data.detail) : null;
  if (fromDetail) return fromDetail;
  return GATEWAY_MESSAGE[status] || `Request failed (${status})`;
}

function withCsrf(headers, method) {
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }
  return headers;
}

/**
 * Thin fetch wrapper. Auth is carried by an httpOnly session cookie set by the
 * server on login — the token is never stored in JS (so XSS can't read it), so
 * every request just needs `credentials: "include"` to send the cookie. State-
 * changing requests additionally carry the CSRF header.
 */
export async function api(path, { method = "GET", body } = {}) {
  const headers = withCsrf({ "Content-Type": "application/json" }, method);

  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(errorMessage(res.status, data));
  }
  return data;
}

/**
 * Authenticated file download. Fetches the path as a blob (the session cookie is
 * sent automatically) and triggers a browser "save as" using the server-supplied
 * filename.
 */
export async function download(
  path,
  fallbackName = "download.xlsx",
  { method = "GET", body } = {}
) {
  const headers = withCsrf({}, method);
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(errorMessage(res.status, data));
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const match = /filename="?([^"]+)"?/.exec(cd);
  const name = match ? match[1] : fallbackName;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
