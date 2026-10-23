import { expect, test } from "@playwright/test";

/** The page is public and static: every API call is refused, and it must not matter. */
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
});

test("a saved phantom run opens with no API and no sign-in, labelled as saved", async ({
  page,
}) => {
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/?replay=phantom");

  const banner = page.getByTestId("replay-banner");
  await expect(banner).toContainText("Saved replay, not live");
  await expect(banner).toContainText("Fixture");
  await expect(banner).toContainText("Nothing here can be changed or applied.");

  // The run, step by step: the new duplicate charge held case 001's refund and its note.
  const report = page.getByTestId("run-report");
  await expect(report).toContainText("partial");
  await expect(report.locator('[data-action-id="refund_001"]')).toContainText(
    "New matching record appeared after approval (ch_fixture_001_dup)",
  );
  await expect(report.locator('[data-action-id="note_001"]')).toContainText(
    "Waits for refund_001, which didn't complete.",
  );
  await expect(report.locator('[data-action-id="refund_002"]')).toHaveAttribute(
    "data-outcome",
    "confirmed",
  );

  // Read-only: nothing to change, approve or apply.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Approve|Apply|Rehearse|Sign in/ })).toHaveCount(0);
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test("replays can be switched, and an unknown one says so", async ({ page }) => {
  await page.goto("/?replay=phantom");
  await page.getByRole("link", { name: "happy-path" }).click();
  await expect(page).toHaveURL(/replay=happy-path/);
  await expect(page.getByTestId("run-report")).toContainText("completed");
  await expect(page.getByTestId("replay-banner")).toBeVisible();

  await page.goto("/?replay=does-not-exist");
  await expect(page.getByRole("alert")).toContainText("This saved replay can't be shown");
});

test("the live page is untouched without ?replay", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "happy-path" })).toBeVisible();
  await expect(page.getByTestId("replay-banner")).toHaveCount(0);
});
