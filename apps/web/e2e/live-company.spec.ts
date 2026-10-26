import { expect, type Page, type Route, test } from "@playwright/test";
import { violations } from "./axe";

const AT = "2026-10-25T14:00:00.000Z";
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const OWNER = {
  userId: "user_a",
  orgId: "org_a",
  clerkRole: "org:owner",
  permissions: ["rehearsal:read:plan", "rehearsal:rehearse:incident", "rehearsal:invite:member"],
};

const company = (refunded: number, changed: Record<string, string>) => ({
  asOf: refunded ? "2026-10-25T14:05:00.000Z" : AT,
  charges: [
    {
      id: "ch_dup_2",
      customer: "cus_a",
      invoice: "in_1",
      amountMinor: 4210,
      currency: "cad",
      created: "2026-09-27T15:02:11Z",
      refundedMinor: refunded,
    },
    {
      id: "ch_dup_1",
      customer: "cus_a",
      invoice: "in_1",
      amountMinor: 4210,
      currency: "cad",
      created: "2026-09-27T15:02:09Z",
      refundedMinor: 0,
    },
  ],
  customers: [{ id: "cus_a", email: "maya@northwind.example", balanceMinor: 0 }],
  tickets: [
    {
      id: 4102,
      subject: "Charged twice",
      status: "open",
      priority: "normal",
      requester: "maya@northwind.example",
      updatedAt: AT,
    },
  ],
  slack: [],
  changed,
});

/** The live routes, with `GET /api/company` and the incident routes deployed. */
function fakeApi(opts: { deployed: boolean }) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const incidents: object[] = [];
  let applied = false;

  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    if (path === "/api/me") return json(route, 200, OWNER);
    if (path === "/api/plans") return json(route, 200, { plans: [] });
    if (!opts.deployed) return json(route, 404, { error: "not_found" });

    if (path === "/api/company")
      return json(route, 200, applied ? company(4210, { ch_dup_2: "run_1" }) : company(0, {}));
    if (path === "/api/company/problems") {
      applied = true; // stands in for any change to the world, so the refetch differs
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/incidents" && req.method() === "POST") {
      const draft = req.postDataJSON();
      const stored = { ...draft, incidentId: "INC-BILL-1031", orgId: "org_a", createdAt: AT };
      incidents.unshift(stored);
      return json(route, 201, stored);
    }
    if (path === "/api/incidents") return json(route, 200, incidents);
    if (path === "/api/incidents/INC-BILL-1031/rehearse")
      return json(route, 202, { rehearsalId: "job_1", planId: "plan_new", state: "queued" });
    if (path === "/api/rehearsals/job_1")
      return json(route, 200, { rehearsalId: "job_1", planId: "plan_new", state: "planning" });
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests };
}

async function open(page: Page, api: ReturnType<typeof fakeApi>, view = "company") {
  await page.route("**/api/**", api.handle);
  await page.goto(`/e2e/live.html?view=${view}`);
}

test("before the routes are deployed, the overview shows the labelled fixture", async ({
  page,
}) => {
  await open(page, fakeApi({ deployed: false }));
  const overview = page.getByRole("region", { name: "Company" });
  await expect(overview.getByText("fixture", { exact: true })).toBeVisible();
  await expect(overview.getByRole("tab", { name: /Charges/ })).toBeVisible();
  // No problem button where nothing would create one.
  await expect(page.getByRole("button", { name: "Create problem" })).toHaveCount(0);
});

test("a changed row is marked with its run after the world changes", async ({ page }) => {
  const api = fakeApi({ deployed: true });
  await open(page, api);
  const row = page.locator('[data-testid="company-row"][data-id="ch_dup_2"]');
  await expect(row).toHaveAttribute("data-changed", "false");

  await page.getByRole("button", { name: "Create problem" }).click();
  await expect(row).toHaveAttribute("data-changed", "true");
  await expect(row.getByRole("button", { name: "run_1" })).toBeVisible();
  // The previous load had this charge unrefunded: old → new.
  await expect(row).toContainText("changed to");
  await page.screenshot({ path: "node_modules/.cache/playwright/shots/company-changed.png" });
  expect(api.requests.find((r) => r.path === "/api/company/problems")?.body).toEqual({
    preset: "duplicate_charge",
    count: 3,
  });
});

test("file an incident, then rehearse it from its row by ID only", async ({ page }) => {
  const api = fakeApi({ deployed: true });
  await open(page, api, "incidents");
  await page.getByLabel("Title").fill("Second batch of double charges");
  await page.getByLabel("Description").fill("Harbor Labs was charged twice on Sep 27.");
  await page.getByRole("button", { name: "File incident" }).click();
  await expect(page.getByTestId("incident-filed")).toContainText("INC-BILL-1031");

  const row = page.locator('[data-testid="incident-row"][data-incident="INC-BILL-1031"]');
  await expect(row).toContainText("2026-09-01 – 2026-09-30");
  await row.getByRole("button", { name: "Rehearse" }).click();

  await expect(page).toHaveURL(/view=plans/);
  await expect(page.getByTestId("rehearsal-state")).toContainText("The agent is planning");
  await expect(page.getByTestId("process-slot")).toHaveAttribute("data-active", "2");

  const posts = api.requests.filter((r) => r.method === "POST");
  expect(posts.map((p) => [p.path, p.body])).toEqual([
    [
      "/api/incidents",
      {
        kind: "duplicate_charge",
        title: "Second batch of double charges",
        description: "Harbor Labs was charged twice on Sep 27.",
        window: { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" },
      },
    ],
    // Exactly one rehearsal, and the browser sends nothing but the ID.
    ["/api/incidents/INC-BILL-1031/rehearse", {}],
  ]);
});

for (const scheme of ["light", "dark"] as const) {
  for (const view of ["company", "incidents"] as const) {
    test(`${view}: no accessibility violations or sideways scroll on a phone, ${scheme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await open(page, fakeApi({ deployed: true }), view);
      await page.getByRole("heading", { level: 2 }).first().waitFor();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await violations(page)).toEqual([]);
      await page.screenshot({
        path: `node_modules/.cache/playwright/shots/${view}-${scheme}-phone.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: `node_modules/.cache/playwright/shots/${view}-${scheme}-desktop.png`,
        fullPage: true,
      });
      await context.close();
    });
  }
}
