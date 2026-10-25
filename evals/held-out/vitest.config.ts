import { defineProject } from "vitest/config";

// Integrity and separation checks run offline in CI. The Era seed check needs ERA_CONFORMANCE=1.
export default defineProject({
  test: { name: "held-out" },
});
