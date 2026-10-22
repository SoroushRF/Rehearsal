import { defineConfig, devices } from "@playwright/test";

/** Its own port, so a dev server already on 5173 (this app or another) is never tested by mistake. */
const PORT = 5199;

/**
 * Browser smoke tests against the Vite dev server. The API doesn't need to be running.
 * Uses Playwright's Chromium (`pnpm exec playwright install chromium`); set PW_CHANNEL=chrome to
 * use an installed Chrome instead.
 */
export default defineConfig({
  testDir: "e2e",
  // Biome checks every file outside node_modules, so keep run output out of the source tree.
  outputDir: "node_modules/.cache/playwright",
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
