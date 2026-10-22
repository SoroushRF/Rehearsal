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
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** A stand-in for the API with just enough state for one review: revise, refuse, approve, apply. */
function fakeApi() {
  let current = { revision: 1, ...V1 };
  const grants: object[] = [];
  let approvals = 0;
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
    if (path === "/api/plans/plan_happy/apply")
      return json(route, 202, { runId: "run_1", state: "approved", existing: false });
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
