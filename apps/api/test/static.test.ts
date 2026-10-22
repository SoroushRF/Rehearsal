import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const root = mkdtempSync(join(tmpdir(), "rehearsal-static-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>Review</title>");
afterAll(() => rmSync(root, { recursive: true }));

describe.each([root, null])("unknown commands with web root %s", (webRoot) => {
  it.each(["/internal/era/tenant-token", "/internal", "/api/missing", "/api?x=1", "/review"])(
    "refuses POST %s instead of serving the SPA",
    async (url) => {
      const app = buildApp({ webRoot });
      try {
        const res = await app.inject({ method: "POST", url, headers: { accept: "text/html" } });
        expect(res.statusCode).toBe(404);
        expect(res.headers["content-type"]).toContain("application/json");
      } finally {
        await app.close();
      }
    },
  );
});

it("serves HTML navigation while keeping API/internal GETs and JSON clients outside the SPA", async () => {
  const app = buildApp({ webRoot: root });
  try {
    for (const method of ["GET", "HEAD"] as const) {
      const res = await app.inject({
        method,
        url: "/plans/review",
        headers: { accept: "text/html" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    }
    for (const [url, accept] of [
      ["/api", "text/html"],
      ["/internal/missing", "text/html"],
      ["/plans/review", "application/json"],
    ]) {
      expect((await app.inject({ url, headers: { accept } })).statusCode).toBe(404);
    }
  } finally {
    await app.close();
  }
});
