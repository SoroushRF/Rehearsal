import {
  ExecutionRehearsalJob,
  PlanManifest,
  type RehearsalEvidence,
  type RehearsalVersions,
  type Vendor,
} from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type Clock,
  lookupScenario,
  type ProviderPort,
  type RunOutcome,
  reconcileRehearsal,
  type WorldContext,
} from "@rehearsal/core";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "./index";
import { REHEARSAL_QUEUE } from "./queue";
import {
  IN_FLIGHT_KEPT,
  type RehearsalRunContext,
  RehearsalRunJournal,
  type RehearsalRunResult,
  rehearsalInFlight,
  rehearsalReport,
  runRehearsalJob,
} from "./rehearsal-runner";
import { clearContainerSetDirty } from "./rehearsal-sets";
import {
  loadRehearsal,
  markRehearsalTornDown,
  rehearsalReportsFor,
  saveRehearsalReport,
  transitionRehearsal,
} from "./rehearsals";
import { planVersions, rehearsalEvents, rehearsals } from "./schema";

/**
 * T3.16: the rehearsal worker's lifecycle around `runRehearsalJob` (decision 0013, §5):
 * consuming the `rehearsal` queue, cancellation, and the sweeper that ends rehearsals whose worker
 * stopped, reads back what they left in flight, and tears down only what is safe to reset.
 */

const NOT_ENDED = ["queued", "provisioning", "running", "verifying"] as const;
type Ended = "completed" | "failed" | "cancelled";

/** The detail on the event that hands a retained tenant to an operator. */
export const HAND_OFF = "operator hand-off";

/**
 * Cancel a rehearsal that hasn't ended. A queued one is never claimed; a running one sends nothing
 * new (the runner checks before every send) but still reads back what is in flight. Final.
 */
export async function cancelRehearsal(
  db: Db,
  orgId: string,
  rehearsalId: string,
  opts: { now: Date; detail?: string },
): Promise<"cancelled" | "ended" | "not_found"> {
  const stored = await loadRehearsal(db, orgId, rehearsalId);
  if (!stored) return "not_found";
  const ok = await transitionRehearsal(db, orgId, rehearsalId, NOT_ENDED, "cancelled", {
    now: opts.now,
    detail: opts.detail ?? "cancelled",
  });
  return ok ? "cancelled" : "ended";
}

/**
 * Consume the `rehearsal` queue, one job at a time. The context is built per job: its writers and
 * readers bind to that rehearsal's own tenant. A thrown job is retried by pg-boss, and the retry
 * finds the rehearsal claimed and skips it: a rehearsal is never resumed, the sweeper ends it.
 */
export async function workRehearsalQueue(
  boss: PgBoss,
  contextFor: (job: ExecutionRehearsalJob) => Promise<RehearsalRunContext>,
  onResult: (jobId: string, result: RehearsalRunResult) => void = () => {},
): Promise<string> {
  return boss.work(REHEARSAL_QUEUE, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const parsed = ExecutionRehearsalJob.safeParse(job.data);
    const result = parsed.success
      ? await runRehearsalJob(job.data, await contextFor(parsed.data))
      : ({ kind: "skipped", reason: "malformed rehearsal job" } as const);
    onResult(job.id, result);
  });
}

export interface RehearsalSweepContext {
  db: Db;
  now: Date;
  /** A rehearsal that hasn't ended and has had no event for this long has lost its worker. */
  leaseMs: number;
  /**
   * How long a tenant is kept and re-read while a send of it is still in flight before an operator
   * is told. It is never reset while one is: the operator decides (retention rule, §5).
   */
  handOffAfterMs: number;
  /**
   * Readers for one rehearsal's own tenant (the operator mints its tokens again), or null when it
   * can't be read now. They read only: the pass they serve never sends.
   */
  readers: (rehearsalId: string) => Promise<{
    providers: Partial<Record<Vendor, ProviderPort>>;
    worlds: Partial<Record<Vendor, WorldContext>>;
  } | null>;
  /** Operator side: reset the tenant. Idempotent. */
  teardown: (rehearsalId: string, state: Ended) => Promise<void>;
  onHandOff?: (rehearsalIds: string[]) => void;
  /** Only these orgs (an operator acting for one org, or a test). Every org by default. */
  orgIds?: readonly string[];
  clock: Clock;
  policies: readonly BillingPolicy[];
  newId: (prefix: string) => string;
  versions: RehearsalVersions;
  evidence: RehearsalEvidence;
}

export interface RehearsalSweep {
  /** Ended as failed: no event within the lease. */
  expired: string[];
  /** Tenant reset. */
  tornDown: string[];
  /** Kept: a send is still in flight after reading. */
  retained: string[];
  /** Kept past `handOffAfterMs`, reported to an operator now (once each). */
  handedOff: string[];
}

type Row = {
  org_id: string;
  rehearsal_id: string;
  state: string;
  last_at: Date;
  ended_at: Date | null;
  handed_off: boolean;
};

/**
 * One pass of the sweeper (decision 0013, §5). It fails, never resumes, a rehearsal whose lease
 * expired; reads back every send it left in flight, through a read-only pass in its own tenant;
 * writes the report if the worker died before it could; and resets the tenant only once nothing
 * is in flight. A tenant still holding an unknown outcome is kept, and after `handOffAfterMs` is
 * handed to an operator. One sweeper acts at a time; another returns at once.
 */
export async function sweepRehearsals(ctx: RehearsalSweepContext): Promise<RehearsalSweep> {
  const out: RehearsalSweep = { expired: [], tornDown: [], retained: [], handedOff: [] };
  const client = await ctx.db.$client.connect();
  const LOCK = "select pg_try_advisory_lock(hashtextextended('rehearsal:sweeper', 0)) as ok";
  let locked = false;
  try {
    locked = (await client.query<{ ok: boolean }>(LOCK)).rows[0]?.ok === true;
    if (!locked) return out;
    const rows = (
      await ctx.db.execute<Row>(sql`
        select org_id, rehearsal_id,
          (array_agg(state order by seq desc))[1] as state,
          (array_agg(at order by seq desc))[1] as last_at,
          min(at) filter (where state in ('completed', 'failed', 'cancelled')) as ended_at,
          coalesce(bool_or(detail like ${`${HAND_OFF}%`}), false) as handed_off
        from rehearsal_events
        where ${ctx.orgIds ? (ctx.orgIds.length > 0 ? sql`org_id in ${[...ctx.orgIds]}` : sql`false`) : sql`true`}
        group by org_id, rehearsal_id
        having not bool_or(torn_down_at is not null)
        order by min(seq)
        limit 500`)
    ).rows;
    for (const row of rows) {
      try {
        await sweepOne(ctx, row, out);
      } catch (err) {
        console.error(`rehearsal sweep of ${row.rehearsal_id} failed`, err);
      }
    }
    if (out.handedOff.length > 0) ctx.onHandOff?.(out.handedOff);
    return out;
  } finally {
    if (locked) {
      await client
        .query("select pg_advisory_unlock(hashtextextended('rehearsal:sweeper', 0))")
        .catch(() => {});
    }
    client.release();
  }
}

async function sweepOne(ctx: RehearsalSweepContext, row: Row, out: RehearsalSweep) {
  const { db, now } = ctx;
  const orgId = row.org_id;
  const id = row.rehearsal_id;
  let state = row.state;
  let endedAt = row.ended_at ? new Date(row.ended_at) : null;
  if ((NOT_ENDED as readonly string[]).includes(state)) {
    if (now.getTime() - new Date(row.last_at).getTime() < ctx.leaseMs) return;
    const detail = `lease expired in ${state}: its worker stopped, and a rehearsal is never resumed`;
    if (!(await transitionRehearsal(db, orgId, id, [state as never], "failed", { now, detail }))) {
      return; // it moved meanwhile: the next pass looks again
    }
    out.expired.push(id);
    state = "failed";
    endedAt = now;
  }
  const ended = state as Ended;
  // A challenged run that stopped leaves its set marked dirty. Catalog v1 sets no container-wide
  // fault (a container-wide scenario is refused before any inject), so once it has ended there is
  // nothing beyond its own tenant to clean, and cleanup is confirmed (decision 0013 §3).
  const listed = await scenarioOf(db, orgId, id);
  if (listed && !listed.containerWide) {
    await clearContainerSetDirty(
      db,
      id,
      "sweeper: ended, no container-wide fault (catalog v1)",
      now,
    );
  }

  let outcome: RunOutcome | null = null;
  if ((await rehearsalInFlight(db, orgId, id)).length > 0) {
    outcome = await readBack(ctx, orgId, id);
  }
  const inFlight = (await rehearsalInFlight(db, orgId, id)).length > 0;
  await reportIfMissing(ctx, orgId, id, ended, outcome, inFlight);

  if (inFlight) {
    out.retained.push(id);
    const kept = now.getTime() - (endedAt ?? now).getTime();
    if (!row.handed_off && kept >= ctx.handOffAfterMs) {
      await db.insert(rehearsalEvents).values({
        orgId,
        rehearsalId: id,
        state: ended,
        detail: `${HAND_OFF}: a send's outcome is still unknown after reading; the tenant is kept until an operator resolves it`,
        tornDownAt: null,
        at: now,
      });
      out.handedOff.push(id);
    }
    return;
  }
  await ctx.teardown(id, ended);
  if (await markRehearsalTornDown(db, orgId, id, now)) out.tornDown.push(id);
}

/** The stored rehearsal as its job (every binding is on the row) and its exact stored plan. */
async function storedJob(db: Db, orgId: string, id: string) {
  const stored = await loadRehearsal(db, orgId, id);
  const r = stored?.rehearsal;
  if (!r) return null;
  const [plan] = await db
    .select()
    .from(planVersions)
    .where(
      and(
        eq(planVersions.orgId, orgId),
        eq(planVersions.planId, r.planId),
        eq(planVersions.revision, r.revision),
      ),
    );
  const manifest = PlanManifest.safeParse(plan?.manifest);
  if (!plan || !manifest.success || plan.planHash !== r.planHash) return null;
  const job = {
    rehearsalId: id,
    plan: { orgId, planId: r.planId, revision: r.revision, planHash: r.planHash },
    scenario: { id: r.scenarioId as "clean", version: r.scenarioVersion },
    snapshot: { kind: "plan-evidence" as const, digest: r.snapshotDigest },
    policy: { id: r.policyId, version: r.policyVersion },
  };
  return { job, plan, manifest: manifest.data, requestedAt: r.requestedAt };
}

/** A read-only pass over the attempts the worker left: reads only, in the rehearsal's own tenant. */
async function readBack(ctx: RehearsalSweepContext, orgId: string, id: string) {
  const found = await storedJob(ctx.db, orgId, id);
  const readers = found && (await ctx.readers(id));
  if (!found || !readers) return null;
  const journal = await RehearsalRunJournal.load(ctx.db, orgId, id);
  return reconcileRehearsal(
    {
      orgId,
      rehearsalId: id,
      planId: found.job.plan.planId,
      revision: found.job.plan.revision,
      planHash: found.job.plan.planHash,
    },
    {
      plans: {
        loadPlan: async () => ({ planHash: found.plan.planHash, manifest: found.plan.manifest }),
        rehearsalCancelled: async () => true, // it has ended: nothing new is ever sent
      },
      journal,
      providers: readers.providers,
      worlds: readers.worlds,
      clock: ctx.clock,
      policies: ctx.policies,
      newId: ctx.newId,
      sleep: async () => {},
    },
  );
}

/** A worker that died before its report leaves none: write it from what the reads found. */
async function reportIfMissing(
  ctx: RehearsalSweepContext,
  orgId: string,
  id: string,
  state: Ended,
  outcome: RunOutcome | null,
  inFlight: boolean,
) {
  const [existing] = await ctx.db
    .select({ id: rehearsals.id })
    .from(rehearsals)
    .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.id, id)));
  if (!existing) return;
  const found = await storedJob(ctx.db, orgId, id);
  if (!found) return;
  const reports = await rehearsalReportsFor(ctx.db, orgId, found.job.plan.planId);
  if (reports.some((r) => r.rehearsalId === id)) return;
  // No verifier reads here. The tenant may already be gone, and a missing read must not pass.
  const report = rehearsalReport(found.job, found.manifest, outcome?.receipts ?? [], {
    state,
    limitations: [
      "its worker stopped before reporting: steps are from the sweeper's reads, and a step with no result was never read back",
      ...(inFlight ? [IN_FLIGHT_KEPT] : []),
    ],
    notFromEvidence: [],
    startedAt: found.requestedAt.toISOString(),
    finishedAt: ctx.now.toISOString(),
    versions: ctx.versions,
    evidence: ctx.evidence,
  });
  await saveRehearsalReport(ctx.db, orgId, report, ctx.now).catch(() => {});
}

async function scenarioOf(db: Db, orgId: string, id: string) {
  const stored = await loadRehearsal(db, orgId, id);
  const r = stored?.rehearsal;
  return r ? lookupScenario({ id: r.scenarioId, version: r.scenarioVersion }) : undefined;
}
