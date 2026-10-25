import { randomBytes, randomUUID } from "node:crypto";
import type { PlanManifest, RehearsalScenarioId } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  challengeOperations,
  createReadGuard,
  planHash,
  rehearsalTenant,
  resolveScenario,
} from "@rehearsal/core";
import {
  FakeClock,
  type FakeWorld,
  FIXTURE_REHEARSAL_VERSIONS,
  happyPathBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import {
  createDb,
  holdContainerSet,
  loadRehearsal,
  markContainerSetDirty,
  migrateDb,
  type RehearsalRunContext,
  requestRehearsal,
  runRehearsalJob,
  schema,
  startQueue,
} from "../src";

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];
const START = "2026-10-01T12:00:00.000Z";

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
// The worlds are in-memory fakes (evidence `fixture`); the store, journal, queue and locks are real.
describe.skipIf(!process.env.DB_TESTS)("challenged rehearsals (T3.16, real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  let boss: PgBoss;
  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await db.$client.end();
  });

  async function requested(scenario: RehearsalScenarioId) {
    const orgId = `org_${randomUUID()}`;
    const planId = `plan_${randomUUID()}`;
    const manifest: PlanManifest = { ...happyPathBundle().manifest, orgId, planId };
    const hash = planHash(manifest);
    await db
      .insert(schema.planVersions)
      .values({ orgId, planId, revision: 1, planHash: hash, manifest });
    const res = await requestRehearsal(db, boss, {
      orgId,
      userId: "user_support",
      idempotencyKey: randomUUID(),
      request: { planId, revision: 1, planHash: hash, scenario: { id: scenario, version: 1 } },
      now: new Date(START),
      newId: () => randomBytes(8).toString("hex"),
    });
    if (res.kind !== "accepted") throw new Error(`not accepted: ${res.kind}`);
    const [job] = (
      await db.execute<{ data: unknown }>(
        sql`select data from pgboss.job where name = 'rehearsal' and data->>'rehearsalId' = ${res.rehearsalId}`,
      )
    ).rows;
    return { orgId, planId, manifest, id: res.rehearsalId, data: job?.data };
  }

  /** The operator's side over a fake world: inject and the teammate edit, as the API applies them. */
  function operator(world: FakeWorld, manifest: PlanManifest, scenario: RehearsalScenarioId) {
    const calls: string[] = [];
    const challenge: NonNullable<RehearsalRunContext["challenge"]> = async (input) => {
      const resolved = resolveScenario(manifest, { id: scenario, version: 1 });
      if (!resolved.ok) throw new Error(resolved.reason);
      const applied: string[] = [];
      for (const op of challengeOperations(resolved.scenario)) {
        if (input.phase === "before_run" && op.kind === "inject_records") {
          for (const c of op.charges) {
            world.charges.set(c.id, {
              id: c.id,
              customer: c.customerId,
              amount: c.amountMinor,
              amount_refunded: 0,
              currency: c.currency,
              status: "succeeded",
              created: c.created,
            });
          }
          applied.push(`inject ${op.charges.map((c) => c.id).join(",")}`);
        }
        if (
          input.phase === "after_rejected" &&
          op.kind === "vendor_write" &&
          op.when.afterActionId === input.actionId
        ) {
          const ticketId = /tickets\/([^/.]+)\.json/.exec(op.path)?.[1] ?? "";
          world.teammateEdit(ticketId, "priority", op.body.ticket.priority);
          applied.push(`edit ${ticketId}`);
        }
      }
      calls.push(`${input.phase}${input.actionId ? `:${input.actionId}` : ""}`);
      return { applied };
    };
    return { challenge, calls };
  }

  function context(
    r: { id: string; manifest: PlanManifest },
    world: FakeWorld,
    scenario: RehearsalScenarioId,
    extra: Partial<RehearsalRunContext> = {},
  ) {
    const tenant = rehearsalTenant(r.id);
    const providers = { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") };
    const worlds = {
      stripe: { world: "rehearsal" as const, tenant },
      zendesk: { world: "rehearsal" as const, tenant },
    };
    const clock = new FakeClock(START);
    const op = operator(world, r.manifest, scenario);
    const torn: string[] = [];
    const ctx: RehearsalRunContext = {
      db,
      providers,
      worlds,
      clock,
      guard: createReadGuard({ providers, worlds, clock }),
      policies: POLICIES,
      newId: (p) => `${p}_${randomUUID()}`,
      versions: FIXTURE_REHEARSAL_VERSIONS,
      evidence: "fixture",
      provision: async () => ({ ok: true, notFromEvidence: [] }),
      teardown: async (rid) => {
        torn.push(rid);
      },
      challenge: op.challenge,
      containerSet: `set_${randomUUID()}`,
      setWaitMs: 0,
      sleep: async () => {},
      ...extra,
    };
    return { ctx, calls: op.calls, torn };
  }

  async function ran(scenario: RehearsalScenarioId, extra: Partial<RehearsalRunContext> = {}) {
    const r = await requested(scenario);
    const world = worldFromManifest(r.manifest.observations);
    const c = context(r, world, scenario, extra);
    const result = await runRehearsalJob(r.data, c.ctx);
    const report = result.kind === "ran" ? result.report : null;
    return { r, world, c, result, report };
  }

  const byId = (report: { steps: { actionId: string; expected: string; result: unknown }[] }) =>
    Object.fromEntries(
      report.steps.map((s) => [
        s.actionId,
        [s.expected, (s.result as { outcome?: string } | null)?.outcome ?? null],
      ]),
    );

  async function operationalUntouched(orgId: string) {
    for (const table of [schema.stepAttempts, schema.stepReceipts, schema.objectBindings]) {
      expect(await db.select().from(table).where(eq(table.orgId, orgId))).toEqual([]);
    }
    expect(await db.select().from(schema.runs).where(eq(schema.runs.orgId, orgId))).toEqual([]);
  }

  async function attemptKeys(orgId: string, id: string) {
    const rows = await db
      .select()
      .from(schema.rehearsalAttempts)
      .where(
        and(
          eq(schema.rehearsalAttempts.orgId, orgId),
          eq(schema.rehearsalAttempts.rehearsalId, id),
        ),
      );
    return rows;
  }

  /** Every step came out as the catalog expects for it. */
  function asExpected(report: NonNullable<Awaited<ReturnType<typeof ran>>["report"]>) {
    for (const [actionId, [expected, got]] of Object.entries(byId(report))) {
      expect({ actionId, got }).toEqual({ actionId, got: expected });
    }
  }

  it("clean is unchanged: every step confirms, no mark, no operator call", async () => {
    const { r, report, c, result } = await ran("clean");
    expect(result).toMatchObject({ kind: "ran", state: "completed" });
    if (!report) throw new Error("no report");
    asExpected(report);
    expect(c.calls).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.rehearsalDirtyMarks)
        .where(eq(schema.rehearsalDirtyMarks.rehearsalId, r.id)),
    ).toEqual([]);
    await operationalUntouched(r.orgId);
  }, 30_000);

  it("phantom_membership: the in-window charge holds the refund, its note waits, no refund lands", async () => {
    const { r, world, report, c, result } = await ran("phantom_membership");
    expect(result).toMatchObject({ kind: "ran", state: "completed" });
    if (!report) throw new Error("no report");
    asExpected(report);
    const refund = report.steps.find((s) => s.actionId === "refund_001");
    expect(refund?.result?.holdReason?.kind).toBe("query_membership_changed");
    expect(c.calls).toEqual(["before_run"]);
    const target = r.manifest.actions.find((a) => a.id === "refund_001");
    const chargeId = target?.kind === "stripe.refund.create" ? target.args.chargeId : "";
    expect(world.refunds.filter((x) => x.charge === chargeId)).toEqual([]);
    // Marked dirty before the inject, cleared once it ended.
    const [mark] = await db
      .select()
      .from(schema.rehearsalDirtyMarks)
      .where(eq(schema.rehearsalDirtyMarks.rehearsalId, r.id));
    expect(mark?.clearedAt).not.toBeNull();
    expect(
      (await attemptKeys(r.orgId, r.id)).every((a) => a.operationKey.startsWith(`rh_${r.id}_`)),
    ).toBe(true);
    await operationalUntouched(r.orgId);
  }, 30_000);

  it("teammate_field_edit: the note is failed, the teammate's priority survives compensation", async () => {
    const { r, world, report, c, result } = await ran("teammate_field_edit");
    expect(result).toMatchObject({ kind: "ran", state: "completed" });
    if (!report) throw new Error("no report");
    asExpected(report);
    expect(c.calls).toEqual(["after_rejected:note_001"]);
    const patch = r.manifest.actions.find((a) => a.id === "patch_001");
    const ticketId = patch?.kind === "zendesk.ticket.patchFields" ? patch.args.ticketId : "";
    expect(world.tickets.get(ticketId)?.priority).toBe("urgent");
    // The failed note was answered by the transport and never sent.
    const note = (await attemptKeys(r.orgId, r.id)).filter((a) => a.actionId === "note_001");
    expect(note.map((a) => [a.state, a.providerStatus])).toEqual([["rejected", 422]]);
    expect(world.effects.some((e) => e.operationKey === note[0]?.operationKey)).toBe(false);
    await operationalUntouched(r.orgId);
  }, 30_000);

  it("lost_response_restart: one refund commits, the restart reads it back, nothing is re-sent", async () => {
    const { r, world, report, result } = await ran("lost_response_restart");
    expect(result).toMatchObject({ kind: "ran", state: "completed" });
    if (!report) throw new Error("no report");
    asExpected(report);
    const key = (await attemptKeys(r.orgId, r.id)).filter((a) => a.actionId === "refund_001");
    // One attempt, sent once, settled by the restart's read.
    expect(key.map((a) => a.state)).toEqual(["reconciled"]);
    expect(world.effects.filter((e) => e.operationKey === key[0]?.operationKey)).toHaveLength(1);
    await operationalUntouched(r.orgId);
  }, 30_000);

  it("benign_nonmatching_change: a charge outside the window holds nothing", async () => {
    const { report, result } = await ran("benign_nonmatching_change");
    expect(result).toMatchObject({ kind: "ran", state: "completed" });
    if (!report) throw new Error("no report");
    asExpected(report);
  }, 30_000);

  it("a scenario that needs the operator fails closed without its hook", async () => {
    const { result, world } = await ran("phantom_membership", { challenge: undefined });
    expect(result).toMatchObject({ kind: "ran", state: "failed" });
    expect(result.kind === "ran" && result.report).toBe(null);
    expect(world.effects).toEqual([]);
  }, 30_000);

  it("a challenged run waits for shared holders of its set; unchallenged runs share it", async () => {
    const set = `set_${randomUUID()}`;
    const shared = await holdContainerSet(db, set, "shared");
    if (!shared) throw new Error("no shared lock");
    try {
      const clean = await ran("clean", { containerSet: set });
      expect(clean.result).toMatchObject({ kind: "ran", state: "completed" });
      const busy = await ran("phantom_membership", { containerSet: set, setWaitMs: 300 });
      expect(busy.result).toMatchObject({ kind: "ran", state: "failed" });
      expect(busy.world.effects).toEqual([]);
      const stored = await loadRehearsal(db, busy.r.orgId, busy.r.id);
      expect(stored?.events.find((e) => e.state === "failed")?.detail).toMatch(/stayed busy/);
    } finally {
      await shared.release();
    }
    const free = await ran("phantom_membership", { containerSet: set });
    expect(free.result).toMatchObject({ kind: "ran", state: "completed" });
  }, 30_000);

  it("while a set is marked dirty, every rehearsal on it is refused", async () => {
    const set = `set_${randomUUID()}`;
    await markContainerSetDirty(db, {
      set,
      orgId: "org_other",
      rehearsalId: randomBytes(8).toString("hex"),
      now: new Date(START),
    });
    for (const scenario of ["clean", "lost_response_restart"] as const) {
      const { result, world, r } = await ran(scenario, { containerSet: set });
      expect(result).toMatchObject({ kind: "ran", state: "failed" });
      expect(world.effects).toEqual([]);
      const stored = await loadRehearsal(db, r.orgId, r.id);
      expect(stored?.events.find((e) => e.state === "failed")?.detail).toMatch(/marked dirty/);
    }
  }, 30_000);
});
