import { expect, type Route, test } from "@playwright/test";
import { violations } from "./axe";
import { V1, V2_HASH } from "./fake-live-api";

const AT = "2026-10-25T12:00:00.000Z";
const PLAN = "plan_happy";
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type Row = {
  rehearsalId: string;
  plan: { orgId: string; planId: string; revision: number; planHash: string };
  scenario: { id: string; version: number };
  state: string;
  detail: string | null;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
};
const row = (over: Partial<Row> & { rehearsalId: string }): Row => ({
  plan: { orgId: "org_demo", planId: PLAN, revision: 1, planHash: V1.planHash },
  scenario: { id: "clean", version: 1 },
  state: "queued",
  detail: null,
  requestedBy: "user_a",
  requestedAt: AT,
  updatedAt: AT,
  ...over,
});

/**
 * A fake server for the plan page and the execution-rehearsal routes. A new rehearsal walks through
 * `walk` one state per list read; identical requests return the job already admitted, as T2.19 will.
 */
function fakeApi(
  opts: {
    walk?: string[];
    detail?: string;
    refuse?: { status: number; body: object };
    seeded?: Record<string, Row[]>;
    planRevision?: number;
  } = {},
) {
  const walk = opts.walk ?? ["queued", "running", "verifying", "completed"];
  const byIdentity: Record<string, Row[]> = opts.seeded ?? {};
  const steps = new Map<string, number>();
  const requests: { identity: string; method: string; path: string; body: unknown }[] = [];
  let revision = opts.planRevision ?? 1;
  let planHash = V1.planHash;

  async function handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const identity = req.headers()["x-test-identity"] ?? "(none)";
    const body = req.postDataJSON?.() ?? null;
    requests.push({ identity, method: req.method(), path, body });
    const mine = byIdentity[identity] ?? [];
    byIdentity[identity] = mine;
    const summary = {
      planId: PLAN,
      revision,
      planHash,
      incidentId: "INC-BILL-0927",
      createdAt: AT,
    };

    if (path === "/api/plans") return json(route, 200, { plans: [summary] });
    if (path === `/api/plans/${PLAN}`)
      return json(route, 200, {
        ...summary,
        manifest: { ...V1.manifest, revision },
        latestRevision: revision,
      });
    // Excluding steps stores the next revision under a new hash.
    if (path === `/api/plans/${PLAN}/revisions` && req.method() === "POST") {
      const { excludeActionIds } = body as { excludeActionIds: string[] };
      revision += 1;
      planHash = V2_HASH;
      return json(route, 201, {
        planId: PLAN,
        revision,
        parentRevision: revision - 1,
        planHash,
        manifest: { ...V1.manifest, revision },
        createdAt: AT,
        dropped: excludeActionIds.map((actionId) => ({ actionId, reason: "reviewer" })),
      });
    }
    if (path === `/api/plans/${PLAN}/approvals`) return json(route, 200, { grants: [] });
    if (path === `/api/plans/${PLAN}/runs`) return json(route, 200, { runs: [] });

    if (path === `/api/plans/${PLAN}/execution-rehearsals` && req.method() === "GET") {
      // Each read moves running jobs on by one state.
      for (const r of mine) {
        const at = steps.get(r.rehearsalId);
        if (at === undefined) continue;
        const next = Math.min(at + 1, walk.length - 1);
        steps.set(r.rehearsalId, next);
        r.state = walk[next] ?? r.state;
        r.detail = r.state === "failed" ? (opts.detail ?? "the disposable world was busy") : null;
      }
      return json(route, 200, { rehearsals: mine });
    }
    if (path === `/api/plans/${PLAN}/execution-rehearsals`) {
      if (opts.refuse) return json(route, opts.refuse.status, opts.refuse.body);
      const b = body as {
        scenario: { id: string; version: number };
        revision: number;
        planHash: string;
      };
      const same = mine.find(
        (r) => r.scenario.id === b.scenario.id && r.plan.revision === b.revision,
      );
      if (same) return json(route, 200, { rehearsal: same, existing: true });
      const created = row({
        rehearsalId: `rh${String(mine.length + 1).padStart(8, "0")}`,
        scenario: b.scenario,
        plan: { orgId: "org_demo", planId: PLAN, revision: b.revision, planHash: b.planHash },
      });
      mine.push(created);
      steps.set(created.rehearsalId, 0);
      return json(route, 201, { rehearsal: created, existing: false });
    }
    const cancel = /^\/api\/execution-rehearsals\/([^/]+)\/cancel$/.exec(path);
    if (cancel && req.method() === "POST") {
      const r = mine.find((x) => x.rehearsalId === cancel[1]);
      if (!r) return json(route, 404, { error: "rehearsal_not_found" });
      if (["completed", "failed", "cancelled"].includes(r.state)) {
        return json(route, 409, { error: "rehearsal_ended", rehearsal: r });
      }
      steps.delete(r.rehearsalId);
      r.state = "cancelled";
      r.detail = "Anything it had already sent was read back, not re-sent.";
      return json(route, 200, { rehearsal: r });
    }
    return json(route, 404, { error: "not_found" });
  }
  return { handle, requests };
}

const posts = (api: ReturnType<typeof fakeApi>) => api.requests.filter((r) => r.method === "POST");

test("a reviewer starts one rehearsal, follows it to the end, and nothing is approved or applied", async ({
  page,
}) => {
  const api = fakeApi();
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const start = page.getByRole("button", { name: "Rehearse revision 1" });
  await start.waitFor();
  await page.getByLabel(/A new duplicate charge appears/).check();
  // Two quick clicks make one request: the button is busy, then blocked by the job it started.
  await start.dblclick();

  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-state", "completed", { timeout: 15_000 });
  await expect(item).toContainText("A new duplicate charge appears");

  const started = posts(api);
  expect(started).toHaveLength(1);
  expect(started[0]?.path).toBe(`/api/plans/${PLAN}/execution-rehearsals`);
  // References to the stored plan and a scenario, and nothing else.
  expect(started[0]?.body).toEqual({
    planId: PLAN,
    revision: 1,
    planHash: V1.planHash,
    scenario: { id: "phantom_membership", version: 1 },
  });
  // Requesting a rehearsal grants nothing and applies nothing.
  expect(api.requests.some((r) => /approvals|apply/.test(r.path) && r.method === "POST")).toBe(
    false,
  );
});

test("a running rehearsal can be cancelled; it stops, says so, and can be tried again", async ({
  page,
}) => {
  const api = fakeApi({ walk: ["queued", "running"] });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  await page.getByRole("button", { name: "Rehearse revision 1" }).click();
  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-state", "running", { timeout: 15_000 });
  await item.getByRole("button", { name: "Cancel rehearsal" }).click();
  await expect(item).toHaveAttribute("data-state", "cancelled", { timeout: 15_000 });
  await expect(page.getByTestId("exec-rehearsal-say")).toContainText("read back, not re-sent");
  await expect(item.getByRole("button", { name: "Cancel rehearsal" })).toHaveCount(0);
  await expect(item.getByRole("button", { name: /Try again/ })).toBeVisible();

  const cancels = posts(api).filter((r) => r.path.endsWith("/cancel"));
  expect(cancels.map((r) => r.path)).toEqual(["/api/execution-rehearsals/rh00000001/cancel"]);
  expect(api.requests.some((r) => /approvals|apply/.test(r.path) && r.method === "POST")).toBe(
    false,
  );
});

test("a progress state is followed live and a failure says why, with a way to try again", async ({
  page,
}) => {
  const api = fakeApi({
    walk: ["queued", "provisioning", "failed"],
    detail: "Era was unreachable.",
  });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  await page.getByRole("button", { name: "Rehearse revision 1" }).click();
  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-state", "failed", { timeout: 15_000 });
  await expect(page.getByTestId("exec-rehearsal-say")).toContainText("Era was unreachable.");

  // Retrying sends the same request. The server hands back the job it already has; say so.
  await item.getByRole("button", { name: /Try again/ }).click();
  await expect(page.getByTestId("exec-rehearsal-note")).toContainText("already finished");
  expect(posts(api)).toHaveLength(2);
});

test("a rehearsal of an old revision stays tied to it and the new revision needs its own", async ({
  page,
}) => {
  const old = row({ rehearsalId: "rholdrev1", state: "completed" });
  const api = fakeApi({ planRevision: 2, seeded: { "user_a/org_a": [old] } });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-relation", "older_revision");
  await expect(item).toContainText("revision 1");
  await expect(item).toContainText("Not the revision you're reviewing");

  // The start button is for what is on screen (revision 2), not for the old job.
  await page.getByRole("button", { name: "Rehearse revision 2" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(2);
  expect(posts(api)[0]?.body).toMatchObject({ revision: 2 });
});

test("while unchecked boxes have no revision, no history row can start a rehearsal", async ({
  page,
}) => {
  const revision2 = { orgId: "org_demo", planId: PLAN, revision: 2, planHash: V1.planHash };
  const api = fakeApi({
    planRevision: 2,
    seeded: {
      "user_a/org_a": [
        row({ rehearsalId: "rhfailed01", state: "failed", plan: revision2 }),
        row({
          rehearsalId: "rhcancel01",
          state: "cancelled",
          scenario: { id: "phantom_membership", version: 1 },
          plan: revision2,
        }),
        row({ rehearsalId: "rholdrev01", state: "completed" }),
      ],
    },
  });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const items = page.getByTestId("exec-rehearsal");
  await expect(items).toHaveCount(3);
  const rowButtons = page.getByRole("button", { name: /(Try again|Rehearse) on revision 2/ });
  await expect(rowButtons).toHaveCount(3);
  for (const b of await rowButtons.all()) await expect(b).toBeEnabled();

  await page.getByLabel("Include refund_001").uncheck();
  await expect(page.getByRole("button", { name: "Rehearse revision 2" })).toBeDisabled();
  for (const b of await rowButtons.all()) {
    await expect(b).toBeDisabled();
    // A disabled button takes no click, even a forced one.
    await b.click({ force: true });
  }
  await expect(page.getByTestId("exec-rehearsal-row-blocked")).toHaveText(
    Array(3).fill("Create the revision first; a rehearsal runs the exact stored plan."),
  );
  expect(posts(api)).toEqual([]);
});

test("once the revision exists, a history row rehearses that revision and its new hash", async ({
  page,
}) => {
  const api = fakeApi({
    seeded: { "user_a/org_a": [row({ rehearsalId: "rhfailed01", state: "failed" })] },
  });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  const retry = page.getByRole("button", { name: "Try again on revision 1" });
  await page.getByLabel("Include refund_001").uncheck();
  await expect(retry).toBeDisabled();
  await page.getByRole("button", { name: "Create revision 2" }).click();

  const next = page.getByRole("button", { name: "Try again on revision 2" });
  await expect(next).toBeEnabled();
  await expect(page.getByTestId("exec-rehearsal-row-blocked")).toHaveCount(0);
  await next.click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(2);

  const started = posts(api).filter((r) => r.path.endsWith("/execution-rehearsals"));
  // Still references only: the stored plan's new revision and hash, and a scenario.
  expect(started.map((r) => r.body)).toEqual([
    { planId: PLAN, revision: 2, planHash: V2_HASH, scenario: { id: "clean", version: 1 } },
  ]);
  expect(api.requests.some((r) => /approvals|apply/.test(r.path) && r.method === "POST")).toBe(
    false,
  );
});

test("a refusal is explained in plain words", async ({ page }) => {
  const api = fakeApi({
    refuse: { status: 409, body: { error: "stale_revision", latestRevision: 3 } },
  });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Rehearse revision 1" }).click();
  await expect(page.getByTestId("exec-rehearsal-error")).toContainText("A newer revision (3)");
});

test("without server support the panel says so and the plan can still be reviewed", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/execution-rehearsals"))
      return json(route, 501, { error: "not_implemented" });
    return fakeApi().handle(route);
  });
  await page.goto("/e2e/live.html");
  await expect(page.getByTestId("exec-rehearsal-unavailable")).toBeVisible();
  await expect(page.getByTestId("action-row").first()).toBeVisible();
});

test("switching organization drops the previous org's rehearsals and pending state", async ({
  page,
}) => {
  const api = fakeApi({
    seeded: { "user_a/org_a": [row({ rehearsalId: "rhorgaonly", state: "completed" })] },
  });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");

  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(1);
  await page.getByLabel(/An unrelated change/).check();

  await page.getByRole("button", { name: "Switch to org B" }).click();
  await expect(page.getByRole("button", { name: "Rehearse revision 1" })).toBeVisible();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(0);
  // The scenario picked for A is not carried over.
  await expect(page.getByLabel(/Clean control/)).toBeChecked();

  await page.getByRole("button", { name: "Be user A in org A" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the rehearsal panel has no accessibility violations in ${scheme} mode`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const api = fakeApi({
      seeded: {
        "user_a/org_a": [
          row({ rehearsalId: "rhdone0001", state: "completed" }),
          row({ rehearsalId: "rhfail0001", state: "failed", detail: "Era was unreachable." }),
          row({
            rehearsalId: "rhrun00001",
            state: "running",
            scenario: { id: "teammate_field_edit", version: 1 },
          }),
        ],
      },
      planRevision: 2,
    });
    await page.route("**/api/**", api.handle);
    await page.goto("/e2e/live.html");
    await page.getByTestId("exec-rehearsal").first().waitFor();
    expect(await violations(page)).toEqual([]);
    await ctx.close();
  });
}
