import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the frontend calls "/api" and Vite proxies it to the FastAPI backend.
// Override the backend target with VITE_PROXY_TARGET if it runs elsewhere.
const API_TARGET = process.env.VITE_PROXY_TARGET || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    open: true,
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
  },
});
