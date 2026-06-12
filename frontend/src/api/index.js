/* ============================================================
   API surface. DB snake_case <-> client camelCase lives here only.
   ============================================================ */
import { http, getToken, setToken } from "./client.js";

function toCamel(s) { return s.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
function camel(v) {
  if (Array.isArray(v)) return v.map(camel);
  if (v && typeof v === "object") {
    const o = {};
    for (const k in v) o[toCamel(k)] = camel(v[k]);
    return o;
  }
  return v;
}
const get = function (p) { return p.then(function (r) { return camel(r.data); }); };

function storeAuth(r) {
  // r: { accessToken, tokenType, user }
  if (r && r.accessToken) setToken(r.accessToken);
  return r;
}

export const api = {
  hasToken: function () { return !!getToken(); },
  setToken: setToken,

  auth: {
    register: function (body) { return get(http.post("/auth/register", body)).then(storeAuth); },
    login: function (email, password) { return get(http.post("/auth/login", { email: email, password: password })).then(storeAuth); },
    me: function () { return get(http.get("/auth/me")); },
  },

  presets: {
    list: function () { return get(http.get("/presets")); },
  },

  branches: {
    list: function () { return get(http.get("/branches")); },
    create: function (body) {
      return get(http.post("/branches", { name: body.name, preset_id: body.presetId || null, visibility: body.visibility || "shared" }));
    },
    get: function (id) { return get(http.get("/branches/" + id)); },
    update: function (id, patch) {
      const body = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.visibility !== undefined) body.visibility = patch.visibility;
      if (patch.presetId !== undefined) body.preset_id = patch.presetId;
      return get(http.patch("/branches/" + id, body));
    },
    remove: function (id) { return get(http.delete("/branches/" + id)); },
    files: function (id) { return get(http.get("/branches/" + id + "/files")); },
    clean: function (id, spec) {
      const body = {};
      if (spec) {
        if (spec.primaryKey != null) body.primary_key = spec.primaryKey;
        if (spec.presetId != null) body.preset_id = spec.presetId;
        if (spec.columns != null) body.columns = spec.columns;
      }
      return get(http.post("/branches/" + id + "/clean", body));
    },
    review: function (id, opts) {
      const p = opts || {};
      const params = { offset: p.offset || 0, limit: p.limit || 50 };
      if (p.status) params.status = p.status;
      return get(http.get("/branches/" + id + "/review", { params: params }));
    },
    resolveReview: function (id, itemId, body) { return get(http.post("/branches/" + id + "/review/" + itemId, body)); },
    bulkResolveReview: function (id, body) { return get(http.post("/branches/" + id + "/review/bulk", body)); },
    finalize: function (id) { return get(http.post("/branches/" + id + "/finalize")); },
    skip: function (id) { return get(http.post("/branches/" + id + "/skip")); },
    cancelReview: function (id) { return http.delete("/branches/" + id + "/review"); },
    uploadSource: function (id, file) {
      const fd = new FormData();
      fd.append("file", file);
      // Content-Type undefined → axios sets multipart boundary from the FormData.
      return get(http.post("/branches/" + id + "/files", fd, { headers: { "Content-Type": undefined } }));
    },
  },

  shared: {
    list: function () { return get(http.get("/shared-branches")); },
  },

  files: {
    signedUrl: function (fileId) { return get(http.get("/files/" + fileId + "/download")); },
  },

  config: {
    get: function () { return get(http.get("/config")); },
  },
};

export default api;
