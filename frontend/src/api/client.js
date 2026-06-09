/* ============================================================
   Axios client — base URL, bearer token, error normalization.
   ============================================================ */
import axios from "axios";

const BASE_URL = import.meta.env.VITE_API_URL || "/api";
const TOKEN_KEY = "gc_token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}
export function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
}

export const http = axios.create({ baseURL: BASE_URL, headers: { "Content-Type": "application/json" } });

http.interceptors.request.use(function (cfg) {
  const t = getToken();
  if (t) cfg.headers.Authorization = "Bearer " + t;
  return cfg;
});

// Surface the server's `detail` string as Error.message; flag auth failures.
http.interceptors.response.use(
  function (r) { return r; },
  function (err) {
    const res = err.response;
    const detail = res && res.data && (res.data.detail || res.data.message);
    const e = new Error(detail || err.message || "Request failed");
    e.status = res ? res.status : 0;
    e.unauthorized = e.status === 401;
    return Promise.reject(e);
  }
);
