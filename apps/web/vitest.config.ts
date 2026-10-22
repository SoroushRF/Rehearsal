import { defineProject } from "vitest/config";

export default defineProject({
  // Browser tests in e2e/ run under Playwright (`pnpm --filter @rehearsal/web e2e`), not Vitest.
  test: { name: "web", include: ["test/**/*.test.{ts,tsx}"] },
});
