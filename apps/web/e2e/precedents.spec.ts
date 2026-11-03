import { expect, type Page, test } from "@playwright/test";
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

/** Open the promote panel on a completed run and fill the draft. */
async function draftPrecedent(page: Page, api: ReturnType<typeof fakeApi>) {
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Apply to production" }).click();
  const panel = page.getByTestId("precedent-panel");
  await panel.getByText("Precedents: promote what this run decided").click();
  await panel.getByLabel("Name (a short slug)").fill("late-duplicate-refund");
  await panel
    .getByLabel("What was decided")
    .fill("A duplicate charge under 20.00 CAD is credited, not refunded.");
  return panel;
}

test("the promote panel shows similar active precedents, and promotion still works", async ({
  page,
}) => {
  const api = fakeApi({ completedRun: true, activePrecedent: true, similar: "hit" });
  const panel = await draftPrecedent(page, api);

  const hint = panel.getByTestId("similar-precedents");
  await expect(hint).toHaveAttribute("data-state", "ok");
  const item = hint.getByTestId("similar-precedent");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("duplicate-charge-refund v1");
  await expect(item).toContainText("A duplicate charge within 30 days is refunded in full.");
  await expect(hint).toContainText("Promoting doesn't change or withdraw these");
  expect(await violations(page)).toEqual([]);

  // Advisory: the button is live, the request carries only the draft, and the promotion goes out
  // exactly as it does without the hint.
  const promote = panel.getByRole("button", { name: "Promote to precedent" });
  await expect(promote).toBeEnabled();
  const ask = api.requests.find((r) => r.path === "/api/runs/run_1/precedents/similar");
  expect(Object.keys((ask as { body: object }).body).sort()).toEqual([
    "appliesTo",
    "id",
    "statement",
  ]);
  await promote.click();
  await expect(page.getByTestId("promoted")).toContainText("late-duplicate-refund v1 approved");
  const post = api.requests.find((r) => r.path === "/api/runs/run_1/precedents");
  expect(Object.keys((post as { body: object }).body)).not.toContain("similar");
});

for (const similar of ["off", "unavailable", "error"] as const) {
  test(`with the hint ${similar === "off" ? "off because memory is off" : similar === "unavailable" ? "unavailable because recall failed" : "failing outright"}, the panel says so and promotion works as before`, async ({
    page,
  }) => {
    const api = fakeApi({ completedRun: true, similar });
    const panel = await draftPrecedent(page, api);

    const hint = panel.getByTestId("similar-precedents");
    await expect(hint).toHaveAttribute("data-state", similar === "error" ? "failed" : similar);
    await expect(hint).toContainText(
      similar === "off" ? "Agent Memory is off" : "Couldn't check for similar precedents",
    );
    await expect(hint.getByTestId("similar-precedent")).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await panel.getByRole("button", { name: "Promote to precedent" }).click();
    await expect(page.getByTestId("promoted")).toContainText("late-duplicate-refund v1 approved");
    await expect(panel.getByTestId("precedent")).toHaveAttribute("data-status", "waiting");
  });
}

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

test("a finance lead withdraws an active precedent, with a second click to confirm", async ({
  page,
}) => {
  const api = fakeApi({ completedRun: true, activePrecedent: true });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Approve revision 1" }).click();
  await page.getByRole("button", { name: "Apply to production" }).click();

  const panel = page.getByTestId("precedent-panel");
  await panel.getByText("Precedents: promote what this run decided").click();
  const row = panel.getByTestId("precedent");
  await expect(row).toHaveAttribute("data-status", "active");

  // The first click only asks; nothing is sent until the withdrawal is confirmed.
  await row.getByRole("button", { name: "Withdraw" }).click();
  await expect(
    row.getByRole("group", { name: "Withdraw duplicate-charge-refund v1" }),
  ).toBeVisible();
  expect(api.requests.some((r) => r.path.endsWith("/withdraw"))).toBe(false);
  expect(await violations(page)).toEqual([]);
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByRole("button", { name: "Withdraw" })).toBeVisible();

  await row.getByRole("button", { name: "Withdraw" }).click();
  await row.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(row).toHaveAttribute("data-status", "withdrawn");
  await expect(row).toContainText("Withdrawn");
  await expect(row.getByRole("button", { name: "Withdraw" })).toHaveCount(0);

  // It names the version the reviewer saw, so a stale page can't withdraw a newer one.
  const post = api.requests.find((r) => r.path.endsWith("/withdraw"));
  expect(post?.body).toEqual({ version: 1 });
});

test("a plan citing a precedent shows its trace, and can be approved while it holds", async ({
  page,
}) => {
  const api = fakeApi({ citesPrecedent: "holds" });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const card = page.getByTestId("precedent-basis");
  await expect(card).toContainText("duplicate-charge-refund v2");
  await expect(card).toContainText("trace_abc");
  await expect(card).toContainText("All still in force");
  // The cited facts trace to the approved version, its promoter and its source run (T2.31).
  await expect(card.getByTestId("citation-source")).toHaveAttribute("data-source", "matched");
  await expect(card).toContainText("promoted by user_finance on 2026-10-25 from run run_0");
  await expect(page.getByTestId("precedent-hold")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve revision 1" })).toBeEnabled();
});

test("a plan citing a precedent says why it was recalled, collapsed until asked (T1.54)", async ({
  page,
}) => {
  const api = fakeApi({ citesPrecedent: "holds" });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const why = page.getByTestId("recall-diagnostics");
  await expect(why).toBeVisible();
  await expect(why.getByTestId("recall-area")).toBeHidden();
  await why.getByText("Why these precedents").click();
  const area = why.getByTestId("recall-area");
  await expect(area).toHaveAttribute("data-area", "billing.duplicate_charge");
  await expect(area).toContainText("recall asked “billing.duplicate_charge”");
  await expect(area).toContainText("trace trace_abc");
  const hit = area.getByTestId("recall-hit");
  await expect(hit).toHaveAttribute("data-cited", "true");
  await expect(hit).toContainText("duplicate-charge-refund v2");
  await expect(hit).toContainText("fact_1");
  await expect(area.getByTestId("recall-drop")).toContainText(
    "Dropped late-fee-waiver by Agent Memory's copy: withdrawn at v1",
  );
  expect(await violations(page)).toEqual([]);
  // Nothing about it is sent back: the browser only reads it.
  expect(api.requests.every((r) => r.method === "GET" || !r.path.startsWith("/api/plans"))).toBe(
    true,
  );
});

test("a plan whose cited precedent was replaced says why and can't be approved", async ({
  page,
}) => {
  const api = fakeApi({ citesPrecedent: "held" });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const card = page.getByTestId("precedent-basis");
  await expect(card).toContainText("Changed since planning");
  await expect(card.getByTestId("citation")).toHaveAttribute("data-held", "true");
  await expect(card).toContainText("duplicate-charge-refund v2 was replaced by v3");
  await expect(card).toContainText("precedents the planner may never have seen");

  await expect(page.getByTestId("precedent-hold")).toContainText("Can't approve yet");
  await expect(page.getByRole("button", { name: "Approve revision 1" })).toBeDisabled();
  expect(await violations(page)).toEqual([]);
  // Nothing was sent to approve it.
  expect(api.requests.some((r) => r.method === "POST" && r.path.endsWith("/approvals"))).toBe(
    false,
  );
});

test("a plan that cited nothing looks exactly as before", async ({ page }) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await expect(page.getByTestId("precedent-basis")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve revision 1" })).toBeEnabled();
});
