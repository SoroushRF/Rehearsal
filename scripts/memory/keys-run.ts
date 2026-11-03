import { z } from "zod";

/**
 * The key commands behind `pnpm memory:keys` (#365, T1.55), on the admin API: `POST /keys` mints
 * a named key with grants and returns it once, `GET /keys` lists the live keys by name (never the
 * key; a revoked key is gone), `DELETE /keys/{name}` revokes one.
 *
 * Rotation tells generations apart by name. Generation 1 is what `mint` makes,
 * `rehearsal-api-<label>` and `rehearsal-planner-<label>`; each `rotate` adds the next one,
 * `rehearsal-api-<label>-g<N>` and `rehearsal-planner-<label>-g<N>`. A label may not itself end
 * in `-g<digits>`, so no two labels' names can collide from now on; keys minted before T1.55
 * could, which `ambiguousGenerations` looks for.
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

/**
 * A refusal because going on could cut off a deployed service, or touch keys that may not be
 * this label's (exit 3, like an error: the keys are not as the runbook expects). `--force`
 * overrides only the revoke-old check.
 */
export class KeyCommandUnsafe extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyCommandUnsafe";
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

/** The label's live generations, oldest first, from a listing. */
export function generationsOf(keys: readonly ListedKey[], label: string): Generation[] {
  const byGeneration = new Map<number, Generation>();
  for (const key of keys) {
    const parsed = parseKeyName(key.name, label);
    if (parsed === null) continue;
    const g = byGeneration.get(parsed.generation) ?? { generation: parsed.generation };
    g[parsed.role] = key;
    byGeneration.set(parsed.generation, g);
  }
  return [...byGeneration.values()].sort((a, b) => a.generation - b.generation);
}

/** The label's live generations, oldest first. */
export async function generations(admin: Admin, label: string): Promise<Generation[]> {
  return generationsOf(await listKeys(admin), label);
}

const time = (at: string | null | undefined) => (at ? Date.parse(at) : Number.NaN);
const keysOf = (g: Generation) => [g.api, g.planner].filter((k): k is ListedKey => k !== undefined);

/**
 * Keys that may belong to another label. Before T1.55, `mint` took any label of [a-z0-9-], so
 * `mint prod-g2` made `rehearsal-api-prod-g2`: by name, exactly generation 2 of `prod`. Names
 * can't tell the two apart, and rotate, revoke and --revoke-old would treat such a key as
 * `prod`'s, and could revoke a pair another deployment runs on. What rotation can't produce
 * gives one away: generations are minted one after another, so the live ones are contiguous
 * (--revoke-old removes only the oldest), and each was created after the one before. Any other
 * shape is refused, naming the keys. A legacy pair that looks exactly like the next rotation
 * can't be told apart; `status <label>` lists each key with its dates to check by eye.
 */
export function ambiguousGenerations(live: readonly Generation[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1] as Generation;
    const g = live[i] as Generation;
    const names = keysOf(g)
      .map((k) => k.name)
      .join(" and ");
    if (g.generation !== prev.generation + 1) {
      problems.push(
        `${names}: generation ${g.generation} after ${prev.generation}, which rotation never leaves (minted for another label before T1.55?)`,
      );
      continue;
    }
    const earliest = Math.min(...keysOf(g).map((k) => time(k.createdAt)));
    const latestBefore = Math.max(...keysOf(prev).map((k) => time(k.createdAt)));
    if (Number.isFinite(earliest) && Number.isFinite(latestBefore) && earliest < latestBefore) {
      problems.push(
        `${names}: generation ${g.generation} was created before generation ${prev.generation}, which rotation never does (minted for another label before T1.55?)`,
      );
    }
  }
  return problems;
}

/** Refuses (exit 3) when the label's live keys may include another label's (see above). */
export function refuseAmbiguous(live: readonly Generation[], label: string): void {
  const problems = ambiguousGenerations(live);
  if (problems.length > 0) {
    throw new KeyCommandUnsafe(
      `refused, nothing changed: some keys that look like ${label}'s may be another label's:\n  ${problems.join("\n  ")}\nCheck with pnpm memory:keys status ${label}; revoke a stray key by name in Studio.`,
    );
  }
}

/** Mints one key with exactly `grants` and returns it. */
export async function mintKey(admin: Admin, name: string, grants: unknown): Promise<string> {
  const res = await admin("POST", "/keys", { name, grants });
  if (res.status !== 201)
    throw new Error(`POST /keys ${name} → ${res.status} ${await detail(res)}`);
  return z.object({ key: z.string().min(1) }).parse(await res.json()).key;
}

/**
 * Revokes each key by name and says how each went. Returns the names actually revoked; a name
 * missing from the result failed, and the commands then exit 3.
 */
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

/**
 * Mints one generation's pair. If the second mint fails, the first key is revoked again, and the
 * log says whether that worked; if it didn't, the operator is told to run `revoke <label>`.
 */
export async function mintPair(
  admin: Admin,
  label: string,
  generation: number,
  grants: Grants,
  log: (line: string) => void = () => {},
): Promise<{ names: Record<KeyRole, string>; api: string; planner: string }> {
  const names = keyNames(label, generation);
  const api = await mintKey(admin, names.api, grants.api);
  try {
    const planner = await mintKey(admin, names.planner, grants.planner);
    return { names, api, planner };
  } catch (err) {
    // A key nobody was shown is no use: take it back so the generation isn't half there.
    log(`${names.planner} could not be minted; revoking ${names.api} again:`);
    let revoked: string[] = [];
    try {
      revoked = await revokeKeys(admin, [names.api], log);
    } catch (cleanup) {
      log(`${names.api}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
    }
    if (revoked.length === 0) {
      log(
        `${names.api} is still live (never shown to anyone): run pnpm memory:keys revoke ${label} once the service answers`,
      );
    }
    throw err;
  }
}

/**
 * `mint <label>`: refused when the label has any live generation, so a mint after rotations
 * can't put a second generation 1 beside the deployed pair.
 */
export async function refuseExisting(admin: Admin, label: string): Promise<void> {
  const live = await generations(admin, label);
  if (live.length > 0) {
    throw new KeyCommandRefused(
      `${label} already has keys (generation ${live.map((g) => g.generation).join(", ")}): rotate them with pnpm memory:keys rotate ${label}`,
    );
  }
}

/**
 * `rotate <label>`: mints the next generation with the same grants as the last, and leaves every
 * older key working, so the deployed services keep running until they have the new pair. Refused
 * when the label has no keys yet (mint them instead).
 */
export async function rotate(
  admin: Admin,
  label: string,
  grants: Grants,
  log: (line: string) => void = () => {},
) {
  const live = await generations(admin, label);
  refuseAmbiguous(live, label);
  const newest = live.at(-1);
  if (newest === undefined) {
    throw new KeyCommandRefused(
      `no keys for ${label}: mint the first pair with pnpm memory:keys mint ${label}`,
    );
  }
  const generation = newest.generation + 1;
  return {
    generation,
    previous: live,
    ...(await mintPair(admin, label, generation, grants, log)),
  };
}

/**
 * Whether revoking `old` could cut off a deployed service, from what `GET /keys` says about use.
 * Each kept key must have been used: until then nothing shows a service runs on it. And no old
 * key may have been used after the kept key of the same role was last used: then something still
 * runs on the old one. An old key used after the new pair was minted is expected (the services
 * run on it until their deploy finishes), so only use after the new key's last use counts.
 */
export function revokeOldCheck(
  kept: Generation,
  old: readonly Generation[],
): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  for (const role of ["api", "planner"] as const) {
    const k = kept[role];
    if (!k) continue;
    lines.push(`kept ${k.name}: created ${k.createdAt ?? "?"}, ${lastUsed(k)}`);
    if (!k.lastUsedAt) {
      problems.push(`${k.name} has never been used: no service shows it runs on the new key yet`);
    }
    for (const g of old) {
      const o = g[role];
      if (!o) continue;
      lines.push(`old  ${o.name}: created ${o.createdAt ?? "?"}, ${lastUsed(o)}`);
      if (o.lastUsedAt && k.lastUsedAt && time(o.lastUsedAt) > time(k.lastUsedAt)) {
        problems.push(
          `${o.name} was used at ${o.lastUsedAt}, after ${k.name} was last used: something still runs on it`,
        );
      }
    }
  }
  return { lines, problems };
}

/** The pair --revoke-old keeps (the newest complete one) and the generations it would revoke. */
export function revokeOldPlan(live: readonly Generation[]) {
  const kept = live.filter((g) => g.api && g.planner).at(-1);
  if (kept === undefined) return null;
  return {
    kept,
    old: live.filter((g) => g.generation < kept.generation),
    newer: live.filter((g) => g.generation > kept.generation),
  };
}

/**
 * `rotate <label> --revoke-old`: revokes every generation older than the newest complete pair,
 * and never that pair or anything newer. Refused when there is no older generation: the newest
 * pair is never revoked this way. Before revoking anything it prints `revokeOldCheck` and, unless
 * `force`, refuses (exit 3) when the check finds a problem. Returns what it kept and revoked, and
 * the names it failed to revoke.
 */
export async function revokeOld(
  admin: Admin,
  label: string,
  log: (line: string) => void,
  options: { force?: boolean } = {},
) {
  const live = await generations(admin, label);
  refuseAmbiguous(live, label);
  const plan = revokeOldPlan(live);
  if (plan === null) {
    throw new KeyCommandRefused(
      `no complete pair for ${label}: nothing to keep, so nothing is revoked`,
    );
  }
  const { kept, old, newer } = plan;
  if (old.length === 0) {
    throw new KeyCommandRefused(
      `generation ${kept.generation} is the only one for ${label}: run pnpm memory:keys rotate ${label} first; --revoke-old never revokes the newest pair`,
    );
  }
  for (const g of newer) {
    log(`left alone: generation ${g.generation} is incomplete and newer than the kept pair`);
  }
  const check = revokeOldCheck(kept, old);
  log(`Check before revoking, from GET /keys (keeping generation ${kept.generation}):`);
  for (const line of check.lines) log(`  ${line}`);
  for (const p of check.problems) log(`  problem: ${p}`);
  if (check.problems.length > 0 && !options.force) {
    throw new KeyCommandUnsafe(
      `refused, nothing revoked: deploy the new pair and let both services use it (pnpm memory:keys status ${label}), or pass --force to revoke anyway`,
    );
  }
  log(
    check.problems.length > 0
      ? "  --force: revoking anyway"
      : "  ok: both kept keys are in use, and no old key was used after them",
  );
  const names = old.flatMap((g) => keysOf(g).map((k) => k.name));
  const revoked = await revokeKeys(admin, names, log);
  return { kept, revoked, failed: names.filter((n) => !revoked.includes(n)) };
}

/** Last use as the service reports it, for the operator to check the new pair is live. */
export function lastUsed(key: ListedKey | undefined): string {
  return key?.lastUsedAt ? `last used ${key.lastUsedAt}` : "never used";
}
