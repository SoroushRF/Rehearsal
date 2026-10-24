import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { fakeApi } from "./fake-live-api";

/**
 * Automated accessibility check (WCAG 2.1 A/AA rules, including color contrast) on each page, in
 * light and dark. It catches contrast, labels, roles and names; it doesn't replace keyboard and
 * screen-reader testing.
 */
async function violations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes
      .slice(0, 4)
      .map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`),
  }));
}

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
