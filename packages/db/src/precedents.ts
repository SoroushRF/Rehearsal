import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "./index";
import { precedentEvents } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export type PrecedentEventRow = typeof precedentEvents.$inferSelect;
export type PrecedentStatus = "waiting" | "active" | "superseded" | "withdrawn";

export interface RegistryEntry {
  id: string;
  version: number;
  appliesTo: string;
  digest: string;
  status: PrecedentStatus;
  /** The approved record as promoted, verbatim. */
  record: unknown;
  actorUserId: string | null;
  sourceRunId: string | null;
  approvedAt: string;
}

/** The shape `checkPrecedentBasis` reads (`RegistrySnapshot` in `@rehearsal/memory`). */
export interface RegistrySnapshot {
  /** The active approved version of each precedent. A withdrawn or not-yet-synced one is absent. */
  active: Map<string, { version: number; digest: string }>;
  /** Activations plus withdrawals so far, per area. An area with no history is at 0. */
  epochs: Map<string, number>;
}

export interface RegistryView {
  snapshot: RegistrySnapshot;
  entries: RegistryEntry[];
}

/**
 * Reads the registry off its events (decision 0012). A precedent is active at the version of its
 * newest activation unless it was withdrawn since; an older version can never become active again
 * once a newer one has, so a retried sync of a superseded version changes nothing. An area's epoch
 * counts the activations and withdrawals that took effect, so any change to what is active in the
 * area moves it. Pure: pass the org's events in any order.
 */
export function deriveRegistry(events: readonly PrecedentEventRow[]): RegistryView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const active = new Map<string, { version: number; digest: string }>();
  const epochs = new Map<string, number>();
  const highest = new Map<string, number>();
  const activated = new Set<string>();
  const withdrawn = new Set<string>();
  const approved = new Map<string, PrecedentEventRow>();
  const key = (id: string, version: number) => `${id}@${version}`;
  const bump = (area: string) => epochs.set(area, (epochs.get(area) ?? 0) + 1);

  for (const e of ordered) {
    const k = key(e.precedentId, e.version);
    if (e.kind === "approved") {
      if (!approved.has(k)) approved.set(k, e);
    } else if (e.kind === "activated") {
      if (!approved.has(k) || e.version <= (highest.get(e.precedentId) ?? 0)) continue;
      highest.set(e.precedentId, e.version);
      activated.add(k);
      active.set(e.precedentId, { version: e.version, digest: e.digest });
      bump(e.appliesTo);
    } else if (active.get(e.precedentId)?.version === e.version) {
      active.delete(e.precedentId);
      withdrawn.add(k);
      bump(e.appliesTo);
    }
  }

  const entries = [...approved.values()].map((e): RegistryEntry => {
    const k = key(e.precedentId, e.version);
    const status: PrecedentStatus =
      active.get(e.precedentId)?.version === e.version
        ? "active"
        : withdrawn.has(k)
          ? "withdrawn"
          : activated.has(k) || (highest.get(e.precedentId) ?? 0) > e.version
            ? "superseded"
            : "waiting";
    return {
      id: e.precedentId,
      version: e.version,
      appliesTo: e.appliesTo,
      digest: e.digest,
      status,
      record: e.record,
      actorUserId: e.actorUserId,
      sourceRunId: e.sourceRunId,
      approvedAt: e.at.toISOString(),
    };
  });
  return { snapshot: { active, epochs }, entries };
}

export async function loadRegistry(db: Exec, orgId: string): Promise<RegistryView> {
  const rows = await db
    .select()
    .from(precedentEvents)
    .where(eq(precedentEvents.orgId, orgId))
    .orderBy(asc(precedentEvents.seq));
  return deriveRegistry(rows);
}

/** The newest approved version of a precedent and the area it belongs to, or null if none. */
export async function latestApproved(db: Exec, orgId: string, precedentId: string) {
  const [row] = await db
    .select({ version: precedentEvents.version, appliesTo: precedentEvents.appliesTo })
    .from(precedentEvents)
    .where(
      and(
        eq(precedentEvents.orgId, orgId),
        eq(precedentEvents.precedentId, precedentId),
        eq(precedentEvents.kind, "approved"),
      ),
    )
    .orderBy(desc(precedentEvents.version))
    .limit(1);
  return row ?? null;
}

/** Appends an `approved` event. False if this exact version was already approved. */
export async function approvePrecedent(
  db: Exec,
  input: {
    orgId: string;
    precedentId: string;
    version: number;
    appliesTo: string;
    digest: string;
    record: unknown;
    actorUserId: string;
    sourceRunId: string;
  },
): Promise<boolean> {
  const rows = await db
    .insert(precedentEvents)
    .values({ ...input, kind: "approved" })
    .onConflictDoNothing()
    .returning({ seq: precedentEvents.seq });
  return rows.length > 0;
}

/** The record, digest and area approved for one version, for the sync job to publish. */
export async function approvedVersion(
  db: Exec,
  orgId: string,
  precedentId: string,
  version: number,
) {
  const [row] = await db
    .select({
      record: precedentEvents.record,
      digest: precedentEvents.digest,
      appliesTo: precedentEvents.appliesTo,
    })
    .from(precedentEvents)
    .where(
      and(
        eq(precedentEvents.orgId, orgId),
        eq(precedentEvents.precedentId, precedentId),
        eq(precedentEvents.version, version),
        eq(precedentEvents.kind, "approved"),
      ),
    );
  return row ?? null;
}

/**
 * Appends `activated` or `withdrawn` for an approved version. False if there is no such approved
 * version or the event already exists, so a retried job is harmless.
 */
export async function recordPrecedentEvent(
  db: Exec,
  input: {
    orgId: string;
    precedentId: string;
    version: number;
    kind: "activated" | "withdrawn";
    actorUserId?: string;
  },
): Promise<boolean> {
  const approved = await approvedVersion(db, input.orgId, input.precedentId, input.version);
  if (!approved) return false;
  const rows = await db
    .insert(precedentEvents)
    .values({
      orgId: input.orgId,
      precedentId: input.precedentId,
      version: input.version,
      appliesTo: approved.appliesTo,
      kind: input.kind,
      digest: approved.digest,
      actorUserId: input.actorUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ seq: precedentEvents.seq });
  return rows.length > 0;
}
