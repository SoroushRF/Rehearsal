import { type AgentMemoryClient, precedentScope } from "@rehearsal/memory";
import { z } from "zod";
import type { Admin } from "./keys-run";

/**
 * The erasure behind `pnpm memory:erase-org <org>` (T1.55, #398). An operator action, never app
 * code. `/scopes/forget` erases permanently and ignores `dryRun`, so this lists first with reads
 * only, then needs the org ID typed back, then records `erased` in Postgres (through `record`)
 * before it forgets anything: a crash after that leaves the org refused, not half erased and
 * still served. Then it forgets the org's scope, tombstones it so nothing can write there again,
 * records `forgotten`, and reads again to show what is left.
 */

/** What one entity holds in exactly the org's scope. */
export interface ErasedEntity {
  name: string;
  /** Live attributes. */
  live: number;
  /** Every attribute in its history, superseded ones included. */
  history: number;
}

export interface EraseListing {
  orgId: string;
  scope: string;
  /** Whether the scope is registered; tombstoned once erased. Null if the service didn't say. */
  registered: "registered" | "tombstoned" | "absent" | null;
  entities: ErasedEntity[];
  /** Precedent IDs the registry in Postgres knows for the org. */
  registryIds: string[];
}

const ScopeList = z.object({
  scopes: z.array(z.object({ path: z.string(), tombstonedAt: z.string().nullish() })),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().optional() }).optional(),
});
const Forgotten = z.object({ forgotten: z.number() });

const strip = (p: string) => p.replace(/\/+$/, "");
const inScope = (scope: string) => (a: { scope: string[][] }) =>
  a.scope.some((conj) => conj.some((p) => strip(p) === scope));

async function scopeState(admin: Admin, scope: string): Promise<EraseListing["registered"]> {
  let cursor: string | undefined;
  do {
    const res = await admin(
      "GET",
      `/scopes${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    );
    if (!res.ok) return null;
    const page = ScopeList.safeParse(await res.json());
    if (!page.success) return null;
    const found = page.data.scopes.find((s) => strip(s.path) === scope);
    if (found) return found.tombstonedAt ? "tombstoned" : "registered";
    cursor = page.data.page?.hasMore ? page.data.page.nextCursor : undefined;
  } while (cursor !== undefined);
  return "absent";
}

/**
 * The dry run: reads only (`GET /scopes`, recall queries through the scope's lens, entity and
 * history reads). Memory has no listing of entities, so it looks at every precedent the registry
 * knows for the org, plus whatever recall finds in the scope for each of its areas and for
 * `precedent`, at the service's cap of 50 hits.
 */
export async function listOrgMemory(input: {
  admin: Admin;
  client: AgentMemoryClient;
  baseScope: string;
  orgId: string;
  registry: readonly { id: string; appliesTo: string }[];
  /** Entities to read as well: the dry run's, in the check after forget. */
  also?: readonly string[];
}): Promise<EraseListing> {
  const scope = precedentScope(input.baseScope, input.orgId);
  const names = new Set([...input.registry.map((e) => `precedent:${e.id}`), ...(input.also ?? [])]);
  const probes = new Set([...input.registry.map((e) => e.appliesTo), "precedent"]);
  for (const query of probes) {
    const result = await input.client.query({ query, k: 50, lens: [[scope]] });
    for (const hit of result.hits) {
      if (hit.resource?.entityType === "concept" && hit.resource.name) names.add(hit.resource.name);
    }
  }
  const entities: ErasedEntity[] = [];
  for (const name of [...names].sort()) {
    const view = await input.client.entity("concept", name);
    const history = await input.client.history("concept", name);
    const live = (view?.attributes ?? []).filter(inScope(scope)).length;
    const all = history.filter(inScope(scope)).length;
    if (live + all > 0) entities.push({ name, live, history: all });
  }
  return {
    orgId: input.orgId,
    scope,
    registered: await scopeState(input.admin, scope),
    entities,
    registryIds: [...new Set(input.registry.map((e) => e.id))].sort(),
  };
}

export function formatListing(listing: EraseListing): string[] {
  const live = listing.entities.reduce((n, e) => n + e.live, 0);
  const history = listing.entities.reduce((n, e) => n + e.history, 0);
  return [
    `${listing.orgId}: scope ${listing.scope} (${listing.registered ?? "state unknown"})`,
    `  ${listing.entities.length} entities, ${live} live attributes, ${history} in history`,
    ...listing.entities.map((e) => `  ${e.name}: ${e.live} live, ${e.history} in history`),
    `  registry (Postgres, not touched): ${listing.registryIds.length} precedents`,
  ];
}

/** The typed confirmation: exactly the org ID, with nothing but surrounding whitespace. */
export function confirmationMatches(answer: string | null, orgId: string): boolean {
  return answer !== null && answer.trim() === orgId;
}

/**
 * Where the command is about to act, shown in the dry run: the database the events go to and the
 * Agent Memory service and context it forgets in. Never a password or a key.
 */
export interface EraseTargets {
  database: string;
  memoryUrl: string;
  context: string;
}

/** `postgres://user:secret@host:5432/db` as `host:5432/db`, without user or password. */
export function databaseTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(DATABASE_URL is not a URL)";
  }
}

/**
 * What doesn't add up between the registry in Postgres and the scope in Agent Memory, which most
 * likely means the command points at the wrong database, context, base scope or org. Each one
 * refuses the erasure (exit 3) unless `--force`:
 * - the registry is empty but memory holds entities, or the registry has precedents and memory
 *   none (not counted on a rerun, after which memory is expected to be empty);
 * - the scope isn't registered (absent, or the service didn't say), unless it is tombstoned on a
 *   rerun; tombstoned with no `erased` event in this database is a mismatch too.
 */
export function eraseMismatches(listing: EraseListing, alreadyErased: boolean): string[] {
  const problems: string[] = [];
  const held = listing.entities.length;
  const known = listing.registryIds.length;
  if (known === 0 && held > 0) {
    problems.push(
      `the registry in this database has no precedents for ${listing.orgId}, but memory holds ${held} entities in its scope`,
    );
  }
  if (known > 0 && held === 0 && !alreadyErased) {
    problems.push(
      `the registry has ${known} precedents for ${listing.orgId}, but memory holds nothing in its scope`,
    );
  }
  if (listing.registered === "tombstoned" && !alreadyErased) {
    problems.push(
      `the scope is tombstoned, but this database has no erased event for ${listing.orgId}`,
    );
  } else if (listing.registered !== "registered" && listing.registered !== "tombstoned") {
    problems.push(`the scope is ${listing.registered ?? "in an unknown state"}, not registered`);
  }
  return problems;
}

/** The erasure refused before anything was recorded or erased (exit 3). */
export class EraseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraseRefused";
  }
}

export type EraseEventKind = "erased" | "forgotten";

export interface EraseOrgRun {
  admin: Admin;
  client: AgentMemoryClient;
  baseScope: string;
  orgId: string;
  registry: readonly { id: string; appliesTo: string }[];
  /** Whether an `erased` event already exists: then this run finishes an earlier one. */
  alreadyErased: boolean;
  /** Shown first, so the operator sees where the command acts. */
  targets?: EraseTargets;
  /** Go on despite `eraseMismatches`. */
  force?: boolean;
  /** Shown the dry run; true only if the operator typed the org ID (or passed `--yes <org>`). */
  confirm: (listing: EraseListing) => Promise<boolean>;
  /** Appends the event in Postgres. `erased` must commit before this returns. */
  record: (kind: EraseEventKind, scope: string, summary: unknown) => Promise<void>;
  log: (line: string) => void;
}

export type EraseOutcome =
  | { outcome: "aborted"; listing: EraseListing }
  | { outcome: "erased"; listing: EraseListing; forgotten: number; after: EraseListing };

export async function eraseOrg(run: EraseOrgRun): Promise<EraseOutcome> {
  const listing = await listOrgMemory(run);
  run.log("Dry run (reads only; nothing has been changed):");
  if (run.targets) {
    run.log(`  database:     ${run.targets.database}`);
    run.log(`  Agent Memory: ${run.targets.memoryUrl}, context ${run.targets.context}`);
    run.log(`  base scope:   ${run.baseScope}`);
  }
  for (const line of formatListing(listing)) run.log(line);
  if (run.alreadyErased) {
    run.log("  already recorded as erased: this run finishes the earlier one");
  }
  const mismatches = eraseMismatches(listing, run.alreadyErased);
  for (const m of mismatches) run.log(`  mismatch: ${m}`);
  if (mismatches.length > 0 && !run.force) {
    throw new EraseRefused(
      "refused: Postgres and Agent Memory disagree about this org, so a target may be wrong. Nothing was recorded or erased. Check the targets above, or pass --force to erase anyway",
    );
  }
  if (mismatches.length > 0) run.log("  --force: going on anyway");
  if (!(await run.confirm(listing))) {
    run.log("aborted: the confirmation didn't match; nothing was erased or recorded");
    return { outcome: "aborted", listing };
  }

  // Recorded first: from here the API, the planner's jobs, the hint and drift refuse the org.
  await run.record("erased", listing.scope, {
    entities: listing.entities,
    registered: listing.registered,
    registryIds: listing.registryIds,
  });
  run.log(`recorded erased for ${run.orgId}; syncs, recall, the hint and drift now refuse it`);

  // Already tombstoned (a rerun): forget runs before the tombstone, so it already ran, and nothing
  // can have been written since. Forget again only if something still reads as live.
  const tombstoned = listing.registered === "tombstoned";
  const forgetAgain = !tombstoned || listing.entities.some((e) => e.live > 0);
  let forgotten = 0;
  if (forgetAgain) {
    const res = await run.admin("POST", "/scopes/forget", { path: listing.scope });
    if (!res.ok) {
      throw new Error(
        `POST /scopes/forget → ${res.status} ${(await res.text()).slice(0, 300)}; the org stays refused, run again to finish`,
      );
    }
    forgotten = Forgotten.parse(await res.json()).forgotten;
  }
  if (!tombstoned) {
    // Tombstoned, the scope can't be written again, even if something registers it once more.
    const tomb = await run.admin("DELETE", `/scopes?path=${encodeURIComponent(listing.scope)}`);
    if (tomb.status !== 204 && tomb.status !== 404) {
      throw new Error(
        `DELETE /scopes → ${tomb.status} ${(await tomb.text()).slice(0, 300)}; the scope was forgotten but not tombstoned, run again to finish`,
      );
    }
  }
  await run.record("forgotten", listing.scope, {
    forgotten,
    tombstoned: true,
    ...(tombstoned && { alreadyTombstoned: true, forgetSent: forgetAgain }),
  });
  run.log(
    !tombstoned
      ? `forgot ${forgotten} items in ${listing.scope} and tombstoned it`
      : forgetAgain
        ? `${listing.scope} was already tombstoned; forgot ${forgotten} items again`
        : `${listing.scope} was already tombstoned and nothing in it is live; nothing was sent`,
  );

  // Read again the way the dry run did, recall included, so a copy only recall found is checked.
  const after = await listOrgMemory({ ...run, also: listing.entities.map((e) => e.name) });
  for (const line of formatListing(after)) run.log(`after: ${line.trimStart()}`);
  if (after.entities.some((e) => e.live > 0)) {
    throw new Error(`${listing.scope} still has live attributes after forget; run again`);
  }
  return { outcome: "erased", listing, forgotten, after };
}
