import {
  approvedVersion,
  type Db,
  latestApproved,
  loadRegistry,
  lockOrgMemoryShared,
  lockPrecedent,
  lockPrecedentMemory,
  memoryErased,
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
  precedentScope,
} from "@rehearsal/memory";

export { precedentScope } from "@rehearsal/memory";

/** What the sync needs from Agent Memory: store a version, or retire it, and read it back. */
export type PrecedentPublisher = Pick<AgentMemoryPrecedents, "publish" | "markWithdrawn">;
export type PublisherFor = (orgId: string) => PrecedentPublisher;

/** Publishers built from the environment, or null when Agent Memory isn't configured (core mode). */
export function publisherFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetch?: typeof fetch } = {},
) {
  const config = memoryConfigFromEnv("write", env);
  if (config === null) return null;
  const { scope, ...client } = config;
  const memory = new AgentMemoryClient({ ...client, ...options });
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

export type SyncResult =
  | "activated"
  | "already_active"
  | "no_such_version"
  | "withdrawn"
  | "marked_withdrawn"
  | "newer_version"
  | "org_erased";

/**
 * Publishes one approved version to Agent Memory, reads it back, and only then records it as
 * activated. Memory is a recall index: until this succeeds the precedent is "waiting" and no plan
 * rests on it. Safe to run again: publishing the stored version sends nothing, and the activation
 * event is written once. A failure throws, so the queue retries. A `withdraw` job retires the
 * stored copy instead (`markWithdrawn`).
 *
 * An org whose memory was erased (T1.55, `pnpm memory:erase-org`) is refused: the job writes
 * nothing and completes as `org_erased`, so it isn't retried, and its version stays waiting.
 */
export async function syncPrecedent(
  jobData: unknown,
  deps: { db: Db; publisherFor: PublisherFor },
): Promise<SyncResult> {
  const job = PrecedentSyncJob.parse(jobData);
  if (job.kind === "withdraw") return markWithdrawn(job, deps);
  const approved = await approvedVersion(deps.db, job.orgId, job.precedentId, job.version);
  if (!approved) return "no_such_version";
  const record = PrecedentRecord.parse(approved.record);

  return deps.db.transaction(async (tx) => {
    if (await refusedAsErased(tx, job.orgId)) return "org_erased";
    await lockPrecedentMemory(tx, job.orgId, job.precedentId);
    // A redelivered job for a version withdrawn since mustn't put its copy back over the marker.
    if (await isWithdrawn(tx, job)) return "withdrawn";
    await deps.publisherFor(job.orgId).publish(record);
    await lockPrecedent(tx, job.orgId, job.precedentId);
    const written = await recordPrecedentEvent(tx, {
      orgId: job.orgId,
      precedentId: job.precedentId,
      version: job.version,
      kind: "activated",
    });
    return written ? "activated" : "already_active";
  });
}

/**
 * Overwrites a withdrawn version's copy in Agent Memory with the withdrawal marker, so recall
 * stops offering it (T1.51). The registry already dropped it; this only tidies the index. Holds
 * the memory lock the publish takes, so the check and the write can't straddle a newer version's
 * publish: once any newer version is approved, its own sync replaces the copy and this does
 * nothing. That newer version's sync could still fail for good, leaving the withdrawn copy in
 * memory, where recall offers it and the registry drops it, as it did before markers.
 */
async function markWithdrawn(
  job: PrecedentSyncJob,
  deps: { db: Db; publisherFor: PublisherFor },
): Promise<SyncResult> {
  return deps.db.transaction(async (tx) => {
    if (await refusedAsErased(tx, job.orgId)) return "org_erased";
    await lockPrecedentMemory(tx, job.orgId, job.precedentId);
    const latest = await latestApproved(tx, job.orgId, job.precedentId);
    if (!latest) return "no_such_version";
    if (latest.version > job.version) return "newer_version";
    if (!(await isWithdrawn(tx, job))) return "no_such_version";
    await deps.publisherFor(job.orgId).markWithdrawn(job.precedentId, job.version);
    return "marked_withdrawn";
  });
}

/**
 * Holds the org's memory lock shared until the transaction ends, so an erasure can't commit while
 * this job writes, then says whether one already has. Either way nothing reaches an erased scope.
 */
async function refusedAsErased(
  tx: Parameters<typeof lockOrgMemoryShared>[0],
  orgId: string,
): Promise<boolean> {
  await lockOrgMemoryShared(tx, orgId);
  return memoryErased(tx, orgId);
}

/** Withdrawn is final: a withdrawn version is never active again. */
async function isWithdrawn(
  db: Parameters<typeof loadRegistry>[0],
  job: PrecedentSyncJob,
): Promise<boolean> {
  const { entries } = await loadRegistry(db, job.orgId);
  return entries.some(
    (e) => e.id === job.precedentId && e.version === job.version && e.status === "withdrawn",
  );
}

/** Runs sync jobs one at a time; Agent Memory recall is slow and the jobs are few. */
export async function startPrecedentWorker(
  boss: PgBoss,
  deps: { db: Db; publisherFor: PublisherFor },
) {
  return boss.work(PRECEDENT_QUEUE, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    if ((await syncPrecedent(job.data, deps)) === "org_erased") {
      const { orgId, precedentId, version } = PrecedentSyncJob.parse(job.data);
      console.warn(
        `precedent-sync: ${orgId}'s Agent Memory was erased; ${precedentId} v${version} not written`,
      );
    }
  });
}
