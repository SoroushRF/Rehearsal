import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read the repo-root .env, like the API does. Only VITE_-prefixed values reach the browser.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
