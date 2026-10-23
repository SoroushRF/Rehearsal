import { defineProject } from "vitest/config";

// The catalog and the scoring run offline in CI. The Era run itself is `pnpm eval:scorecard`.
export default defineProject({
  test: { name: "scorecard" },
});
