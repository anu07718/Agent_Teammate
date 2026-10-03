import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const api = process.env.NIRNAYA_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  server: {
    port: 5173,
    fs: { allow: [".", "../firebase"] },   // the relay rules are imported from the repo for the dialog's copy button
    proxy: { "/api": { target: api, changeOrigin: true }, "/mcp": { target: api, changeOrigin: true } },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 4000 },
});
