// Thin fetch wrapper: base URL, bearer-token injection, JSON + error handling.

const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
const TOKEN_KEY = "mrm_token";

let token = localStorage.getItem(TOKEN_KEY) || null;

export function setToken(t) {
  token = t || null;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken() {
  return token;
}

async function request(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (isForm) {
    payload = body; // FormData — let the browser set the boundary header
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(BASE + path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.detail || data.message || `Request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, b) => request(p, { method: "POST", body: b }),
  postForm: (p, form) => request(p, { method: "POST", body: form, isForm: true }),
  del: (p) => request(p, { method: "DELETE" }),
};
