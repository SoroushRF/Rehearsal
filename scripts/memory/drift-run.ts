import { type Db, loadRegistry, memoryErased, type PrecedentSyncJob } from "@rehearsal/db";
import {
  DRIFT_GRACE_MS,
  type DriftReader,
  dropChanged,
  findDrift,
  formatDriftFinding,
  MEMORY_WRITE_KEY_ENV,
} from "@rehearsal/memory";

/**
 * What `pnpm memory:drift` refuses to start with. It reads memory with a read-only key of its own
 * and the registry with DATABASE_URL, and acts only by queueing the API's sync jobs: never with a
 * key that could write or administer memory, nor the planner's or executor's credentials.
 */
export const DRIFT_FORBIDDEN = [
  ...MEMORY_WRITE_KEY_ENV,
  "ANTHROPIC_API_KEY",
  "PLANNER_WORKER_SECRET",
  "EXECUTOR_WORKER_SECRET",
  "ERA_ADMIN_TOKEN",
] as const;

export function driftCredentialViolations(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return DRIFT_FORBIDDEN.filter((k) => env[k]);
}

export interface DriftRun {
  db: Db;
  orgs: readonly string[];
  /** Each org's scope, read with a read-only key. */
  readerFor: (orgId: string) => DriftReader;
  /**
   * With `--repair`: queue a `precedent-sync` job unless the same one is already pending. The
   * API's sync handler does the writing.
   */
  enqueue?: (job: PrecedentSyncJob) => Promise<"queued" | "already_queued">;
  /** With `--activate-waiting`: also queue repairs that activate a waiting version. */
  activateWaiting?: boolean;
  now?: () => Date;
  graceMs?: number;
  log: (line: string) => void;
}

export interface DriftRunResult {
  findings: number;
  queued: number;
  alreadyQueued: number;
  /** Repairs that would activate a waiting version, left for `--activate-waiting`. */
  notActivated: number;
  /** Orgs with no registry and nothing found: most likely a mistyped org ID. */
  noRegistry: string[];
  /** Orgs whose Agent Memory was erased (T1.55): refused, never read or repaired. */
  erased: string[];
}

/**
 * The drift check behind `pnpm memory:drift` (T1.53), for each org in turn: read the registry,
 * compare memory with it, read the registry again and drop what changed in between, print one
 * line per finding, and with `enqueue` queue the sync job that fixes each one. Nothing here writes
 * to Agent Memory, and unknown copies are only reported. An org whose memory was erased is
 * refused before anything is read (T1.55).
 */
export async function runDrift(run: DriftRun): Promise<DriftRunResult> {
  const result: DriftRunResult = {
    findings: 0,
    queued: 0,
    alreadyQueued: 0,
    notActivated: 0,
    noRegistry: [],
    erased: [],
  };
  const graceMs = run.graceMs ?? DRIFT_GRACE_MS;
  for (const orgId of run.orgs) {
    // An erased org's memory stays empty: a repair would publish into it again, so don't look.
    if (await memoryErased(run.db, orgId)) {
      result.erased.push(orgId);
      run.log(`${orgId}: refused: its Agent Memory was erased (pnpm memory:erase-org)`);
      continue;
    }
    const before = (await loadRegistry(run.db, orgId)).entries;
    const report = await findDrift(run.readerFor(orgId), before, {
      graceMs,
      ...(run.now && { now: run.now() }),
    });
    const after = (await loadRegistry(run.db, orgId)).entries;
    const { kept, changed } = dropChanged(report.findings, before, after);

    const notes = [
      report.inFlight.length > 0 ? `${report.inFlight.length} in flight` : "",
      changed.length > 0 ? `${changed.length} changed during the check` : "",
    ].filter(Boolean);
    run.log(
      `${orgId} (${report.scope}): ${report.checked} checked, ${kept.length} drift${notes.length ? `, ${notes.join(", ")}` : ""}`,
    );
    if (before.length === 0 && kept.length === 0) {
      result.noRegistry.push(orgId);
      run.log(`  warning: no registry for ${orgId}; check the org id`);
    }
    for (const id of report.inFlight) {
      run.log(
        `  in flight ${id}: a version approved under ${graceMs / 60_000} min ago; its sync may still be running`,
      );
    }
    for (const id of changed) run.log(`  changed ${id}: the registry moved mid-check; run again`);

    // Where an activating publish is queued, it replaces the copy: skip that precedent's others.
    const activating = new Set(
      run.activateWaiting ? kept.filter((f) => f.repair?.activates).map((f) => f.id) : [],
    );
    for (const finding of kept) {
      result.findings++;
      run.log(`  ${formatDriftFinding(finding)}`);
      const repair = finding.repair;
      if (run.enqueue === undefined || repair === null) continue;
      if (repair.activates && !run.activateWaiting) {
        result.notActivated++;
        run.log(`    not queued: it activates v${repair.version}; pass --activate-waiting`);
        continue;
      }
      if (!repair.activates && activating.has(finding.id)) {
        run.log(`    not queued: the activating publish replaces the copy`);
        continue;
      }
      const outcome = await run.enqueue({
        orgId,
        precedentId: finding.id,
        version: repair.version,
        kind: repair.kind,
      });
      if (outcome === "queued") result.queued++;
      else result.alreadyQueued++;
      run.log(
        `    ${outcome === "queued" ? "queued" : "already queued"} ${repair.kind} v${repair.version}`,
      );
    }
  }
  return result;
}
