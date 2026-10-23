import { describe, expect, it } from "vitest";
import { plannerJobsClient } from "../src";

const JOB_ID = "7a1d3c52-8a0e-4b8e-9d55-0f3f5b8a2e11";

/** An API that accepts the connection and never answers, until the request is aborted. */
const hung: typeof fetch = (_input, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("plannerJobsClient", () => {
  it("gives up on an API that never answers, so the worker isn't wedged", async () => {
    const jobs = plannerJobsClient("http://api.test", "secret", hung, 20);
    for (const call of [
      () => jobs.next(),
      () => jobs.complete(JOB_ID, { manifest: {}, summary: "" }),
      () => jobs.fail(JOB_ID, { reason: "timeout", message: "" }),
    ]) {
      const settled = await Promise.race([
        call().then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((r) => setTimeout(() => r("wedged"), 2_000)),
      ]);
      expect(settled).toBe("rejected");
    }
  });
});
