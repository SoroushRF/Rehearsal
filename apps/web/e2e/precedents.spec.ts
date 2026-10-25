import { expect, test } from "@playwright/test";
import { violations } from "./axe";
import { fakeApi } from "./fake-live-api";

test("a finance lead promotes a precedent from a completed run and sees it waiting", async ({
  page,
}) => {
  const api = fakeApi({ completedRun: true });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  // Sign off and apply, as the other live specs do, to get a completed run on the page.
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Apply to production" }).click();
  await expect(page.getByTestId("run-report")).toBeVisible();

  const panel = page.getByTestId("precedent-panel");
  await panel.getByText("Precedents: promote what this run decided").click();
  await expect(panel.getByText("No precedents promoted yet.")).toBeVisible();

  await panel.getByLabel("Name (a short slug)").fill("duplicate-charge-refund");
  await panel
    .getByLabel("What was decided")
    .fill("A duplicate charge within 30 days is refunded in full.");
  await panel
    .getByLabel("Conditions (one per line)")
    .fill("same amount and customer\nneither disputed");
  await panel.getByRole("button", { name: "Promote to precedent" }).click();

  await expect(page.getByTestId("promoted")).toContainText("duplicate-charge-refund v1 approved");
  const row = panel.getByTestId("precedent");
  await expect(row).toHaveAttribute("data-status", "waiting");
  await expect(row).toContainText("Waiting for sync");
  await expect(page.getByTestId("sync-off")).toContainText("Agent Memory isn't set up");
  expect(await violations(page)).toEqual([]);

  // The browser sends only what finance specified: no author, version or approval time.
  const post = api.requests.find((r) => r.path === "/api/runs/run_1/precedents");
  expect(post).toBeDefined();
  expect(Object.keys((post as { body: object }).body).sort()).toEqual([
    "appliesTo",
    "conditions",
    "effectiveFrom",
    "effectiveUntil",
    "exceptions",
    "id",
    "statement",
  ]);
  expect((post as { body: { conditions: string[] } }).body.conditions).toEqual([
    "same amount and customer",
    "neither disputed",
  ]);
});

test("a run that hasn't completed offers no form", async ({ page }) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Apply to production" }).click();
  const panel = page.getByTestId("precedent-panel");
  await panel.getByText("Precedents: promote what this run decided").click();
  await expect(panel).toContainText("This run hasn't completed");
  await expect(panel.getByRole("button", { name: "Promote to precedent" })).toHaveCount(0);
});
