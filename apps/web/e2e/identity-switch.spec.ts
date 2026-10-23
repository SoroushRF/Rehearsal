import { readFileSync } from "node:fs";
import { expect, type Route, test } from "@playwright/test";

/** One plan per organization, from the happy-path fixture under a different plan ID and incident. */
const file = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/cases/happy-path.bundle.json", import.meta.url),
    "utf8",
  ),
);
const AT = "2026-10-22T12:00:00.000Z";
const HASH = { plan_a: "a".repeat(64), plan_b: "b".repeat(64) } as const;
const ORG_PLAN: Record<string, keyof typeof HASH> = { "user_a/org_a": "plan_a" };
const planFor = (identity: string): keyof typeof HASH =>
  ORG_PLAN[identity] ?? (identity.endsWith("/org_b") ? "plan_b" : "plan_a");
const INCIDENT = { plan_a: "INC-ORG-A-ONLY", plan_b: "INC-ORG-B-ONLY" } as const;

const manifest = (planId: keyof typeof HASH) => ({
  ...file.bundle.manifest,
  planId,
  incidentId: INCIDENT[planId],
});
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** An API that serves each identity only its own org's plan, and records who asked for what. */
function fakeApi() {
  const calls: { identity: string; path: string }[] = [];
  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const identity = req.headers()["x-test-identity"] ?? "(none)";
    calls.push({ identity, path });
    // Anyone but org A's user answers slowly, so content left over from A would stay on screen
    // while B loads. Showing none of it during that wait is part of the acceptance.
    if (identity !== "user_a/org_a") await new Promise((r) => setTimeout(r, 500));
    const mine = planFor(identity);
    const summary = (id: keyof typeof HASH) => ({
      planId: id,
      revision: 1,
      planHash: HASH[id],
      incidentId: INCIDENT[id],
      createdAt: AT,
    });

    if (path === "/api/plans") return json(route, 200, { plans: [summary(mine)] });
    if (path === `/api/plans/${mine}`) {
      return json(route, 200, {
        ...summary(mine),
        manifest: manifest(mine),
        latestRevision: 1,
      });
    }
    if (path === `/api/plans/${mine}/approvals`) {
      // Only org A's plan has a live grant, approved by a finance lead only org A knows.
      const grants =
        mine === "plan_a"
          ? [
              {
                id: "grant_a",
                orgId: "org_a",
                planId: "plan_a",
                revision: 1,
                planHash: HASH.plan_a,
                actorUserId: "user_finance_of_org_a",
                actorSessionId: "sess_1",
                roles: ["finance_lead", "support_lead"],
                grantedAt: AT,
                expiresAt: "2099-01-01T00:00:00.000Z",
                revokedAt: null,
                live: true,
              },
            ]
          : [];
      return json(route, 200, { grants });
    }
    if (path === `/api/plans/${mine}/runs`) return json(route, 200, { runs: [] });
    return json(route, 404, { error: "plan_not_found" });
  }
  return { handle, calls };
}

const page_ = (page: import("@playwright/test").Page) => ({
  uncheckFirstRefund: () => page.getByLabel("Include refund_001").uncheck(),
  body: () => page.locator("body"),
});

test("switching organization shows none of the previous org's plan, grant or editing state", async ({
  page,
}) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  const ui = page_(page);

  // Org A: its plan, its approval, and a half-made edit.
  await expect(page.getByText("INC-ORG-A-ONLY")).toBeVisible();
  await expect(page.getByTestId("live-grant")).toContainText("user_finance_of_org_a");
  await ui.uncheckFirstRefund();
  await expect(page.getByTestId("exclusion-bar")).toBeVisible();

  await page.getByRole("button", { name: "Switch to org B" }).click();

  // While B loads, nothing of A is on screen.
  await expect(page.getByText("Loading plans…")).toBeVisible();
  await expect(ui.body()).not.toContainText("INC-ORG-A-ONLY");
  await expect(ui.body()).not.toContainText("plan_a");

  // Org B: its own plan, and nothing at all from org A.
  await expect(page.getByText("INC-ORG-B-ONLY")).toBeVisible();
  await expect(ui.body()).not.toContainText("INC-ORG-A-ONLY");
  await expect(ui.body()).not.toContainText("plan_a");
  await expect(ui.body()).not.toContainText("user_finance_of_org_a");
  await expect(page.getByTestId("live-grant")).toHaveCount(0);
  await expect(page.getByTestId("exclusion-bar")).toHaveCount(0);
  await expect(page.getByLabel("Include refund_001")).toBeChecked();

  // B asked the API for its own data under its own identity, and A's identity asked for nothing
  // after the switch.
  const afterSwitch = api.calls.slice(api.calls.findIndex((c) => c.identity === "user_a/org_b"));
  expect(afterSwitch.length).toBeGreaterThan(0);
  expect(afterSwitch.every((c) => c.identity === "user_a/org_b")).toBe(true);
  expect(afterSwitch.some((c) => c.path === "/api/plans")).toBe(true);

  // Back to A: refetched under A, not served from a cache that outlived the switch.
  const listsForA = () =>
    api.calls.filter((c) => c.identity === "user_a/org_a" && c.path === "/api/plans").length;
  const before = listsForA();
  await page.getByRole("button", { name: "Be user A in org A" }).click();
  await expect(page.getByText("INC-ORG-A-ONLY")).toBeVisible();
  expect(listsForA()).toBeGreaterThan(before);
  await expect(page.getByTestId("exclusion-bar")).toHaveCount(0);
});

test("signing out, then in as another account, shows nothing of the first account", async ({
  page,
}) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  const ui = page_(page);

  await expect(page.getByText("INC-ORG-A-ONLY")).toBeVisible();
  await expect(page.getByTestId("live-grant")).toContainText("user_finance_of_org_a");
  await ui.uncheckFirstRefund();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("signed-out")).toBeVisible();
  await expect(ui.body()).not.toContainText("INC-ORG-A-ONLY");
  await expect(ui.body()).not.toContainText("user_finance_of_org_a");

  await page.getByRole("button", { name: "Sign in as user C in org B" }).click();
  await expect(page.getByText("Loading plans…")).toBeVisible();
  await expect(ui.body()).not.toContainText("INC-ORG-A-ONLY");
  await expect(ui.body()).not.toContainText("user_finance_of_org_a");
  await expect(page.getByText("INC-ORG-B-ONLY")).toBeVisible();
  await expect(ui.body()).not.toContainText("INC-ORG-A-ONLY");
  await expect(ui.body()).not.toContainText("user_finance_of_org_a");
  await expect(page.getByTestId("exclusion-bar")).toHaveCount(0);
  expect(api.calls.at(-1)?.identity).toBe("user_c/org_b");
});
