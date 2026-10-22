import { defineProject } from "vitest/config";

// Offline unit tests. The live-image conformance suites are the "providers" project in evals/.
export default defineProject({
  test: { name: "providers-unit" },
});
