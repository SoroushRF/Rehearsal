import { ApprovalGrant, PlanManifest, Role, Sha256Hex } from "@rehearsal/contracts";
import { z } from "zod";

/** `fetch` that carries the reviewer's identity (see `useApiFetch`). Injected so tests can stub it. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const PlanSummary = z.object({
  planId: z.string(),
  revision: z.int(),
  planHash: Sha256Hex,
  incidentId: z.string().nullable(),
  createdAt: z.string(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const StoredPlan = z.object({
  planId: z.string(),
  revision: z.int(),
  planHash: Sha256Hex,
  manifest: PlanManifest,
  createdAt: z.string(),
  latestRevision: z.int(),
});
export type StoredPlan = z.infer<typeof StoredPlan>;

export const Dropped = z.array(
  z.object({ actionId: z.string(), reason: z.enum(["reviewer", "dependency"]) }),
);

export const NewRevision = z.object({
  revision: z.int(),
  parentRevision: z.int(),
  planHash: Sha256Hex,
  dropped: Dropped,
});
export type NewRevision = z.infer<typeof NewRevision>;

export const Grant = ApprovalGrant.extend({ live: z.boolean() });
export type Grant = z.infer<typeof Grant>;

/** Where a plan that needs two different approvers stands (decision 0011). */
export const ApprovalStatus = z.object({
  dualRequired: z.boolean(),
  satisfied: z.boolean(),
  signed: z.array(z.object({ role: Role, grantId: z.string(), actorUserId: z.string() })),
  needed: z.array(Role),
});
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApplyAccepted = z.object({
  runId: z.string(),
  state: z.string(),
  existing: z.boolean(),
});
export type ApplyAccepted = z.infer<typeof ApplyAccepted>;

/** A refusal from the API, kept whole so the UI can say exactly why. */
export const ApiRefusal = z.looseObject({
  error: z.string(),
  missing: z.array(Role).optional(),
  latestRevision: z.int().optional(),
  violations: z.array(z.object({ rule: z.string(), detail: z.string() })).optional(),
  detail: z.string().optional(),
});
export type ApiRefusal = z.infer<typeof ApiRefusal>;

export class RefusedError extends Error {
  constructor(
    readonly status: number,
    readonly refusal: ApiRefusal,
  ) {
    super(refusal.error);
  }
}

/** Calls the API and parses the success body, or throws a `RefusedError` with the server's reason. */
export async function call<T>(
  apiFetch: ApiFetch,
  schema: z.ZodType<T>,
  path: string,
  body?: object,
): Promise<T> {
  const res = await apiFetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const refusal = ApiRefusal.safeParse(json);
    throw new RefusedError(
      res.status,
      refusal.success ? refusal.data : { error: `http_${res.status}` },
    );
  }
  return schema.parse(json);
}

const roleNames: Record<Role, string> = {
  finance_lead: "a finance lead",
  support_lead: "a support lead",
};

/** One sentence a reviewer can act on, for every refusal the API gives. */
export function explain(err: unknown): string {
  if (!(err instanceof RefusedError)) return "Something went wrong. Try again.";
  const r = err.refusal;
  switch (r.error) {
    case "unauthenticated":
      return "Your session ended. Sign in again.";
    case "missing_roles":
      return r.missing?.length
        ? `Needs ${r.missing.map((m) => roleNames[m]).join(" and ")} to approve.`
        : "Your role can read plans but not approve them.";
    case "stale_revision":
      return `A newer revision (${r.latestRevision ?? "?"}) exists. Reload to review it.`;
    case "hash_mismatch":
      return "This plan changed since you loaded it. Reload to review the current version.";
    case "policy_violation":
      return `Breaks policy: ${(r.violations ?? []).map((v) => `${v.rule} (${v.detail})`).join("; ")}`;
    case "approval_invalid":
      return `No live approval for this exact plan${r.detail ? `: ${r.detail}` : ""}.`;
    case "forbidden":
      return "Your role can read plans but not ask for a rehearsal.";
    case "incident_not_found":
      return "This deployment can't rehearse that incident.";
    case "not_enqueued":
      return "The planner queue didn't accept the request. Try again.";
    case "rehearsal_not_found":
      return "This rehearsal doesn't exist in your organization.";
    case "plan_not_found":
      return "This plan doesn't exist in your organization.";
    case "database_unavailable":
      return "The API has no database right now.";
    default:
      return `Refused: ${r.error}.`;
  }
}
