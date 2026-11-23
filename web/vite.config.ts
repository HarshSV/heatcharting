import { defineConfig } from "vite";

// In development the page runs on :5173 and talks to the server on :8100.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8100",
      "/ws": { target: "ws://127.0.0.1:8100", ws: true },
    },
  },
  build: { outDir: "dist" },
});
