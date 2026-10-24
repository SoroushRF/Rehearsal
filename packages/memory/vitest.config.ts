import { defineProject } from "vitest/config";

// The memory gate runs against the hosted Agent Memory service and is skipped unless
// MEMORY_GATE=1 (with the SURREAL_AGENT_MEMORY_* variables in .env). Recall takes 5–10 s there.
export default defineProject({
  test: { name: "memory", testTimeout: 60_000, hookTimeout: 60_000 },
});
