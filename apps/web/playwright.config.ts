import { defineConfig, devices } from "@playwright/test";

/** Its own port, so a server already on 5173 or 4173 (this app or another) is never tested by mistake. */
const PORT = 5199;

/**
 * Browser tests against a production build served by `vite preview` (see vite.e2e.config.ts). The
 * API doesn't need to be running.
 * Uses Playwright's Chromium (`pnpm exec playwright install chromium`); set PW_CHANNEL=chrome to
 * use an installed Chrome instead.
 */
export default defineConfig({
  testDir: "e2e",
  // Biome checks every file outside node_modules, so keep run output out of the source tree.
  outputDir: "node_modules/.cache/playwright",
  // One retry. A page load very occasionally aborts under parallel load; a retry that passes is
  // reported as "flaky", never silently green.
  retries: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: {
    command: `pnpm exec vite build --config vite.e2e.config.ts && pnpm exec vite preview --config vite.e2e.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
