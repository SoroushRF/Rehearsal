import { readFileSync } from "node:fs";
import { expect, type Route, test } from "@playwright/test";

/** The happy-path fixture as the API would store it (revision 1). */
const file = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/cases/happy-path.bundle.json", import.meta.url),
    "utf8",
  ),
);
const V1 = { manifest: file.bundle.manifest, planHash: file.planHash as string };
const V2_HASH = "b".repeat(64);
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
function fakeApi() {
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
    if (path === "/api/plans/plan_happy/approvals" && req.method() === "GET")
      return json(route, 200, { grants });
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
      return json(route, 200, { runs: applied ? [RUN] : [] });
    if (path === "/api/runs/run_1/events") {
      // The phantom: a new duplicate charge appeared for cus_fixture_002 after approval.
      const after = Number(new URL(req.url()).searchParams.get("after") ?? 0);
      return json(route, 200, {
        run: RUN,
        events: PHANTOM_EVENTS.filter((e) => e.seq > after),
        more: false,
      });
    }
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests };
}

test("uncheck → revision → refused → approved → apply, all through the API", async ({ page }) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  await expect(page.getByTestId("action-row")).toHaveCount(6);
  await page.getByLabel("Include refund_001").uncheck();
  // The dependent note drops in the preview, and can't be re-included on its own.
  await expect(page.locator('[data-action-id="note_001"]')).toHaveAttribute("data-dropped", "true");
  await expect(page.getByLabel("Include note_001")).toBeDisabled();
  await expect(page.getByTestId("exclusion-bar")).toContainText("refund_001, note_001");
  await expect(page.getByRole("button", { name: "Approve revision 1" })).toBeDisabled();

  await page.getByRole("button", { name: "Create revision 2" }).click();
  await expect(page.getByRole("status")).toContainText("Revision 2 created from 1");
  await expect(page.getByRole("status")).toContainText("note_001 (dependent)");
  await expect(page.getByTestId("action-row")).toHaveCount(4);
  await expect(page.getByTestId("plan-hash")).toHaveAttribute("title", V2_HASH);

  await page.getByRole("button", { name: "Approve revision 2" }).click();
  await expect(page.getByRole("alert")).toHaveText("Needs a finance lead to approve.");

  await page.getByRole("button", { name: "Approve revision 2" }).click();
  await expect(page.getByTestId("live-grant")).toContainText("user_finance");
  await page.getByRole("button", { name: "Apply to production" }).click();
  await expect(page.getByTestId("run-started")).toContainText("run_1");

  // The run report says, step by step, what happened and why.
  const report = page.getByTestId("run-report");
  await expect(report).toContainText("held");
  await expect(report.locator('[data-action-id="patch_001"]')).toHaveAttribute(
    "data-outcome",
    "confirmed",
  );
  await expect(report.locator('[data-action-id="refund_002"]')).toContainText(
    "New matching record appeared after approval (ch_new_dup)",
  );
  await expect(report.locator('[data-action-id="note_002"]')).toContainText(
    "Waits for refund_002, which didn't complete.",
  );

  // The browser only ever sent IDs, revisions and hashes, never action bodies.
  const posts = api.requests.filter((r) => r.method === "POST").map((r) => [r.path, r.body]);
  expect(posts).toEqual([
    [
      "/api/plans/plan_happy/revisions",
      { baseRevision: 1, basePlanHash: V1.planHash, excludeActionIds: ["refund_001"] },
    ],
    ["/api/plans/plan_happy/approvals", { revision: 2, planHash: V2_HASH }],
    ["/api/plans/plan_happy/approvals", { revision: 2, planHash: V2_HASH }],
    ["/api/plans/plan_happy/apply", { revision: 2, planHash: V2_HASH }],
  ]);
});
