import type { PrecedentRecall, StoredPrecedent } from "./precedents";

/** One approved version, as the registry derives it (`RegistryEntry` in `@rehearsal/db`). */
export interface DriftRegistryEntry {
  id: string;
  version: number;
  digest: string;
  appliesTo: string;
  status: "waiting" | "active" | "superseded" | "withdrawn";
  /** When finance approved it (ISO 8601): how long a waiting version has waited. */
  approvedAt: string;
}

/**
 * - `missing`: a version is active, and its copy is absent, fails readback or is a marker.
 * - `stale`: memory holds an older version, a version the registry never approved, or different
 *   content.
 * - `unmarked_withdrawal`: memory still offers a withdrawn precedent as approved.
 * - `waiting`: a version was approved longer ago than the grace period and never activated: its
 *   sync failed for good. Publishing it activates it, which moves its area's epoch.
 * - `unknown`: a copy of a precedent the registry never approved at all.
 */
export type DriftKind = "missing" | "stale" | "unmarked_withdrawal" | "waiting" | "unknown";

/** The `precedent-sync` job that repairs a finding. The API's sync handler does the writing. */
export interface DriftRepair {
  kind: "publish" | "withdraw";
  version: number;
  /**
   * True when the job would activate a version that is waiting, so its area's epoch moves and
   * plans resting on the version before it are held at admission. Queued only on request.
   */
  activates?: true;
}

export interface DriftFinding {
  kind: DriftKind;
  id: string;
  /** What Agent Memory holds, in words. */
  memory: string;
  /** What the registry says it should hold, in words. */
  registry: string;
  /** Null when no sync job can fix it; `why` says so. */
  repair: DriftRepair | null;
  why?: string;
}

export interface DriftReport {
  scope: string;
  /** Precedents compared: every one the registry approved, plus unknown ones recall surfaced. */
  checked: number;
  findings: DriftFinding[];
  /** Precedents left out because a version was approved within the grace period. */
  inFlight: string[];
  /** The recall queries that looked for copies the registry never approved. */
  probes: { query: string; traceId: string | null }[];
}

/** Read access only: the check can't publish, mark or erase anything. */
export interface DriftReader {
  readonly scope: string;
  read(id: string): Promise<StoredPrecedent>;
  recall(query: string): Promise<PrecedentRecall>;
}

export interface DriftOptions {
  /** Recall queries for unknown copies. Defaults to each area the registry knows, plus "precedent". */
  probes?: string[];
  now?: Date;
  /** How long a newly approved version's own sync may still be running. Defaults to 10 minutes. */
  graceMs?: number;
  /** Entity reads at a time. Defaults to 8. */
  concurrency?: number;
}

export const DRIFT_GRACE_MS = 10 * 60_000;

/**
 * Compares one org's Agent Memory scope with its registry (T1.53). The registry decides what
 * should be there; memory is only checked against it. Each finding names the sync job that fixes
 * it, for the caller to queue. Errors propagate: an outage fails the check instead of reporting no
 * drift.
 *
 * A precedent with a version approved within the grace period is left out: its own sync may be
 * running, and whatever memory holds now is about to change.
 *
 * Memory has no listing we've probed, so copies the registry never approved are found through
 * recall: by default one query per area the registry knows, plus "precedent". That finds what
 * recall would offer the planner, which is the copy that matters, not every stored entity.
 */
export async function findDrift(
  reader: DriftReader,
  entries: readonly DriftRegistryEntry[],
  options: DriftOptions = {},
): Promise<DriftReport> {
  const now = (options.now ?? new Date()).getTime();
  const grace = options.graceMs ?? DRIFT_GRACE_MS;
  const limit = options.concurrency ?? 8;
  const byId = new Map<string, DriftRegistryEntry[]>();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);

  const inFlight: string[] = [];
  const known: string[] = [];
  for (const id of [...byId.keys()].sort()) {
    const waiting = (byId.get(id) ?? []).filter((v) => v.status === "waiting");
    if (waiting.some((v) => now - Date.parse(v.approvedAt) < grace)) inFlight.push(id);
    else known.push(id);
  }

  const findings: DriftFinding[] = [];
  const stored = await mapLimit(known, limit, (id) => reader.read(id));
  known.forEach((id, i) => {
    findings.push(...compare(id, byId.get(id) ?? [], stored[i] as StoredPrecedent, now));
  });

  const queries =
    options.probes ?? [...new Set([...entries.map((e) => e.appliesTo), "precedent"])].sort();
  const probes: DriftReport["probes"] = [];
  const surfaced = new Set<string>();
  for (const query of queries) {
    const recall = await reader.recall(query);
    probes.push({ query, traceId: recall.traceId });
    for (const p of recall.precedents) surfaced.add(p.id);
    for (const r of recall.rejected) surfaced.add(r.id);
  }
  const unknownIds = [...surfaced].filter((s) => !byId.has(s)).sort();
  const copies = await mapLimit(unknownIds, limit, (id) => reader.read(id));
  let unknown = 0;
  unknownIds.forEach((id, i) => {
    const copy = copies[i] as StoredPrecedent;
    if (copy.status === "absent") return;
    unknown++;
    findings.push({
      kind: "unknown",
      id,
      memory: describe(copy),
      registry: "never approved",
      repair: null,
      why: "reported only; the check never deletes",
    });
  });
  return { scope: reader.scope, checked: known.length + unknown, findings, inFlight, probes };
}

/**
 * Drops findings whose precedent the registry changed while memory was being read (T1.53): a sync,
 * promotion or withdrawal that landed mid-check makes the comparison meaningless, and the next
 * check sees the settled state. Returns the findings kept and the IDs dropped.
 */
export function dropChanged(
  findings: readonly DriftFinding[],
  before: readonly DriftRegistryEntry[],
  after: readonly DriftRegistryEntry[],
): { kept: DriftFinding[]; changed: string[] } {
  const state = (entries: readonly DriftRegistryEntry[], id: string) =>
    JSON.stringify(
      entries
        .filter((e) => e.id === id)
        .map((e) => [e.version, e.status, e.digest])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    );
  const changed = new Set<string>();
  for (const f of findings) if (state(before, f.id) !== state(after, f.id)) changed.add(f.id);
  return { kept: findings.filter((f) => !changed.has(f.id)), changed: [...changed].sort() };
}

/** One line per finding, as `pnpm memory:drift` prints it. */
export function formatDriftFinding(f: DriftFinding): string {
  const repair = f.repair
    ? `repair: ${f.repair.kind} v${f.repair.version}${f.repair.activates ? " (activates it)" : ""}`
    : `repair: none (${f.why ?? "no sync job fixes this"})`;
  const why = f.repair && f.why ? ` (${f.why})` : "";
  return `${f.kind} ${f.id}: memory holds ${f.memory}; registry has ${f.registry}; ${repair}${why}`;
}

function describe(s: StoredPrecedent): string {
  switch (s.status) {
    case "absent":
      return "nothing";
    case "invalid":
      return `a copy that fails readback (${s.reason})`;
    case "withdrawn":
      return `the withdrawal marker for v${s.version}`;
    case "valid":
      return `v${s.record.version}`;
  }
}

function age(approvedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(approvedAt)) / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/**
 * The repair is the sync job that actually fixes the copy, which isn't always the obvious one.
 * Publish only goes up, so it can replace a copy only with a newer version. A `withdraw` job does
 * nothing once a newer version is approved (that version's sync owns the copy), so a withdrawn copy
 * under a newer waiting version is repaired by publishing that version. A repair that publishes a
 * waiting version is marked `activates`; a safe one, when there is one, is preferred.
 */
function compare(
  id: string,
  versions: DriftRegistryEntry[],
  stored: StoredPrecedent,
  now: number,
): DriftFinding[] {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1);
  if (latest === undefined) return [];
  const active = sorted.find((v) => v.status === "active");
  // Waiting versions only ever sit above the newest activated one; the latest is the one to sync.
  const waiting = latest.status === "waiting" ? latest : undefined;
  const registry = [
    active ? `v${active.version} active` : undefined,
    waiting
      ? `v${waiting.version} approved ${age(waiting.approvedAt, now)} ago, never activated`
      : undefined,
    !active && !waiting ? `v${latest.version} ${latest.status}` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(", ");
  const finding = (kind: DriftKind, repair: DriftRepair | null, why?: string): DriftFinding => ({
    kind,
    id,
    memory: describe(stored),
    registry,
    repair,
    ...(why === undefined ? {} : { why }),
  });
  const publish = (v: DriftRegistryEntry): DriftRepair =>
    v.status === "waiting"
      ? { kind: "publish", version: v.version, activates: true }
      : { kind: "publish", version: v.version };
  const waitingFinding = (why?: string) =>
    waiting ? [finding("waiting", publish(waiting), why)] : [];

  /** Memory holds a wrong copy at version `held`: the job that replaces it, or none. */
  const fix = (kind: DriftKind, held: number, why: string | undefined, none: string) => {
    if (active && active.version > held) {
      return [finding(kind, publish(active), why), ...waitingFinding()];
    }
    if (waiting && waiting.version > held) return [finding(kind, publish(waiting), why)];
    if (!active && !waiting && latest.status === "withdrawn" && latest.version >= held) {
      return [finding(kind, { kind: "withdraw", version: latest.version }, why)];
    }
    return [finding(kind, null, none)];
  };

  if (stored.status !== "valid") {
    // Absent, unreadable or marked: recall never offers these. Drift when something should be there.
    if (active) return [finding("missing", publish(active)), ...waitingFinding()];
    return waitingFinding();
  }

  const version = stored.record.version;
  const held = sorted.find((v) => v.version === version);
  if (held === undefined) {
    const why = `the registry never approved v${version}`;
    return fix("stale", version, why, `${why}, and publish refuses to go below it`);
  }
  if (held.digest !== stored.digest) {
    const why = `its content differs from the approved v${version}`;
    return fix("stale", version, why, `${why}, and publish refuses to overwrite a version`);
  }
  if (held === waiting) return waitingFinding("memory already holds it; publishing records it");
  if (held === active) return waitingFinding();
  // An approved version that is no longer active: superseded or withdrawn.
  const withdrawn = held.status === "withdrawn" || (!active && latest.status === "withdrawn");
  const gap =
    withdrawn && waiting && !active
      ? `a withdraw job does nothing once v${waiting.version} is approved; its publish replaces the copy`
      : undefined;
  return fix(withdrawn ? "unmarked_withdrawal" : "stale", version, gap, "no newer version");
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
