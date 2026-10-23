import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test } from "@playwright/test";

const file = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/cases/happy-path.bundle.json", import.meta.url),
    "utf8",
  ),
);
const AT = "2026-10-23T12:00:00.000Z";
const HASH = "c".repeat(64);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * A fake planner API. The rehearsal walks through `states`, one per poll, and a plan appears in
 * the org's list only once it reaches "stored".
 */
function fakeApi(opts: { states: object[]; refuseStart?: { status: number; error: string } }) {
  let started = 0;
  let polls = 0;
  let stored = false;
  const requests: { method: string; path: string; body: unknown }[] = [];

  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });

    if (path === "/api/plans") {
      const plans = stored
        ? [
            {
              planId: "plan_new",
              revision: 1,
              planHash: HASH,
              incidentId: "INC-BILL-0927",
              createdAt: AT,
            },
          ]
        : [];
      return json(route, 200, { plans });
    }
    if (path === "/api/plans/plan_new") {
      return json(route, 200, {
        planId: "plan_new",
        revision: 1,
        planHash: HASH,
        manifest: { ...file.bundle.manifest, planId: "plan_new" },
        createdAt: AT,
        latestRevision: 1,
      });
    }
    if (path === "/api/plans/plan_new/approvals") return json(route, 200, { grants: [] });
    if (path === "/api/plans/plan_new/runs") return json(route, 200, { runs: [] });

    if (path === "/api/incidents/INC-BILL-0927/rehearse") {
      if (opts.refuseStart)
        return json(route, opts.refuseStart.status, { error: opts.refuseStart.error });
      started++;
      return json(route, 202, { rehearsalId: "job_1", planId: "plan_new", state: "queued" });
    }
    if (path === "/api/rehearsals/job_1") {
      const state = opts.states[Math.min(polls++, opts.states.length - 1)] as { state: string };
      if (state.state === "stored") stored = true;
      return json(route, 200, {
        rehearsalId: "job_1",
        planId: "plan_new",
        incidentId: "INC-BILL-0927",
        ...state,
      });
    }
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests, started: () => started };
}

async function open(page: Page, api: ReturnType<typeof fakeApi>) {
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
}
const button = (page: Page) => page.getByRole("button", { name: "Rehearse INC-BILL-0927" });

test("rehearsing follows the planner and shows the plan once it is stored", async ({ page }) => {
  const api = fakeApi({
    states: [
      { state: "queued" },
      { state: "planning" },
      { state: "stored", planHash: HASH, summary: "Two duplicate charges; refund both." },
    ],
  });
  await open(page, api);
  await expect(page.getByText("No plans for this organization yet.")).toBeVisible();

  await button(page).click();
  // One at a time: the button is off while the planner works.
  await expect(button(page)).toBeDisabled();
  await expect(page.getByTestId("rehearsal-state")).toContainText(
    "Waiting for the planner to pick this up",
  );
  await expect(page.getByTestId("rehearsal-state")).toContainText("The agent is planning");

  await expect(page.getByTestId("rehearsal-state")).toContainText("Plan stored.");
  await expect(
    page.getByText("Planner's summary: Two duplicate charges; refund both."),
  ).toBeVisible();
  // The new plan is listed and already selected, with its actions on screen.
  await expect(page.getByRole("button", { name: /plan_new/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("action-row")).toHaveCount(6);
  await expect(button(page)).toBeEnabled();

  // The browser asked for the incident by ID and sent nothing else.
  const posts = api.requests.filter((r) => r.method === "POST");
  expect(posts.map((p) => [p.path, p.body])).toEqual([
    ["/api/incidents/INC-BILL-0927/rehearse", {}],
  ]);
  expect(api.started()).toBe(1);
});

test("a failed rehearsal says why and can be tried again", async ({ page }) => {
  const api = fakeApi({
    states: [
      { state: "planning" },
      { state: "failed", error: { reason: "rejected_plan", message: "plan has no steps" } },
    ],
  });
  await open(page, api);

  await button(page).click();
  await expect(page.getByTestId("rehearsal-state")).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("rehearsal-state")).toContainText("Planning failed.");
  await expect(page.getByTestId("rehearsal-state")).toContainText(
    "rejected_plan: plan has no steps",
  );
  await expect(page.getByRole("button", { name: /plan_new/ })).toHaveCount(0);
  await expect(button(page)).toBeEnabled();
});

test("a retry is shown while it is still running", async ({ page }) => {
  const api = fakeApi({
    states: [
      { state: "retrying", error: { reason: "timeout", message: "model took too long" } },
      { state: "retrying", error: { reason: "timeout", message: "model took too long" } },
    ],
  });
  await open(page, api);
  await button(page).click();
  await expect(page.getByTestId("rehearsal-state")).toContainText("trying once more");
  await expect(page.getByTestId("rehearsal-state")).toContainText("timeout: model took too long");
  await expect(button(page)).toBeDisabled();
});

test("a read-only role gets a clear refusal", async ({ page }) => {
  const api = fakeApi({ states: [], refuseStart: { status: 403, error: "forbidden" } });
  await open(page, api);
  await button(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Your role can read plans but not ask for a rehearsal.",
  );
  await expect(button(page)).toBeEnabled();
});
