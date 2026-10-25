import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The browser tests run against a production build, not the dev server: it is what ships, and it
 * serves many parallel first loads without the dev server's on-demand transforms. The build also
 * includes the test-only harness page (e2e/live.html), which the normal build does not.
 */
export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: "dist-e2e",
      emptyOutDir: true,
      rollupOptions: { input: { main: "index.html", live: "e2e/live.html" } },
    },
    // The root .env is read for the dev server; a developer's Clerk key must not reach the test
    // build, or every page loads Clerk from its CDN and shows the signed-out banner. Tests pass
    // identities in through the harness instead.
    define: { "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify("") },
    // No proxy: an unmocked /api call is a plain 404 ("API offline"), never whatever is on port 3000.
    preview: { proxy: {} },
  }),
);
