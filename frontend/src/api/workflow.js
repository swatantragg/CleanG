// Workflow endpoint wrappers — every pipeline operation runs on the backend.

import { api } from "./client";

export const workflowApi = {
  meta: () => api.get("/meta"),

  // File upload → { headers, rows, fileName, fields, mapping, suggestions }
  ingest: (file) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm("/ingest", form);
  },

  clean: (rawRows, fields, mapping) => api.post("/clean", { rawRows, fields, mapping }),
  validate: (records) => api.post("/validate", { records }),

  getMaster: () => api.get("/master"),
  uploadClean: (records) => api.post("/master/upload", { records }),
  approve: (record) => api.post("/master/approve", { record }),
  resetMaster: () => api.del("/master"),
  extract: (preset, extra, fields) => api.post("/master/extract", { preset, extra, fields }),
};
