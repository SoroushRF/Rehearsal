import { z } from "zod";

/**
 * The key commands behind `pnpm memory:keys` (#365, T1.55), on the admin API: `POST /keys` mints
 * a named key with grants and returns it once, `GET /keys` lists the live keys by name (never the
 * key; a revoked key is gone), `DELETE /keys/{name}` revokes one.
 *
 * Rotation tells generations apart by name. Generation 1 is what `mint` makes,
 * `rehearsal-api-<label>` and `rehearsal-planner-<label>`; each `rotate` adds the next one,
 * `rehearsal-api-<label>-g<N>` and `rehearsal-planner-<label>-g<N>`. A label may not itself end
 * in `-g<digits>`, so no two labels' names can collide.
 */

/** One admin call: the CLI's sends the operator's admin key; tests pass the fake's. */
export type Admin = (method: string, path: string, body?: unknown) => Promise<Response>;

export function adminFor(config: {
  url: string;
  context: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Admin {
  const base = `${config.url.replace(/\/+$/, "")}/api/v1/${encodeURIComponent(config.context)}`;
  return (method, path, body) =>
    (config.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
}

/** A refusal the operator can act on (exit 1), as opposed to a service error (exit 3). */
export class KeyCommandRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyCommandRefused";
  }
}

/** Lowercase, digits and dashes, and not ending in a generation suffix. */
export function validLabel(label: string): boolean {
  return /^[a-z0-9-]+$/.test(label) && !/-g\d+$/.test(label);
}

export type KeyRole = "api" | "planner";

export function keyNames(label: string, generation = 1): Record<KeyRole, string> {
  const suffix = generation === 1 ? "" : `-g${generation}`;
  return {
    api: `rehearsal-api-${label}${suffix}`,
    planner: `rehearsal-planner-${label}${suffix}`,
  };
}

/** Which role and generation `name` is for `label`, or null if it isn't one of its keys. */
export function parseKeyName(
  name: string,
  label: string,
): { role: KeyRole; generation: number } | null {
  // Labels hold only [a-z0-9-], so they need no escaping here.
  const m = name.match(new RegExp(`^rehearsal-(api|planner)-${label}(?:-g([1-9][0-9]*))?$`));
  if (!m) return null;
  const generation = m[2] === undefined ? 1 : Number(m[2]);
  // `-g1` is never minted: generation 1 has no suffix.
  if (generation === 1 && m[2] !== undefined) return null;
  return { role: m[1] as KeyRole, generation };
}

/** What the service lists about a key. The key itself is never listed. */
const ListedKey = z.object({
  name: z.string(),
  createdAt: z.string().optional(),
  lastUsedAt: z.string().nullish(),
});
export type ListedKey = z.infer<typeof ListedKey>;
const KeyPage = z.object({
  keys: z.array(ListedKey),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().optional() }).optional(),
});

/** The response body, trimmed: never the request, which carries no secret but the header. */
async function detail(res: Response): Promise<string> {
  return (await res.text()).slice(0, 300);
}

export async function listKeys(admin: Admin): Promise<ListedKey[]> {
  const all: ListedKey[] = [];
  let cursor: string | undefined;
  do {
    const res = await admin(
      "GET",
      `/keys${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    );
    if (!res.ok) throw new Error(`GET /keys → ${res.status} ${await detail(res)}`);
    const page = KeyPage.parse(await res.json());
    all.push(...page.keys);
    if (page.page?.hasMore && page.page.nextCursor === undefined) {
      throw new Error("GET /keys: more pages but no cursor");
    }
    cursor = page.page?.hasMore ? page.page.nextCursor : undefined;
  } while (cursor !== undefined);
  return all;
}

export interface Generation {
  generation: number;
  api?: ListedKey;
  planner?: ListedKey;
}

/** The label's live generations, oldest first. */
export async function generations(admin: Admin, label: string): Promise<Generation[]> {
  const byGeneration = new Map<number, Generation>();
  for (const key of await listKeys(admin)) {
    const parsed = parseKeyName(key.name, label);
    if (parsed === null) continue;
    const g = byGeneration.get(parsed.generation) ?? { generation: parsed.generation };
    g[parsed.role] = key;
    byGeneration.set(parsed.generation, g);
  }
  return [...byGeneration.values()].sort((a, b) => a.generation - b.generation);
}

/** Mints one key with exactly `grants` and returns it. */
export async function mintKey(admin: Admin, name: string, grants: unknown): Promise<string> {
  const res = await admin("POST", "/keys", { name, grants });
  if (res.status !== 201)
    throw new Error(`POST /keys ${name} → ${res.status} ${await detail(res)}`);
  return z.object({ key: z.string().min(1) }).parse(await res.json()).key;
}

/** Revokes each key by name and says how each went. Returns the names actually revoked. */
export async function revokeKeys(
  admin: Admin,
  names: readonly string[],
  log: (line: string) => void,
): Promise<string[]> {
  const revoked: string[] = [];
  for (const name of names) {
    const res = await admin("DELETE", `/keys/${encodeURIComponent(name)}`);
    if (res.status === 204) revoked.push(name);
    log(`${name}: ${res.status === 204 ? "revoked" : `${res.status} ${await detail(res)}`}`);
  }
  return revoked;
}

export interface Grants {
  api: unknown;
  planner: unknown;
}

/** Mints one generation's pair. If the second mint fails, the first key is revoked again. */
export async function mintPair(
  admin: Admin,
  label: string,
  generation: number,
  grants: Grants,
): Promise<{ names: Record<KeyRole, string>; api: string; planner: string }> {
  const names = keyNames(label, generation);
  const api = await mintKey(admin, names.api, grants.api);
  try {
    const planner = await mintKey(admin, names.planner, grants.planner);
    return { names, api, planner };
  } catch (err) {
    // A key nobody was shown is no use: take it back so the generation isn't half there.
    await revokeKeys(admin, [names.api], () => {});
    throw err;
  }
}

/**
 * `rotate <label>`: mints the next generation with the same grants as the last, and leaves every
 * older key working, so the deployed services keep running until they have the new pair. Refused
 * when the label has no keys yet (mint them instead).
 */
export async function rotate(admin: Admin, label: string, grants: Grants) {
  const live = await generations(admin, label);
  const newest = live.at(-1);
  if (newest === undefined) {
    throw new KeyCommandRefused(
      `no keys for ${label}: mint the first pair with pnpm memory:keys mint ${label}`,
    );
  }
  const generation = newest.generation + 1;
  return { generation, previous: live, ...(await mintPair(admin, label, generation, grants)) };
}

/**
 * `rotate <label> --revoke-old`: revokes every generation older than the newest complete pair,
 * and never that pair or anything newer. Refused when there is no older generation: the newest
 * pair is never revoked this way. Returns what it revoked and the pair it kept.
 */
export async function revokeOld(admin: Admin, label: string, log: (line: string) => void) {
  const live = await generations(admin, label);
  const kept = live.filter((g) => g.api && g.planner).at(-1);
  if (kept === undefined) {
    throw new KeyCommandRefused(
      `no complete pair for ${label}: nothing to keep, so nothing is revoked`,
    );
  }
  const old = live.filter((g) => g.generation < kept.generation);
  if (old.length === 0) {
    throw new KeyCommandRefused(
      `generation ${kept.generation} is the only one for ${label}: run pnpm memory:keys rotate ${label} first; --revoke-old never revokes the newest pair`,
    );
  }
  for (const g of live.filter((g) => g.generation > kept.generation)) {
    log(`left alone: generation ${g.generation} is incomplete and newer than the kept pair`);
  }
  const names = old.flatMap((g) =>
    [g.api, g.planner].filter((k): k is ListedKey => k !== undefined).map((k) => k.name),
  );
  const revoked = await revokeKeys(admin, names, log);
  return { kept, revoked };
}

/** Last use as the service reports it, for the operator to check the new pair is live. */
export function lastUsed(key: ListedKey | undefined): string {
  return key?.lastUsedAt ? `last used ${key.lastUsedAt}` : "never used";
}
