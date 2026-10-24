import { expect, test } from "@playwright/test";
import { violations } from "./axe";
import { fakeApi } from "./fake-live-api";

test("two different people sign their seats before the plan can be applied", async ({ page }) => {
  const api = fakeApi({ dual: true });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const seat = (role: string) => page.locator(`[data-testid="approval-seat"][data-seat="${role}"]`);
  await expect(seat("support_lead")).toHaveAttribute("data-signed", "false");
  await expect(seat("finance_lead")).toHaveAttribute("data-signed", "false");
  await expect(page.getByLabel("Approval")).toContainText("two different people");
  await expect(page.getByRole("button", { name: "Apply to production" })).toHaveCount(0);

  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await expect(seat("support_lead")).toHaveAttribute("data-signed", "true");
  await expect(seat("support_lead")).toContainText("user_support");
  await expect(seat("finance_lead")).toHaveAttribute("data-signed", "false");
  // One signature isn't an approval: nothing to apply yet, and the button asks for the other seat.
  await expect(page.getByRole("button", { name: "Apply to production" })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);

  await page.getByRole("button", { name: "Add my approval revision 1" }).click();
  await expect(seat("finance_lead")).toContainText("user_finance");
  await expect(page.getByTestId("live-grant")).toContainText("user_support and user_finance");
  await expect(page.getByRole("button", { name: "Apply to production" })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
