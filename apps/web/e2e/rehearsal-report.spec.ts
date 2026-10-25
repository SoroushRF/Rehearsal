import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { ExecutionRehearsalReport } from "@rehearsal/contracts";
import { FIXTURE_REHEARSAL_ID, rehearsalReportFixture } from "@rehearsal/testkit";
import { violations } from "./axe";

/**
 * T2.21: the report of a finished rehearsal, next to the plan under review. The server here is a
 * fake that stores a few rehearsals and serves their reports as T2.19 will (the stored row plus
 * the reasons it is stale). The reports come from the T1.21 fixtures, so evidence is `fixture`.
 */
const file = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/cases/happy-path.bundle.json", import.meta.url),
    "utf8",
  ),
);
const PLAN = file.bundle.manifest.planId as string;
const HASH = file.planHash as string;
const AT = "2026-10-25T12:00:00.000Z";
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type Served = { report?: ExecutionRehearsalReport; stale?: string[] };

function fakeApi(opts: {
  state?: string;
  detail?: string | null;
  revision?: number;
  scenario?: { id: string; version: number };
  served?: Served;
}) {
  const revision = opts.revision ?? 1;
  const requests: { method: string; path: string }[] = [];
  const rehearsal = {
    rehearsalId: FIXTURE_REHEARSAL_ID,
    plan: { orgId: file.bundle.manifest.orgId, planId: PLAN, revision: 1, planHash: HASH },
    scenario: opts.scenario ?? { id: "clean", version: 1 },
    state: opts.state ?? "completed",
    detail: opts.detail ?? null,
    requestedBy: "user_a",
    requestedAt: AT,
    updatedAt: AT,
  };

  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ method: req.method(), path });
    // A new revision always has a new hash.
    const now = revision === 1 ? HASH : "b".repeat(64);
    const summary = { planId: PLAN, revision, planHash: now, incidentId: null, createdAt: AT };
    if (path === "/api/plans") return json(route, 200, { plans: [summary] });
    if (path === `/api/plans/${PLAN}`)
      return json(route, 200, {
        ...summary,
        manifest: file.bundle.manifest,
        latestRevision: revision,
      });
    if (path === `/api/plans/${PLAN}/approvals`) return json(route, 200, { grants: [] });
    if (path === `/api/plans/${PLAN}/runs`) return json(route, 200, { runs: [] });
    if (path === `/api/plans/${PLAN}/execution-rehearsals`)
      return json(route, 200, { rehearsals: [rehearsal] });
    if (path === `/api/execution-rehearsals/${FIXTURE_REHEARSAL_ID}/report`) {
      if (!opts.served?.report) return json(route, 404, { error: "not_found" });
      return json(route, 200, { report: opts.served.report, stale: opts.served.stale ?? [] });
    }
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests };
}

async function openReport(page: Page, api: ReturnType<typeof fakeApi>) {
  await page.route("**/api/**", (route) => api.handle(route));
  await page.goto("/e2e/live.html");
  await page.getByTestId("exec-report-toggle").click();
  return page.getByTestId("exec-report");
}

test("a benign control reads as expected and still says it approves nothing", async ({ page }) => {
  const scenario = { id: "benign_nonmatching_change", version: 1 } as const;
  const report = { ...rehearsalReportFixture("passed"), scenario };
  const api = fakeApi({ scenario, served: { report } });
  const view = await openReport(page, api);

  await expect(view).toHaveAttribute("data-verdict", "passed");
  await expect(view).toHaveAttribute("data-stale", "false");
  await expect(view).toContainText("Every step read back as expected");
  await expect(view).toContainText("doesn't approve this plan");
  // Steps are named from the plan the report ran on, and show expected and observed.
  await expect(view.getByTestId("exec-report-step").first()).toContainText("Expected");
  await expect(view.getByTestId("exec-report-step").first()).toContainText("Observed");
  // Provenance: evidence level, revision and hash, scenario and its version.
  const provenance = page.getByTestId("exec-report-provenance");
  await expect(provenance).toContainText("Fixture");
  await expect(provenance).toContainText("revision 1");
  await expect(provenance).toContainText("benign_nonmatching_change@1");
  // Reading a report grants and changes nothing.
  expect(api.requests.every((r) => r.method === "GET")).toBe(true);
});

test("a phantom hold that did not happen is a discrepancy, not a pass", async ({ page }) => {
  const report = rehearsalReportFixture("failed");
  const view = await openReport(page, fakeApi({ scenario: report.scenario, served: { report } }));

  await expect(view).toHaveAttribute("data-verdict", "failed");
  await expect(view).not.toContainText("Every step read back as expected");
  const bad = view.locator('[data-verification="mismatched"]').first();
  await expect(bad).toContainText("Not as expected");
  await expect(bad).toContainText("Held");
  await expect(bad).toContainText("Applied");
});

test("a teammate's edit shows the hold and why", async ({ page }) => {
  const base = rehearsalReportFixture("passed");
  const report: ExecutionRehearsalReport = {
    ...base,
    scenario: { id: "teammate_field_edit", version: 1 },
    steps: base.steps.map((s) =>
      s.actionId === "patch_001" && s.result
        ? {
            ...s,
            expected: "held",
            result: {
              ...s.result,
              outcome: "held",
              holdReason: {
                kind: "row_changed",
                observationId: "obs_ticket_1",
                fields: ["priority"],
              },
            },
            verification: { status: "matched", detail: "read back as held" },
          }
        : s,
    ),
  };
  const view = await openReport(page, fakeApi({ scenario: report.scenario, served: { report } }));

  const held = view.locator('[data-action="patch_001"]');
  await expect(held).toContainText("priority changed on the record since approval");
  await expect(held).toContainText("As expected");
});

test("an unresolved write is 'not established', never fine", async ({ page }) => {
  const report = rehearsalReportFixture("unknown");
  const view = await openReport(page, fakeApi({ scenario: report.scenario, served: { report } }));

  await expect(view).toHaveAttribute("data-verdict", "unknown");
  await expect(view).toContainText("could not be established");
  const open = view.locator('[data-verification="unverified"]').first();
  await expect(open).toContainText("Not established");
  await expect(open).toContainText("Outcome unknown");
});

test("a report for an older revision is marked stale next to the newer plan", async ({ page }) => {
  const report = rehearsalReportFixture("passed");
  const api = fakeApi({ revision: 2, served: { report, stale: ["newer_revision"] } });
  const view = await openReport(page, api);

  await expect(view).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("exec-report-stale")).toContainText("newer revision");
  // Step names are not borrowed from a plan the report did not run on.
  await expect(view.getByText("Refund", { exact: true })).toHaveCount(0);
});

test("a failed rehearsal gets a useful view", async ({ page }) => {
  const base = rehearsalReportFixture("unknown");
  const report: ExecutionRehearsalReport = {
    ...base,
    state: "failed",
    steps: base.steps.map((s) => ({
      ...s,
      result: null,
      verification: { status: "unverified", detail: "the run failed before this step" },
    })),
  };
  const api = fakeApi({ state: "failed", detail: "Era was unreachable.", served: { report } });
  const view = await openReport(page, api);

  await expect(view).toContainText("The rehearsal failed before it finished");
  await expect(view.getByText("Never ran").first()).toBeVisible();
});

test("a rehearsal with no stored report says so plainly", async ({ page }) => {
  await openReport(page, fakeApi({ state: "cancelled" }));
  await expect(page.getByTestId("exec-report-error")).toContainText("No report was stored");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the report has no accessibility violations in ${scheme} mode`, async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const report = rehearsalReportFixture("failed");
    const api = fakeApi({
      scenario: report.scenario,
      served: { report, stale: ["policy_changed"] },
    });
    await openReport(page, api);
    expect(await violations(page)).toEqual([]);
    await ctx.close();
  });
}
