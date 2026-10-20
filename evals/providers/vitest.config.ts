import { defineProject } from "vitest/config";

// Pinned-image conformance. Every suite is skipped unless ERA_CONFORMANCE=1, so `pnpm test`
// stays offline; run `pnpm infra:up` first, then `pnpm test:providers` with the variable set.
export default defineProject({
  test: {
    name: "providers",
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Serial: the Zendesk same-second test is timing-sensitive, and the read-only control
    // starts its own containers.
    fileParallelism: false,
  },
});
