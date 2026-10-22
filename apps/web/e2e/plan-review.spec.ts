import { expect, test } from "@playwright/test";

const BUNDLES = ["happy-path", "phantom", "teammate-conflict", "unknown-outcome"];

for (const id of BUNDLES) {
  test(`${id} renders a reviewable plan`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`/?bundle=${id}`);
    await expect(page.getByRole("button", { name: id })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("plan-hash")).toHaveAttribute("title", /^[0-9a-f]{64}$/);
    await expect(page.getByTestId("case-card")).toHaveCount(2);
    await expect(page.getByTestId("action-row")).toHaveCount(6);
    expect(errors).toEqual([]);
  });
}

test("evidence drawer opens for an action and closes with Escape", async ({ page }) => {
  await page.goto("/");
  const refund = page.locator('[data-action-id="refund_002"]');
  await expect(refund).toContainText("$125.00 CAD");
  await expect(refund).toContainText("Finance lead");

  await refund.getByRole("button", { name: /Evidence/ }).click();
  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toContainText("ch_fixture_002");
  await expect(drawer).toContainText("Stripe charges for cus_fixture_002");

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("switching plans updates the URL", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "phantom" }).click();
  await expect(page).toHaveURL(/bundle=phantom/);
  await expect(page.getByText("New matching charge appears after approval")).toBeVisible();
});
