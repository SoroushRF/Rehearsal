import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "evals/*/vitest.config.ts",
      "scripts/ci/vitest.config.ts",
    ],
  },
});
