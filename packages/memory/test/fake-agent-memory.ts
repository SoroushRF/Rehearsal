/**
 * An in-memory Agent Memory with the semantics the hosted service showed in the T1.8 probes:
 * attributes supersede per (entity, key, scope); rewriting the value an attribute holds stores
 * nothing; reads see only the key's read region; writes outside its write region are 403; an
 * unregistered scope is 400; a "/" in an entity name is 404. Recall is word overlap, not vectors.
 *
 * Operator routes as probed on 2026-11-03 (T1.55), for the admin key only: `POST /keys` mints a
 * named key with grants, `GET /keys` lists the live ones by name (a revoked key is gone),
 * `DELETE /keys/{name}` revokes; `POST /scopes/forget` erases everything under a path (a scope
 * never registered forgets 0) and ignores `dryRun`; `DELETE /scopes?path=` tombstones a scope,
 * which stays unwritable even if registered again.
 */

interface Attr {
  id: string;
  entity: { type: string; name: string };
  key: string;
  value: unknown;
  memoryCategory: string;
  scope: string[][];
  supersedes: string | null;
  supersededBy: string | null;
  validUntil: string | null;
  createdAt: string;
}

export interface KeyGrant {
  /** Path prefixes (subtrees) the key may read / write. "" is everything. */
  read: string[];
  write: string[];
  /** May mint, list and revoke keys, and forget or tombstone scopes. */
  admin?: boolean;
}

/** A minted key as `GET /keys` lists it (never the key itself). */
interface NamedKey {
  key: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const strip = (p: string) => p.replace(/\/+$/, "");
const within = (path: string, region: string) =>
  region === "" || path === region || path.startsWith(`${region}/`);

export class FakeAgentMemory {
  readonly keys = new Map<string, KeyGrant>([
    ["sp-test-key", { read: [""], write: [""], admin: true }],
  ]);
  /** Keys minted through `POST /keys`, by name. */
  readonly named = new Map<string, NamedKey>();
  readonly scopes = new Set<string>();
  readonly tombstoned = new Set<string>();
  readonly attrs: Attr[] = [];
  readonly traces = new Map<string, { queryText: string; retrievedIds: string[] }>();
  readonly requests: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  writes = 0;
  /** Set to make every request answer with this status. */
  outage: number | null = null;
  #seq = 0;
  #tick = Date.parse("2026-10-24T09:00:00Z");

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    this.requests.push({ method, path: url.pathname + url.search, body, auth });
    if (this.outage !== null) return json(this.outage, { message: "unavailable" });
    const grant = this.keys.get(auth?.replace(/^Bearer /, "") ?? "");
    if (grant === undefined) return json(401, { message: "invalid api key" });
    const token = auth?.replace(/^Bearer /, "") ?? "";
    for (const k of this.named.values()) if (k.key === token) k.lastUsedAt = this.#keyNow();

    const route = url.pathname.replace(/^\/api\/v1\/ctx/, "");
    const named = route.match(/^\/keys(?:\/([^/]+))?$/);
    if (named || route.startsWith("/scopes/forget") || (method !== "POST" && route === "/scopes")) {
      if (!grant.admin) return json(403, { message: "admin only" });
      if (method === "POST" && route === "/keys") return this.#mintKey(body);
      if (method === "GET" && route === "/keys") return this.#listKeys();
      if (method === "DELETE" && named?.[1]) return this.#revokeKey(decodeURIComponent(named[1]));
      if (method === "POST" && route === "/scopes/forget") return this.#forget(body.path);
      if (method === "DELETE" && route === "/scopes") {
        return this.#tombstone(url.searchParams.get("path") ?? "");
      }
      if (method === "GET" && route === "/scopes") return this.#listScopes();
    }
    if (method === "POST" && route === "/scopes") return this.#registerScope(body.path);
    if (method === "POST" && route === "/facts") return this.#write(grant, body);
    if (method === "POST" && route === "/query") return this.#query(grant, body);
    const trace = route.match(/^\/traces\/([^/]+)$/);
    if (method === "GET" && trace) return this.#trace(decodeURIComponent(trace[1] ?? ""));
    const entity = route.match(/^\/entities\/([^/]+)\/([^/]+)(\/history)?$/);
    if (method === "GET" && entity) {
      const type = decodeURIComponent(entity[1] ?? "");
      const name = decodeURIComponent(entity[2] ?? "");
      if (name.includes("/")) return json(404, { message: "not found" });
      return entity[3] ? this.#history(grant, type, name) : this.#entity(grant, type, name);
    }
    return json(404, { message: `no route ${method} ${route}` });
  };

  /** Overwrite a stored live value in place, as if the copy had been corrupted. */
  tamper(name: string, key: string, value: unknown, scope?: string): void {
    const attr = this.attrs.find(
      (a) =>
        a.entity.name === name &&
        a.key === key &&
        a.supersededBy === null &&
        (scope === undefined || strip(a.scope[0]?.[0] ?? "") === scope),
    );
    if (attr === undefined) throw new Error(`no live ${key} on ${name}`);
    attr.value = value;
  }

  /** Add a live attribute directly, in any scope, bypassing grants. */
  seed(scope: string, name: string, key: string, value: unknown, category = "knowledge"): string {
    return this.#put(strip(scope), { type: "concept", name }, key, value, category);
  }

  #now(): string {
    return new Date(this.#tick).toISOString();
  }

  /** Key creation and use, a second apart each time, so their order shows in `GET /keys`. */
  #keyTick = Date.parse("2026-10-24T08:00:00Z");
  #keyNow(): string {
    this.#keyTick += 1000;
    return new Date(this.#keyTick).toISOString();
  }

  /** Grants as `memoryKeyGrants` spells them: `memory:read` / `memory:write` lists of `<path>/*`. */
  #mintKey(body: { name?: unknown; grants?: Record<string, string[]> }) {
    if (typeof body.name !== "string" || body.name === "") return json(422, "name required");
    if (this.named.has(body.name)) return json(409, { message: "a key with that name exists" });
    const region = (paths: string[] | undefined) =>
      (paths ?? []).map((p) => strip(p.replace(/\/?\*$/, "")).replace(/^\//, ""));
    const key = `sp-minted-${++this.#seq}`;
    this.keys.set(key, {
      read: region(body.grants?.["memory:read"]),
      write: region(body.grants?.["memory:write"]),
    });
    this.named.set(body.name, { key, createdAt: this.#keyNow(), lastUsedAt: null });
    return json(201, { name: body.name, key });
  }

  #listKeys() {
    const keys = [...this.named].map(([name, k], i) => ({
      id: `k${i}`,
      name,
      createdAt: k.createdAt,
      ...(k.lastUsedAt === null ? {} : { lastUsedAt: k.lastUsedAt }),
    }));
    return json(200, { keys, page: { hasMore: false } });
  }

  #revokeKey(name: string) {
    const k = this.named.get(name);
    if (k === undefined) return json(404, { message: "no such key" });
    this.named.delete(name);
    this.keys.delete(k.key);
    return new Response(null, { status: 204 });
  }

  /** Erases every attribute under `path`, superseded ones included. `dryRun` is ignored. */
  #forget(path: string) {
    const region = strip(path ?? "");
    let forgotten = 0;
    for (let i = this.attrs.length - 1; i >= 0; i--) {
      if (within(strip(this.attrs[i]?.scope[0]?.[0] ?? ""), region)) {
        this.attrs.splice(i, 1);
        forgotten++;
      }
    }
    return json(200, { forgotten });
  }

  #tombstone(path: string) {
    this.tombstoned.add(strip(path));
    return new Response(null, { status: 204 });
  }

  #listScopes() {
    const scopes = [...this.scopes].map((p) => ({
      path: `${p}/`,
      createdAt: this.#now(),
      tombstonedAt: this.tombstoned.has(p) ? this.#now() : null,
    }));
    return json(200, { scopes });
  }

  #registerScope(path: string) {
    if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?$/.test(path)) return json(422, "invalid scope path");
    const parts = strip(path).split("/");
    for (let i = 1; i <= parts.length; i++) this.scopes.add(parts.slice(0, i).join("/"));
    return json(201, { path: `${strip(path)}/`, tombstonedAt: null });
  }

  #write(grant: KeyGrant, body: { infer: string; scopes: string[][]; triples: unknown[] }) {
    const scope = strip(body.scopes?.[0]?.[0] ?? "");
    if (body.infer !== "triples") return json(422, { message: "fake only does triples" });
    if (!this.scopes.has(scope) || this.tombstoned.has(scope)) {
      return json(400, { message: "unknown scope node — register it first" });
    }
    if (!grant.write.some((r) => within(scope, r))) {
      return json(403, {
        message: `write scope \`${scope}/\` is outside the caller's write region`,
      });
    }
    this.writes++;
    const attributes = [];
    for (const t of body.triples as { entity: Attr["entity"]; key: string; value: unknown }[]) {
      const live = this.attrs.find(
        (a) =>
          a.entity.type === t.entity.type &&
          a.entity.name === t.entity.name &&
          a.key === t.key &&
          a.supersededBy === null &&
          strip(a.scope[0]?.[0] ?? "") === scope,
      );
      if (live !== undefined && live.value === t.value) continue;
      const id = this.#put(scope, t.entity, t.key, t.value, "knowledge", live);
      attributes.push({ id, key: t.key, value: t.value });
    }
    return json(200, { mode: "triples", extraction: { attributes, corrections: [] } });
  }

  #put(
    scope: string,
    entity: Attr["entity"],
    key: string,
    value: unknown,
    memoryCategory: string,
    previous?: Attr,
  ): string {
    const id = `a${++this.#seq}`;
    this.#tick += 1000;
    const createdAt = new Date(this.#tick).toISOString();
    if (previous !== undefined) {
      previous.supersededBy = id;
      previous.validUntil = createdAt;
    }
    this.attrs.push({
      id,
      entity,
      key,
      value,
      memoryCategory,
      scope: [[`${scope}/`]],
      supersedes: previous?.id ?? null,
      supersededBy: null,
      validUntil: null,
      createdAt,
    });
    return id;
  }

  #readable(grant: KeyGrant, a: Attr) {
    return grant.read.some((r) => within(strip(a.scope[0]?.[0] ?? ""), r));
  }

  #entity(grant: KeyGrant, type: string, name: string) {
    const attributes = this.attrs
      .filter(
        (a) =>
          a.entity.type === type &&
          a.entity.name === name &&
          a.supersededBy === null &&
          this.#readable(grant, a),
      )
      .reverse()
      .map(view);
    if (attributes.length === 0) {
      return json(404, { message: `entity ${type}/${name} does not exist` });
    }
    return json(200, {
      entity: { name, entityType: type },
      attributes,
      relations: [],
      truncated: { attributes: false, relations: false },
    });
  }

  #history(grant: KeyGrant, type: string, name: string) {
    const history = this.attrs
      .filter((a) => a.entity.type === type && a.entity.name === name && this.#readable(grant, a))
      .reverse()
      .map(view);
    if (history.length === 0)
      return json(404, { message: `entity ${type}/${name} does not exist` });
    return json(200, { history, page: { hasMore: false } });
  }

  #query(grant: KeyGrant, body: { query: string; k: number; lens?: string[][] }) {
    const words = new Set(body.query.toLowerCase().split(/\W+/).filter(Boolean));
    const lens = (body.lens ?? []).map((c) => strip(c[0] ?? ""));
    const scored = this.attrs
      .filter((a) => a.supersededBy === null && this.#readable(grant, a))
      .filter((a) => lens.length === 0 || lens.some((l) => within(strip(a.scope[0]?.[0] ?? ""), l)))
      .map((a) => {
        const text = `${a.entity.name} ${String(a.value)}`.toLowerCase();
        return { a, score: [...words].filter((w) => text.includes(w)).length };
      })
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, body.k);
    const hits = scored.map(({ a, score }) => ({
      id: `attribute:${a.id}`,
      text: `${a.entity.name}'s ${a.key} is ${String(a.value)}`,
      source: "attribute",
      score,
      resource: { kind: "attribute", entityType: a.entity.type, name: a.entity.name, key: a.key },
    }));
    const traceId = `t${++this.#seq}`;
    this.traces.set(traceId, { queryText: body.query, retrievedIds: hits.map((h) => h.id) });
    return json(200, { tier: "hybrid", hits, queryMs: 1, trace: { traceId } });
  }

  #trace(id: string) {
    const trace = this.traces.get(id);
    if (trace === undefined) return json(404, { message: "no trace" });
    return json(200, {
      id,
      queryText: trace.queryText,
      resolutionTier: "hybrid",
      retrievals: [{ retrievedIds: trace.retrievedIds }],
    });
  }
}

function view(a: Attr) {
  const { entity, ...rest } = a;
  return { ...rest, entity: `entity:${entity.type}/${entity.name}`, labels: [] };
}

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}
