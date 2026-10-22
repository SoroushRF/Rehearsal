import { HealthResponse } from "@rehearsal/contracts";
import { expect, it } from "vitest";
import { buildApp } from "../src/app";

it("starts in core mode with no optional credentials", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(HealthResponse.parse(res.json()).mode).toBe("core");
  await app.close();
});

it("answers 503, not 404, for commands when started without a database", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/api/plans/p/apply", payload: {} });
  expect(res.statusCode).toBe(503);
  await app.close();
});
