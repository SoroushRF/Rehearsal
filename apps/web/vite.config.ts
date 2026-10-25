import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { apiOrigin } from "./api-origin";

// The repo-root .env is the one the API reads, so its API_PORT is where /api has to go.
const rootEnv = loadEnv("development", fileURLToPath(new URL("../..", import.meta.url)), "");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read the repo-root .env, like the API does. Only VITE_-prefixed values reach the browser.
  envDir: "../..",
  server: {
    port: 5173,
    proxy: { "/api": apiOrigin(process.env.API_PORT ?? rootEnv.API_PORT) },
  },
});
