import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Automated accessibility check (WCAG 2.1 A/AA rules, including color contrast) on each page, in
 * light and dark. It catches contrast, labels, roles and names; it doesn't replace keyboard and
 * screen-reader testing.
 */
export async function violations(page: Page) {
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
