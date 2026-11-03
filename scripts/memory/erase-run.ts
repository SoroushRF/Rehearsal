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
  /** Read only these entities (and the registry's), without recall: the check after forget. */
  only?: readonly string[];
}): Promise<EraseListing> {
  const scope = precedentScope(input.baseScope, input.orgId);
  const names = new Set([...input.registry.map((e) => `precedent:${e.id}`), ...(input.only ?? [])]);
  const probes =
    input.only === undefined
      ? new Set([...input.registry.map((e) => e.appliesTo), "precedent"])
      : new Set<string>();
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

export type EraseEventKind = "erased" | "forgotten";

export interface EraseOrgRun {
  admin: Admin;
  client: AgentMemoryClient;
  baseScope: string;
  orgId: string;
  registry: readonly { id: string; appliesTo: string }[];
  /** Whether an `erased` event already exists: then this run finishes an earlier one. */
  alreadyErased: boolean;
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
  for (const line of formatListing(listing)) run.log(line);
  if (run.alreadyErased) {
    run.log("  already recorded as erased: this run forgets the scope again and finishes it");
  }
  if (listing.registryIds.length === 0 && listing.entities.length === 0) {
    run.log("  warning: no registry and nothing in memory for this org; check the org id");
  }
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

  const res = await run.admin("POST", "/scopes/forget", { path: listing.scope });
  if (!res.ok) {
    throw new Error(
      `POST /scopes/forget → ${res.status} ${(await res.text()).slice(0, 300)}; the org stays refused, run again to finish`,
    );
  }
  const { forgotten } = Forgotten.parse(await res.json());
  // Tombstoned, the scope can't be written again, even if something registers it once more.
  const tomb = await run.admin("DELETE", `/scopes?path=${encodeURIComponent(listing.scope)}`);
  if (tomb.status !== 204 && tomb.status !== 404) {
    throw new Error(
      `DELETE /scopes → ${tomb.status} ${(await tomb.text()).slice(0, 300)}; the scope was forgotten but not tombstoned, run again to finish`,
    );
  }
  await run.record("forgotten", listing.scope, { forgotten, tombstoned: true });
  run.log(`forgot ${forgotten} items in ${listing.scope} and tombstoned it`);

  const after = await listOrgMemory({ ...run, only: listing.entities.map((e) => e.name) });
  for (const line of formatListing(after)) run.log(`after: ${line.trimStart()}`);
  if (after.entities.some((e) => e.live > 0)) {
    throw new Error(`${listing.scope} still has live attributes after forget; run again`);
  }
  return { outcome: "erased", listing, forgotten, after };
}
