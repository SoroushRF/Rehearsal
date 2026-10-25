import { createHash } from "node:crypto";
import {
  approvedVersion,
  type Db,
  lockPrecedent,
  type PgBoss,
  PRECEDENT_QUEUE,
  PrecedentSyncJob,
  recordPrecedentEvent,
} from "@rehearsal/db";
import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  memoryConfigFromEnv,
  PrecedentRecord,
} from "@rehearsal/memory";

/** What the sync needs from Agent Memory: store a version and read it back. */
export type PrecedentPublisher = Pick<AgentMemoryPrecedents, "publish">;
export type PublisherFor = (orgId: string) => PrecedentPublisher;

/**
 * One memory scope per organization (decision 0012): a shared scope would let one organization's
 * planner recall another's precedents. Clerk org IDs are mixed case and the service takes only
 * lowercase paths, so the scope carries a hash of the ID instead.
 */
export function precedentScope(baseScope: string, orgId: string): string {
  return `${baseScope}/org-${createHash("sha256").update(orgId).digest("hex").slice(0, 16)}`;
}

/** Publishers built from the environment, or null when Agent Memory isn't configured (core mode). */
export function publisherFromEnv(env: Record<string, string | undefined> = process.env) {
  const config = memoryConfigFromEnv(env);
  if (config === null) return null;
  const { scope, ...client } = config;
  const memory = new AgentMemoryClient(client);
  const byOrg = new Map<string, PrecedentPublisher>();
  const publisherFor: PublisherFor = (orgId) => {
    let publisher = byOrg.get(orgId);
    if (!publisher) {
      publisher = new AgentMemoryPrecedents(memory, { scope: precedentScope(scope, orgId) });
      byOrg.set(orgId, publisher);
    }
    return publisher;
  };
  return publisherFor;
}

export type SyncResult = "activated" | "already_active" | "no_such_version";

/**
 * Publishes one approved version to Agent Memory, reads it back, and only then records it as
 * activated. Memory is a recall index: until this succeeds the precedent is "waiting" and no plan
 * rests on it. Safe to run again: publishing the stored version sends nothing, and the activation
 * event is written once. A failure throws, so the queue retries.
 */
export async function syncPrecedent(
  jobData: unknown,
  deps: { db: Db; publisherFor: PublisherFor },
): Promise<SyncResult> {
  const job = PrecedentSyncJob.parse(jobData);
  const approved = await approvedVersion(deps.db, job.orgId, job.precedentId, job.version);
  if (!approved) return "no_such_version";
  const record = PrecedentRecord.parse(approved.record);

  await deps.publisherFor(job.orgId).publish(record);
  const written = await deps.db.transaction(async (tx) => {
    await lockPrecedent(tx, job.orgId, job.precedentId);
    return recordPrecedentEvent(tx, {
      orgId: job.orgId,
      precedentId: job.precedentId,
      version: job.version,
      kind: "activated",
    });
  });
  return written ? "activated" : "already_active";
}

/** Runs sync jobs one at a time; Agent Memory recall is slow and the jobs are few. */
export async function startPrecedentWorker(
  boss: PgBoss,
  deps: { db: Db; publisherFor: PublisherFor },
) {
  return boss.work(PRECEDENT_QUEUE, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await syncPrecedent(job.data, deps);
  });
}
