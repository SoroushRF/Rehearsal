import { expect, test } from "@playwright/test";
import { fakeApi, V1, V2_HASH } from "./fake-live-api";

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
  // It floats over the page, in the viewport, rather than sitting at the very end of it.
  await expect(page.getByTestId("exclusion-bar")).toBeInViewport();
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
