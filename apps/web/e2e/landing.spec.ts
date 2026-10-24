import { expect, test } from "@playwright/test";
import { violations } from "./axe";

test("the landing page is public and static: no API call, no sign-in", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: /Terraform plan\s*for AI agents/ }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Rehearsal: terraform plan for AI agents");
  // One h1, and each section is headed.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  for (const name of [
    "Deciding and doing shouldn't happen in the same step",
    "Plan in a copy, approve once, apply with no model",
    "What happens when the world moves",
    "Rules the engine never bends",
    "Honest about the limits",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test("the buttons lead to the example plan, the saved replay and the app", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open the example plan" }).first().click();
  await expect(page).toHaveURL(/\/app\?bundle=happy-path$/);
  await expect(page.getByTestId("plan-hash")).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Watch a saved replay" }).first().click();
  await expect(page).toHaveURL(/\?replay=phantom$/);
  await expect(page.getByTestId("replay-banner")).toBeVisible();

  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Open the app" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("Example plan")).toBeVisible();
});

test("older links keep working: /?bundle and /?replay are still the app and the replay", async ({
  page,
}) => {
  await page.goto("/?bundle=phantom");
  await expect(page.getByTestId("plan-hash")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await page.goto("/?replay=happy-path");
  await expect(page.getByTestId("replay-banner")).toBeVisible();
});

test("the section links scroll to their section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Guarantees" })
    .click();
  await expect(page).toHaveURL(/#guarantees$/);
  await expect(
    page.getByRole("heading", { name: "Rules the engine never bends" }),
  ).toBeInViewport();
});

test("nothing overflows sideways on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [label, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    test(`no accessibility violations: ${scheme}, ${label}`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport,
      });
      const page = await context.newPage();
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();
      expect(await violations(page)).toEqual([]);
      await context.close();
    });
  }
}
