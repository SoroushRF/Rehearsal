import type {
  Action,
  Attempt,
  EntityRef,
  Observation,
  QueryObservation,
  QueryPredicate,
  Vendor,
} from "@rehearsal/contracts";
import {
  type DispatchResult,
  fingerprint,
  noteBodyFor,
  type Preconditions,
  type PreparedRequest,
  type ProviderPort,
  type ReconcileResult,
  type ResolvedBindings,
} from "@rehearsal/core";

export interface FakeCharge {
  id: string;
  customer: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
}
export interface FakeTicket {
  id: string;
  priority: string | null;
  status: string;
  requester_id: string;
  comments: { id: number; body: string; public: boolean }[];
}
export interface FakeRefund {
  id: string;
  charge: string;
  amount: number;
  status: "succeeded";
  operationKey: string;
}

/** Scripted failure for the next matching dispatch. */
export type FakeFault =
  | { kind: "reject"; status: number; retryable: boolean; retryAfterMs?: number }
  /** Apply the effect, then lose the response (a lost-response-after-commit). */
  | { kind: "drop_response_after_commit" };

/**
 * In-memory Stripe + Zendesk "operational world" behind one ProviderPort per vendor. Mirrors the
 * Era behaviors we rely on: Stripe idempotency on path + exact body bytes, Zendesk notes appended.
 */
export class FakeWorld {
  readonly charges = new Map<string, FakeCharge>();
  readonly tickets = new Map<string, FakeTicket>();
  readonly refunds: FakeRefund[] = [];
  /** Every effect actually applied, in order. Tests assert "exactly one refund" on this. */
  readonly effects: { operationKey: string; path: string }[] = [];
  readonly #idempotency = new Map<string, { bodySha: string; response: unknown }>();
  readonly #faults = new Map<string, FakeFault[]>();
  #refundSeq = 0;
  #commentSeq = 0;
  /** Zendesk-style `updated_at` per ticket: moves on every write, ours or a teammate's. */
  readonly #stamps = new Map<string, number>();

  #stamp(ticketId: string): string {
    return `stamp-${this.#stamps.get(ticketId) ?? 0}`;
  }
  #touch(ticketId: string): void {
    this.#stamps.set(ticketId, (this.#stamps.get(ticketId) ?? 0) + 1);
  }

  /** A teammate edits a ticket field directly (outside any plan); it moves the stamp. */
  teammateEdit(ticketId: string, field: "priority" | "status", value: string): void {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`no ticket ${ticketId}`);
    ticket[field] = value;
    this.#touch(ticketId);
  }

  /** Queue a fault for the next dispatch whose path starts with `pathPrefix`. */
  fault(pathPrefix: string, fault: FakeFault): void {
    this.#faults.set(pathPrefix, [...(this.#faults.get(pathPrefix) ?? []), fault]);
  }

  #takeFault(path: string): FakeFault | undefined {
    for (const [prefix, list] of this.#faults) {
      if (path.startsWith(prefix) && list.length > 0) return list.shift();
    }
    return undefined;
  }

  provider(vendor: Extract<Vendor, "stripe" | "zendesk">): ProviderPort {
    return {
      vendor,
      observe: async (entity) => this.#observe(entity),
      query: async (predicate, cutoff) => this.#query(predicate, cutoff),
      // Like the real Zendesk writer: a field patch is guarded by the stamp read just before.
      ...(vendor === "zendesk" && {
        preconditions: async (action: Action): Promise<Preconditions> =>
          action.kind === "zendesk.ticket.patchFields"
            ? { updated_stamp: this.#stamp(action.args.ticketId) }
            : {},
        preconditionsOf: (request: Attempt["request"]): Preconditions => {
          const stamp = (JSON.parse(request.body) as { ticket?: { updated_stamp?: string } }).ticket
            ?.updated_stamp;
          return stamp ? { updated_stamp: stamp } : {};
        },
      }),
      prepare: (action, bindings, operationKey, pre) =>
        this.#prepare(action, bindings, operationKey, pre ?? {}),
      dispatch: async (request) => this.#dispatch(request),
      reconcile: async (attempt, action) => this.#reconcile(attempt, action),
    };
  }

  #prepare(
    action: Action,
    bindings: ResolvedBindings,
    operationKey: string,
    pre: Preconditions,
  ): PreparedRequest {
    switch (action.kind) {
      case "stripe.refund.create": {
        // Fixed field order: Stripe fingerprints the raw bytes, so a reorder is a different request.
        const body = new URLSearchParams([
          ["charge", action.args.chargeId],
          ["amount", String(action.args.amount.amountMinor)],
          ["reason", action.args.reason],
          ["metadata[rehearsal_op]", operationKey],
        ]).toString();
        return {
          method: "POST",
          path: "/v1/refunds",
          encoding: "form",
          body,
          headers: { "Idempotency-Key": operationKey },
        };
      }
      case "zendesk.ticket.patchFields":
        return {
          method: "PUT",
          path: `/api/v2/tickets/${action.args.ticketId}.json`,
          encoding: "json",
          body: JSON.stringify({
            ticket: pre.updated_stamp
              ? { ...action.args.set, safe_update: true, updated_stamp: pre.updated_stamp }
              : action.args.set,
          }),
          headers: {},
        };
      case "zendesk.ticket.appendPrivateNote": {
        const note = noteBodyFor(action, bindings, operationKey);
        return {
          method: "PUT",
          path: `/api/v2/tickets/${action.args.ticketId}.json`,
          encoding: "json",
          body: JSON.stringify({ ticket: { comment: { body: note, public: false } } }),
          headers: {},
        };
      }
    }
  }

  #dispatch(req: PreparedRequest): DispatchResult {
    const fault = this.#takeFault(req.path);
    if (fault?.kind === "reject") {
      return {
        kind: "rejected",
        status: fault.status,
        body: { error: "injected" },
        retryable: fault.retryable,
        ...(fault.retryAfterMs !== undefined && { retryAfterMs: fault.retryAfterMs }),
      };
    }
    const response = this.#apply(req);
    if (fault?.kind === "drop_response_after_commit") {
      return { kind: "unknown", error: "response dropped after commit (injected)" };
    }
    return response;
  }

  #apply(req: PreparedRequest): DispatchResult {
    if (req.path === "/v1/refunds") {
      const key = req.headers["Idempotency-Key"];
      if (!key)
        return { kind: "rejected", status: 400, body: { error: "missing key" }, retryable: false };
      // Era fingerprints path + raw body bytes under the key.
      const bodySha = fingerprint({ path: req.path, body: req.body });
      const seen = this.#idempotency.get(key);
      if (seen) {
        if (seen.bodySha !== bodySha) {
          return {
            kind: "rejected",
            status: 400,
            body: { error: "idempotency_error" },
            retryable: false,
          };
        }
        return { kind: "confirmed", status: 200, body: seen.response };
      }
      const form = new URLSearchParams(req.body);
      const charge = this.charges.get(form.get("charge") ?? "");
      const amount = Number(form.get("amount"));
      if (!charge || charge.amount_refunded + amount > charge.amount) {
        return {
          kind: "rejected",
          status: 400,
          body: { error: "invalid_refund" },
          retryable: false,
        };
      }
      charge.amount_refunded += amount;
      const opKey = form.get("metadata[rehearsal_op]") ?? key;
      const refund: FakeRefund = {
        id: `re_fake_${String(++this.#refundSeq).padStart(4, "0")}`,
        charge: charge.id,
        amount,
        status: "succeeded",
        operationKey: opKey,
      };
      this.refunds.push(refund);
      this.effects.push({ operationKey: opKey, path: req.path });
      const response = {
        id: refund.id,
        object: "refund",
        charge: charge.id,
        amount,
        status: refund.status,
      };
      this.#idempotency.set(key, { bodySha, response });
      return { kind: "confirmed", status: 200, body: response };
    }

    const m = /^\/api\/v2\/tickets\/(.+)\.json$/.exec(req.path);
    const ticket = m ? this.tickets.get(m[1] as string) : undefined;
    if (!ticket)
      return { kind: "rejected", status: 404, body: { error: "RecordNotFound" }, retryable: false };
    const { ticket: patch } = JSON.parse(req.body) as {
      ticket: {
        priority?: string;
        status?: string;
        comment?: { body: string; public: boolean };
        safe_update?: boolean;
        updated_stamp?: string;
      };
    };
    const id = m?.[1] as string;
    if (patch.safe_update && patch.updated_stamp !== this.#stamp(id)) {
      return { kind: "rejected", status: 409, body: { error: "UpdateConflict" }, retryable: false };
    }
    if (patch.comment) {
      ticket.comments.push({
        id: ++this.#commentSeq,
        body: patch.comment.body,
        public: patch.comment.public,
      });
    }
    if (patch.priority !== undefined) ticket.priority = patch.priority;
    if (patch.status !== undefined) ticket.status = patch.status;
    this.#touch(id);
    this.effects.push({ operationKey: "", path: req.path });
    return { kind: "confirmed", status: 200, body: { ticket: { ...ticket } } };
  }

  #observe(entity: EntityRef): Observation {
    const record =
      entity.kind === "charge" ? this.charges.get(entity.id) : this.tickets.get(entity.id);
    if (!record) throw new Error(`no ${entity.kind} ${entity.id}`);
    const { comments: _c, ...projection } = record as FakeTicket;
    return {
      id: `obs_${entity.kind}_${entity.id}`,
      world: "operational",
      entity,
      projectionVersion: `${entity.vendor}.${entity.kind}.v1`,
      projection,
      fingerprint: fingerprint(projection),
      capturedAt: new Date().toISOString(),
    };
  }

  #query(predicate: QueryPredicate, cutoff: string): QueryObservation {
    if (predicate.kind !== "stripe.charges.byCustomerInWindow") {
      throw new Error(`fake does not support ${predicate.kind}`);
    }
    const matches = [...this.charges.values()]
      .filter((c) => c.customer === predicate.customerId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const projections = Object.fromEntries(matches.map((c) => [c.id, { ...c }]));
    const matchingIds = matches.map((c) => c.id);
    return {
      id: `q_${predicate.customerId}`,
      world: "operational",
      vendor: "stripe",
      predicate,
      cutoff,
      complete: true,
      matchingIds,
      projectionVersion: "stripe.charge.v1",
      projections,
      fingerprint: fingerprint({ matchingIds, projections }),
      capturedAt: new Date().toISOString(),
    };
  }

  #reconcile(attempt: Attempt, action: Action): ReconcileResult {
    if (action.kind !== "stripe.refund.create")
      return { kind: "indeterminate", detail: "fake reconciles refunds only" };
    const refund = this.refunds.find((r) => r.operationKey === attempt.operationKey);
    return refund
      ? {
          kind: "applied",
          providerRef: { vendor: "stripe", kind: "refund", id: refund.id },
          effect: {
            "refund.id": refund.id,
            "refund.status": refund.status,
            "refund.amount": refund.amount,
          },
        }
      : { kind: "not_applied" };
  }
}

/** Seed a FakeWorld with the records a manifest's observations describe (identical worlds). */
export function worldFromManifest(observations: readonly Observation[]): FakeWorld {
  const world = new FakeWorld();
  for (const o of observations) {
    const p = o.projection as Record<string, unknown>;
    if (o.entity.kind === "charge")
      world.charges.set(o.entity.id, { ...(p as unknown as FakeCharge) });
    if (o.entity.kind === "ticket") {
      world.tickets.set(o.entity.id, {
        ...(p as unknown as Omit<FakeTicket, "comments">),
        comments: [],
      });
    }
  }
  return world;
}
