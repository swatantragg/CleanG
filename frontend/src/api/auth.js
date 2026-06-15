// Auth endpoint wrappers.

import { api } from "./client";

export const authApi = {
  signup: (email, password, name) => api.post("/auth/signup", { email, password, name }),
  login: (email, password) => api.post("/auth/login", { email, password }),
  me: () => api.get("/auth/me"),
};
