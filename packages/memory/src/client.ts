import { z } from "zod";
import type { Triple } from "./precedent";

export interface AgentMemoryConfig {
  /** e.g. https://srv1.spectron.aws-usw2.surreal.cloud */
  url: string;
  /** The context ID from SurrealDB Studio. */
  context: string;
  /** A data-plane key (`sp-…`). Never logged or put in an error message. */
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A non-2xx answer. `status` is what callers branch on: 403 wrong scope, 401 bad key. */
export class AgentMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    detail: string,
  ) {
    super(`${route} → ${status}: ${detail}`);
    this.name = "AgentMemoryError";
  }
}

const Path = z.array(z.array(z.string()));

const Attribute = z.object({
  id: z.string().min(1),
  key: z.string(),
  value: z.unknown(),
  memoryCategory: z.string(),
  scope: Path,
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
});
export type Attribute = z.infer<typeof Attribute>;

const EntityView = z.object({
  entity: z.object({ name: z.string(), entityType: z.string() }),
  attributes: z.array(Attribute),
  truncated: z.object({ attributes: z.boolean() }),
});
export type EntityView = z.infer<typeof EntityView>;

const HistoryPage = z.object({
  history: z.array(Attribute),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().optional() }),
});

const WriteResult = z.object({
  mode: z.literal("triples"),
  extraction: z.object({
    attributes: z.array(z.object({ id: z.string(), key: z.string() })),
  }),
});

const Hit = z.object({
  id: z.string(),
  source: z.string(),
  score: z.number().optional(),
  resource: z
    .object({
      kind: z.string(),
      entityType: z.string().optional(),
      name: z.string().optional(),
      key: z.string().optional(),
    })
    .optional(),
});
export type Hit = z.infer<typeof Hit>;

const QueryResult = z.object({
  tier: z.string(),
  hits: z.array(Hit),
  trace: z.object({ traceId: z.string().min(1) }).optional(),
});
export type QueryResult = z.infer<typeof QueryResult>;

const Trace = z.object({
  id: z.string(),
  queryText: z.string(),
  resolutionTier: z.string(),
  retrievals: z.array(z.object({ retrievedIds: z.array(z.string()) })),
});
export type Trace = z.infer<typeof Trace>;

export interface QueryRequest {
  query: string;
  k: number;
  /** DNF read filter, e.g. [["rehearsal/precedents"]]. */
  lens: string[][];
}

/**
 * The slice of the Agent Memory REST API precedents use, with every response validated. Write
 * bodies are snake_case and read bodies camelCase; the service ignores unknown fields silently,
 * so these shapes are pinned by the tests rather than trusted.
 *
 * No idempotency header: the hosted service ignores `Idempotency-Key` on /facts (a second body
 * under the same key is written). Retries are safe anyway, because rewriting a value an attribute
 * already holds stores nothing new.
 */
export class AgentMemoryClient {
  readonly #base: string;
  readonly #config: AgentMemoryConfig;

  constructor(config: AgentMemoryConfig) {
    this.#config = config;
    this.#base = `${config.url.replace(/\/+$/, "")}/api/v1/${encodeURIComponent(config.context)}`;
  }

  /** Registering an existing scope succeeds; missing parents are created too. */
  async registerScope(path: string): Promise<void> {
    await this.#call("POST", "/scopes", { path });
  }

  async writeTriples(scope: string, triples: Triple[]): Promise<z.infer<typeof WriteResult>> {
    const body = { infer: "triples", scopes: [[scope]], triples };
    return WriteResult.parse(await this.#call("POST", "/facts", body));
  }

  /** Live attributes the key can read, from every scope. Null when there are none. */
  async entity(type: string, name: string): Promise<EntityView | null> {
    const res = await this.#call("GET", entityPath(type, name), undefined, { allow404: true });
    return res === null ? null : EntityView.parse(res);
  }

  /** Every attribute ever written to the entity, superseded ones included, newest first. */
  async history(type: string, name: string): Promise<Attribute[]> {
    const all: Attribute[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const res = await this.#call("GET", `${entityPath(type, name)}/history${query}`, undefined, {
        allow404: true,
      });
      if (res === null) return [];
      const page = HistoryPage.parse(res);
      all.push(...page.history);
      if (page.page.hasMore && page.page.nextCursor === undefined) {
        throw new AgentMemoryError(200, "GET history", "more pages but no cursor");
      }
      cursor = page.page.hasMore ? page.page.nextCursor : undefined;
    } while (cursor !== undefined);
    return all;
  }

  async query(request: QueryRequest): Promise<QueryResult> {
    const body = { ...request, include: ["facts"] };
    return QueryResult.parse(await this.#call("POST", "/query", body));
  }

  async trace(traceId: string): Promise<Trace> {
    return Trace.parse(await this.#call("GET", `/traces/${encodeURIComponent(traceId)}`));
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    { allow404 = false } = {},
  ): Promise<unknown> {
    const route = `${method} ${path.split("?")[0]}`;
    const res = await (this.#config.fetch ?? fetch)(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#config.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#config.timeoutMs ?? 30_000),
    });
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new AgentMemoryError(res.status, route, errorDetail(text));
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      throw new AgentMemoryError(res.status, route, "response is not JSON");
    }
  }
}

function entityPath(type: string, name: string): string {
  // A "/" in the name 404s even when encoded, so precedent names never contain one.
  return `/entities/${encodeURIComponent(type)}/${encodeURIComponent(name)}`;
}

/** Errors are `{"message": …}`; some 4xx are plain text. Trimmed so a body can't flood logs. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
  } catch {}
  return text.slice(0, 300);
}
