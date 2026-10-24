import type { Sha256Hex } from "@rehearsal/contracts";
import type { Clock, Precedent, PrecedentPort } from "@rehearsal/core";
import type { AgentMemoryClient } from "./client";
import {
  decodeAttributes,
  ENTITY_TYPE,
  entityName,
  inExactScope,
  isEffective,
  normalizeScope,
  PrecedentRecord,
  precedentDigest,
  precedentIdOf,
  toTriples,
} from "./precedent";

/** Slash-separated lowercase segments; the service rejects uppercase and spaces. */
const SCOPE_PATH = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

export type StoredPrecedent =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; record: PrecedentRecord; digest: Sha256Hex; factIds: string[] };

export interface PublishedPrecedent {
  id: string;
  version: number;
  digest: Sha256Hex;
  /** The stored attributes readback validated, sorted. */
  factIds: string[];
  scope: string;
  /** False when this exact version was already stored, so nothing was sent. */
  written: boolean;
}

export interface PrecedentVersion {
  factId: string;
  recordedAt: string;
  superseded: boolean;
  /** Null when the stored text isn't a valid record; `reason` says why. */
  record: PrecedentRecord | null;
  reason?: string;
}

export interface RecalledPrecedent extends Precedent {
  record: PrecedentRecord;
  digest: Sha256Hex;
  /** The stored attributes this version was read back from. */
  factIds: string[];
  /** The recall hits that led to it, as the trace names them. */
  hitIds: string[];
}

export interface PrecedentRecall {
  precedents: RecalledPrecedent[];
  traceId: string | null;
  /** Precedents a hit pointed at that we didn't return, with why. */
  rejected: { id: string; reason: string }[];
}

export class PrecedentConflictError extends Error {
  constructor(
    readonly id: string,
    detail: string,
  ) {
    super(`precedent ${id}: ${detail}`);
    this.name = "PrecedentConflictError";
  }
}

export class PrecedentReadbackError extends Error {
  constructor(
    readonly id: string,
    detail: string,
  ) {
    super(`precedent ${id} failed readback: ${detail}`);
    this.name = "PrecedentReadbackError";
  }
}

export interface AgentMemoryPrecedentsOptions {
  /** The one scope precedents are written to and recalled from, e.g. `rehearsal/precedents`. */
  scope: string;
  clock?: Clock;
  /** Recall hits to ask for; the service caps it at 50. */
  k?: number;
}

/**
 * Precedents on SurrealDB Agent Memory (build plan §7). Memory is a recall index, never an
 * authority: Postgres holds the approved version, publish is what its outbox calls, and the
 * executor checks citations against the registry (see `checkCitations`), never against recall.
 *
 * Errors propagate. An outage fails recall instead of returning no precedents, so a plan that
 * depends on memory is blocked rather than planned without its precedents.
 */
export class AgentMemoryPrecedents implements PrecedentPort {
  readonly scope: string;
  readonly #client: AgentMemoryClient;
  readonly #clock: Clock;
  readonly #k: number;

  constructor(client: AgentMemoryClient, options: AgentMemoryPrecedentsOptions) {
    const scope = normalizeScope(options.scope);
    if (!SCOPE_PATH.test(scope)) throw new Error(`invalid memory scope "${options.scope}"`);
    const k = options.k ?? 10;
    if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error(`k must be 1–50, got ${k}`);
    this.scope = scope;
    this.#client = client;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#k = k;
  }

  /**
   * Store an approved version and read it back. Versions only go up: publishing one older than
   * any stored version, or the same version with different content, is a conflict. Publishing
   * the stored version again writes nothing, so the outbox can retry freely.
   */
  async publish(input: PrecedentRecord): Promise<PublishedPrecedent> {
    const record = PrecedentRecord.parse(input);
    const digest = precedentDigest(record);
    await this.#client.registerScope(this.scope);

    for (const past of await this.history(record.id)) {
      if (past.record === null) continue;
      if (past.record.version > record.version) {
        throw new PrecedentConflictError(
          record.id,
          `v${past.record.version} is already stored; v${record.version} is older`,
        );
      }
      if (past.record.version === record.version && precedentDigest(past.record) !== digest) {
        throw new PrecedentConflictError(
          record.id,
          `v${record.version} is already stored with different content`,
        );
      }
    }

    const current = await this.read(record.id);
    const written = !(current.status === "valid" && current.digest === digest);
    if (written) await this.#client.writeTriples(this.scope, toTriples(record));

    const stored = await this.read(record.id);
    if (stored.status !== "valid") {
      throw new PrecedentReadbackError(
        record.id,
        stored.status === "invalid" ? stored.reason : "nothing stored",
      );
    }
    if (stored.digest !== digest) {
      throw new PrecedentReadbackError(
        record.id,
        `stored v${stored.record.version} is not the version published`,
      );
    }
    return {
      id: record.id,
      version: record.version,
      digest,
      factIds: stored.factIds,
      scope: this.scope,
      written,
    };
  }

  /** The current stored version, from attributes in exactly our scope. */
  async read(id: string): Promise<StoredPrecedent> {
    const view = await this.#client.entity(ENTITY_TYPE, entityName(id));
    const attributes = view?.attributes ?? [];
    if (!attributes.some((a) => inExactScope(a, this.scope))) return { status: "absent" };
    const decoded = decodeAttributes(id, this.scope, attributes);
    if (decoded.ok) {
      return {
        status: "valid",
        record: decoded.record,
        digest: decoded.digest,
        factIds: decoded.factIds,
      };
    }
    const reason = view?.truncated.attributes
      ? `${decoded.reason} (attribute list truncated)`
      : decoded.reason;
    return { status: "invalid", reason };
  }

  /** Every version stored in our scope, newest first. */
  async history(id: string): Promise<PrecedentVersion[]> {
    const attributes = await this.#client.history(ENTITY_TYPE, entityName(id));
    return attributes
      .filter((a) => a.key === "record" && inExactScope(a, this.scope))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((a) => {
        const base = { factId: a.id, recordedAt: a.createdAt, superseded: a.supersededBy !== null };
        const parsed = parseRecord(a.value);
        return parsed.ok
          ? { ...base, record: parsed.record }
          : { ...base, record: null, reason: parsed.reason };
      });
  }

  /**
   * Precedents relevant to `caseKey`, each read back in full and effective today. Recall only
   * finds candidates: every returned version comes from readback, never from hit text.
   */
  async recall(caseKey: string): Promise<PrecedentRecall> {
    const result = await this.#client.query({ query: caseKey, k: this.#k, lens: [[this.scope]] });

    const hitIds = new Map<string, string[]>();
    for (const hit of result.hits) {
      const resource = hit.resource;
      if (resource?.kind !== "attribute" || resource.entityType !== ENTITY_TYPE) continue;
      const id = precedentIdOf(resource.name ?? "");
      if (id !== null) hitIds.set(id, [...(hitIds.get(id) ?? []), hit.id]);
    }

    const today = this.#clock.now().toISOString().slice(0, 10);
    const reads = await Promise.all(
      [...hitIds.keys()].map(async (id) => [id, await this.read(id)] as const),
    );
    const precedents: RecalledPrecedent[] = [];
    const rejected: PrecedentRecall["rejected"] = [];
    for (const [id, stored] of reads) {
      if (stored.status === "absent") rejected.push({ id, reason: "nothing stored in scope" });
      else if (stored.status === "invalid") rejected.push({ id, reason: stored.reason });
      else if (!isEffective(stored.record, today)) {
        rejected.push({ id, reason: `not effective on ${today}` });
      } else {
        const { record } = stored;
        precedents.push({
          id,
          version: record.version,
          statement: record.statement,
          author: record.author,
          record,
          digest: stored.digest,
          factIds: stored.factIds,
          hitIds: hitIds.get(id) ?? [],
        });
      }
    }
    return { precedents, traceId: result.trace?.traceId ?? null, rejected };
  }
}

function parseRecord(
  value: unknown,
): { ok: true; record: PrecedentRecord } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "not a string" };
  try {
    const parsed = PrecedentRecord.safeParse(JSON.parse(value));
    return parsed.success
      ? { ok: true, record: parsed.data }
      : { ok: false, reason: parsed.error.message };
  } catch {
    return { ok: false, reason: "not JSON" };
  }
}
