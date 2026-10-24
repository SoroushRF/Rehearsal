import { expect, test } from "@playwright/test";
import { violations } from "./axe";
import { fakeApi } from "./fake-live-api";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    // Reduced motion also stops the page fade-in, which would otherwise be measured half-faded.
    test.use({ colorScheme: scheme, reducedMotion: "reduce" });

    test("a fixture plan has no accessibility violations", async ({ page }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?bundle=phantom");
      await page.getByTestId("action-row").first().waitFor();
      expect(await violations(page)).toEqual([]);
    });

    test("the evidence drawer has no accessibility violations", async ({ page }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?bundle=happy-path");
      await page
        .getByTestId("action-row")
        .first()
        .getByRole("button", { name: /Evidence/ })
        .click();
      await page.getByTestId("evidence-drawer").waitFor();
      await page.waitForTimeout(400);
      expect(await violations(page)).toEqual([]);
    });

    test("the live review flow has none at any step", async ({ page }) => {
      await page.route("**/api/**", fakeApi().handle);
      await page.goto("/e2e/live.html");
      await page.getByTestId("action-row").first().waitFor();
      expect(await violations(page), "the plan").toEqual([]);

      await page.getByLabel("Include refund_001").uncheck();
      await page.getByTestId("exclusion-bar").waitFor();
      expect(await violations(page), "with the floating bar").toEqual([]);

      await page.getByRole("button", { name: "Create revision 2" }).click();
      await page.getByRole("button", { name: "Approve revision 2" }).click();
      await page.getByRole("alert").waitFor();
      expect(await violations(page), "a refused approval").toEqual([]);

      await page.getByRole("button", { name: "Approve revision 2" }).click();
      await page.getByRole("button", { name: "Apply to production" }).click();
      await page.getByTestId("run-report").waitFor();
      expect(await violations(page), "the approved plan and its run").toEqual([]);
    });

    test("a saved replay has no accessibility violations", async ({ page }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?replay=phantom");
      await page.getByTestId("run-report").waitFor();
      expect(await violations(page)).toEqual([]);
    });
  });
}
