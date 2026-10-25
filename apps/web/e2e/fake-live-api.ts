/**
 * A stand-in for the API with just enough state for one review: revise, refuse, approve, apply, and
 * a phantom-held run to read afterwards. Shared by the live-flow and accessibility tests.
 */
import { readFileSync } from "node:fs";
import type { Route } from "@playwright/test";

/** The happy-path fixture as the API would store it (revision 1). */
const file = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/cases/happy-path.bundle.json", import.meta.url),
    "utf8",
  ),
);
export const V1 = { manifest: file.bundle.manifest, planHash: file.planHash as string };
export const V2_HASH = "b".repeat(64);
const AT = "2026-10-22T12:00:00.000Z";

/** Revision 2 applied; a new duplicate charge for cus_fixture_002 appeared after approval. */
const RUN = {
  id: "run_1",
  planId: "plan_happy",
  revision: 2,
  planHash: V2_HASH,
  approvalId: "grant_1",
  requestedBy: "user_finance",
  state: "held",
  createdAt: AT,
  updatedAt: AT,
};
const receipt = (actionId: string, outcome: string, holdReason: object | null = null) => ({
  id: `rcpt_${actionId}`,
  actionId,
  planHash: V2_HASH,
  approvalId: "grant_1",
  outcome,
  providerRef: null,
  observedEffect: {},
  protection: "native_guard_with_documented_limits",
  holdReason,
  limitations: [],
  recordedAt: AT,
});
const PHANTOM_EVENTS = [
  ["run.admitted", { planHash: V2_HASH, approvalId: "grant_1" }],
  ["step.receipt", receipt("patch_001", "confirmed")],
  [
    "step.receipt",
    receipt("refund_002", "held", {
      kind: "query_membership_changed",
      queryObservationId: "q_charges_002",
      added: ["ch_new_dup"],
      removed: [],
    }),
  ],
  ["step.receipt", receipt("patch_002", "confirmed")],
  [
    "step.receipt",
    receipt("note_002", "skipped_dependency", {
      kind: "predecessor_not_confirmed",
      stepId: "refund_002",
    }),
  ],
  ["run.finished", { state: "held", error: null }],
].map(([type, payload], i) => ({ seq: i + 1, runId: "run_1", type, at: AT, payload }));
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** A stand-in for the API with just enough state for one review: revise, refuse, approve, apply. */
export function fakeApi({
  dual = false,
  completedRun = false,
}: {
  dual?: boolean;
  /** Serve the applied run as completed, and the precedent routes, instead of the held phantom. */
  completedRun?: boolean;
} = {}) {
  const run = () => (completedRun ? { ...RUN, state: "completed" } : RUN);
  const precedents: object[] = [];
  let current = { revision: 1, ...V1 };
  const grants: object[] = [];
  let approvals = 0;
  let applied = false;
  const requests: { method: string; path: string; body: unknown }[] = [];

  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postDataJSON?.() ?? null;
    requests.push({ method: req.method(), path, body });
    const summary = {
      planId: "plan_happy",
      revision: current.revision,
      planHash: current.planHash,
      incidentId: "INC-BILL-0927",
      createdAt: "2026-10-22T12:00:00.000Z",
    };

    if (path === "/api/plans") return json(route, 200, { plans: [summary] });
    if (path === "/api/plans/plan_happy")
      return json(route, 200, {
        ...summary,
        manifest: current.manifest,
        latestRevision: current.revision,
      });
    if (path === "/api/plans/plan_happy/revisions") {
      const gone = new Set(["refund_001", "note_001"]);
      current = {
        revision: 2,
        planHash: V2_HASH,
        manifest: {
          ...current.manifest,
          revision: 2,
          parentRevision: 1,
          actions: current.manifest.actions.filter((a: { id: string }) => !gone.has(a.id)),
          excluded: [
            { actionId: "refund_001", reason: "reviewer" },
            { actionId: "note_001", reason: "dependency" },
          ],
        },
      };
      return json(route, 201, {
        planId: "plan_happy",
        revision: 2,
        parentRevision: 1,
        planHash: V2_HASH,
        manifest: current.manifest,
        createdAt: summary.createdAt,
        dropped: current.manifest.excluded,
      });
    }
    // Decision 0011: with `dual`, a support lead and then a different finance lead each sign a seat.
    const seats = () => {
      const signed = (grants as { id: string; roles: string[]; actorUserId: string }[]).map(
        (g) => ({
          role: g.roles[0],
          grantId: g.id,
          actorUserId: g.actorUserId,
        }),
      );
      return {
        dualRequired: true,
        satisfied: signed.length === 2,
        signed,
        needed:
          signed.length === 0
            ? ["support_lead", "finance_lead"]
            : signed.length === 1
              ? ["finance_lead"]
              : [],
      };
    };
    if (path === "/api/plans/plan_happy/approvals" && req.method() === "GET")
      return json(route, 200, { grants, ...(dual && { approval: seats() }) });
    if (dual && path === "/api/plans/plan_happy/approvals") {
      const second = grants.length === 1;
      const grant = {
        id: `grant_${grants.length + 1}`,
        orgId: "org_demo",
        planId: "plan_happy",
        revision: current.revision,
        planHash: current.planHash,
        actorUserId: second ? "user_finance" : "user_support",
        actorSessionId: "sess_1",
        roles: [second ? "finance_lead" : "support_lead"],
        grantedAt: "2026-10-22T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        revokedAt: null,
      };
      grants.push({ ...grant, live: true });
      return json(route, 201, { grant, existing: false, approval: seats() });
    }
    if (path === "/api/plans/plan_happy/approvals") {
      // First as a support lead (refused), then as a finance lead.
      if (++approvals === 1)
        return json(route, 403, {
          error: "missing_roles",
          missing: ["finance_lead"],
          held: ["support_lead"],
        });
      const grant = {
        id: "grant_1",
        orgId: "org_demo",
        planId: "plan_happy",
        revision: current.revision,
        planHash: current.planHash,
        actorUserId: "user_finance",
        actorSessionId: "sess_1",
        roles: ["finance_lead", "support_lead"],
        grantedAt: "2026-10-22T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        revokedAt: null,
      };
      grants.push({ ...grant, live: true });
      return json(route, 201, { grant, existing: false });
    }
    if (path === "/api/plans/plan_happy/apply") {
      applied = true;
      return json(route, 202, { runId: "run_1", state: "approved", existing: false });
    }
    if (path === "/api/plans/plan_happy/runs")
      return json(route, 200, { runs: applied ? [run()] : [] });
    if (path === "/api/precedents") return json(route, 200, { precedents, syncEnabled: false });
    if (path === "/api/runs/run_1/precedents") {
      const b = body as Record<string, unknown>;
      precedents.push({
        id: b.id,
        version: 1,
        appliesTo: b.appliesTo,
        status: "waiting",
        statement: b.statement,
        conditions: b.conditions,
        exceptions: b.exceptions,
        effectiveFrom: b.effectiveFrom,
        effectiveUntil: b.effectiveUntil,
        author: "user_finance",
        approvedAt: "2026-10-24T12:00:00.000Z",
      });
      return json(route, 201, { precedent: { id: b.id, version: 1 }, syncEnabled: false });
    }
    if (path === "/api/runs/run_1/events") {
      // The phantom: a new duplicate charge appeared for cus_fixture_002 after approval.
      const after = Number(new URL(req.url()).searchParams.get("after") ?? 0);
      return json(route, 200, {
        run: run(),
        events: PHANTOM_EVENTS.filter((e) => e.seq > after),
        more: false,
      });
    }
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests };
}
