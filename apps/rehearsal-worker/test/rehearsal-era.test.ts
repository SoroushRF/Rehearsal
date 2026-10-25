import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { planHash } from "@rehearsal/core";
import { createDb, loadRehearsal, schema } from "@rehearsal/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rehearsablePlan, type Stack, startStack } from "./stack";

const ROOT = new URL("../../../", import.meta.url);
const ENABLED =
  process.env.ERA_CONFORMANCE === "1" &&
  process.env.ERA_REHEARSAL === "1" &&
  Boolean(process.env.DB_TESTS);
if (ENABLED && existsSync(new URL(".env", ROOT))) process.loadEnvFile(new URL(".env", ROOT));

type Summary = { rehearsalId: string; state: string; detail: string | null };

// T2.20 on Era: the API's routes, the operator side and the rehearsal worker process together.
// Needs `pnpm infra:up:rehearsal`, Postgres, and `ERA_CONFORMANCE=1 ERA_REHEARSAL=1 DB_TESTS=1`.
describe.skipIf(!ENABLED)("execution rehearsal through the API and the worker (Era)", () => {
  let stack: Stack;
  const db = ENABLED ? createDb(process.env.DATABASE_URL) : (null as never);
  beforeAll(async () => {
    stack = await startStack();
  }, 90_000);
  afterAll(async () => {
    await stack?.stop();
    await db?.$client.end();
  });

  async function api(token: string, method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(`${stack.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function setup(refused = false) {
    const orgId = `org_${randomUUID()}`;
    const planId = `plan_${randomUUID()}`;
    const { lead } = await stack.org(orgId, ["lead"], { planId, refused });
    const hash = planHash(rehearsablePlan(orgId, planId, { refused }));
    const start = () =>
      api(lead as string, "POST", `/api/plans/${planId}/execution-rehearsals`, {
        planId,
        revision: 1,
        planHash: hash,
        scenario: { id: "clean", version: 1 },
      });
    const list = async () =>
      (await api(lead as string, "GET", `/api/plans/${planId}/execution-rehearsals`)).body
        .rehearsals as Summary[];
    return { orgId, planId, lead: lead as string, start, list };
  }
  async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > deadline) throw new Error(`${what} timed out\n${stack.workerLog()}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it("runs the stored plan in its own tenant, reports it and resets the tenant", async () => {
    const s = await setup();
    const started = await s.start();
    expect(started.status).toBe(201);
    const id = (started.body.rehearsal as Summary).rehearsalId;

    const [done] = await until(s.list, (l) => l[0]?.state === "completed", "completion");
    expect(done).toMatchObject({ rehearsalId: id, state: "completed", detail: null });
    const stored = await until(
      () => loadRehearsal(db, s.orgId, id),
      (r) => r?.tornDown === true,
      "teardown",
    );
    expect(stored?.events.map((e) => e.state)).toEqual([
      "queued",
      "provisioning",
      "running",
      "verifying",
      "completed",
      "completed",
    ]);

    const report = await api(s.lead, "GET", `/api/execution-rehearsals/${id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.stale).toEqual([]);
    const got = report.body.report as Record<string, unknown>;
    expect(got).toMatchObject({
      rehearsalId: id,
      state: "completed",
      verdict: "unknown",
      evidence: "era_integration",
      versions: { worker: "rehearsal-worker@0.0.0", verifier: "none" },
    });
    const steps = got.steps as { actionId: string; result: { outcome: string } | null }[];
    expect(steps.map((x) => [x.actionId, x.result?.outcome]).sort()).toEqual([
      ["note_001", "confirmed"],
      ["patch_001", "confirmed"],
      ["refund_001", "confirmed"],
    ]);
    // The worker wrote only rehearsal rows: no run, attempt or receipt for this org.
    for (const table of [schema.runs, schema.stepAttempts, schema.stepReceipts]) {
      expect(await db.select().from(table).where(eq(table.orgId, s.orgId))).toEqual([]);
    }
  }, 90_000);

  it("refuses a snapshot it can't seed faithfully, says why, and a retry is a new rehearsal", async () => {
    const s = await setup(true);
    const first = await s.start();
    expect(first.status).toBe(201);
    const [failed] = await until(s.list, (l) => l[0]?.state === "failed", "failure");
    expect(failed?.detail).toMatch(/^snapshot refused: q_charges: ch_\w+ match, not in evidence/);
    const stored = await until(
      () => loadRehearsal(db, s.orgId, (failed as Summary).rehearsalId),
      (r) => r?.tornDown === true,
      "teardown",
    );
    expect(stored?.state).toBe("failed");

    const retry = await s.start();
    expect(retry.status).toBe(201);
    expect(retry.body.existing).toBe(false);
    expect((retry.body.rehearsal as Summary).rehearsalId).not.toBe(failed?.rehearsalId);
  }, 90_000);
});
