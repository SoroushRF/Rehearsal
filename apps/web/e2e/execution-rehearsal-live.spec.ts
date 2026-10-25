import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * T2.20 against the real stack: the API's own routes on Postgres and pg-boss, its operator side
 * holding the rehearsal admin token, and the rehearsal worker process seeding and running each
 * rehearsal in a disposable Era tenant. Only sign-in is a stand-in: the harness's identity buttons
 * map to people a fake IAM verifies with the real rule file. Needs `pnpm infra:up:rehearsal`,
 * Postgres, and REHEARSAL_E2E=1 (see apps/rehearsal-worker/test/stack.ts).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENABLED = process.env.REHEARSAL_E2E === "1";
if (ENABLED && existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);

test.skip(!ENABLED, "needs the real rehearsal stack (REHEARSAL_E2E=1)");
test.describe.configure({ mode: "serial" });

let server: ChildProcess | undefined;
let stack: { api: string; control: string };
let log = "";

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  server = spawn(process.execPath, [tsx, "apps/rehearsal-worker/test/stack-server.ts"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  stack = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`stack didn't start:\n${log}`)), 110_000);
    const read = (d: Buffer) => {
      log += d.toString();
      const line = log.split("\n").find((l) => l.startsWith("STACK "));
      if (line) {
        clearTimeout(timer);
        done(JSON.parse(line.slice(6)));
      }
    };
    server?.stdout?.on("data", read);
    server?.stderr?.on("data", (d: Buffer) => {
      log += d.toString();
    });
    server?.once("exit", (code) => fail(new Error(`stack exited ${code}:\n${log}`)));
  });
});

test.afterAll(() => {
  server?.stdin?.end();
  if (server?.pid && server.exitCode === null && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
  } else server?.kill("SIGTERM");
});

type Summary = { rehearsalId: string; state: string; plan: { revision: number } };

/**
 * Fresh orgs for one test, as the harness names them: user A in org A (with a plan), user A and
 * user C in org B (with their own plan). Every browser /api call goes to the real API as whoever
 * the harness says is signed in.
 */
async function world(page: Page, opts: { refused?: boolean } = {}) {
  const run = randomUUID().slice(0, 8);
  const orgs = { org_a: `org_a_${run}`, org_b: `org_b_${run}` };
  const plans = { org_a: `plan_a_${run}`, org_b: `plan_b_${run}` };
  const register = async (orgId: string, userIds: string[], plan: object) => {
    const res = await fetch(`${stack.control}/org`, {
      method: "POST",
      body: JSON.stringify({ orgId, userIds, plan }),
    });
    return ((await res.json()) as { tokens: Record<string, string> }).tokens;
  };
  const a = await register(orgs.org_a, ["user_a"], { planId: plans.org_a, ...opts });
  const b = await register(orgs.org_b, ["user_a", "user_c"], { planId: plans.org_b });
  const tokens: Record<string, string | undefined> = {
    "user_a/org_a": a.user_a,
    "user_a/org_b": b.user_a,
    "user_c/org_b": b.user_c,
  };
  const sent: { method: string; path: string }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    sent.push({ method: req.method(), path: url.pathname });
    const headers = { ...req.headers() };
    const token = tokens[headers["x-test-identity"] ?? ""];
    delete headers["x-test-identity"];
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await route.fetch({
      url: `${stack.api}${url.pathname}${url.search}`,
      headers,
    });
    await route.fulfill({ response });
  });
  const api = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`${stack.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${a.user_a}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const rehearsals = async () =>
    (await api("GET", `/api/plans/${plans.org_a}/execution-rehearsals`)).rehearsals as Summary[];
  return { plans, sent, api, rehearsals };
}

const LONG = { timeout: 60_000 };

test("a reviewer starts one clean rehearsal, follows it to the end, and nothing is approved or applied", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const w = await world(page);
  await page.goto("/e2e/live.html");
  const start = page.getByRole("button", { name: "Rehearse revision 1" });
  await start.waitFor();
  await expect(page.getByLabel(/Clean control/)).toBeChecked();
  // Two quick clicks make one rehearsal on the real server.
  await start.dblclick();

  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-state", "completed", LONG);
  await expect(item).toHaveAttribute("data-relation", "current");
  const stored = await w.rehearsals();
  expect(stored).toHaveLength(1);
  expect(stored[0]?.state).toBe("completed");
  // Rehearsing grants nothing and applies nothing.
  expect(w.sent.some((r) => r.method === "POST" && /approvals|apply/.test(r.path))).toBe(false);
  expect((await w.api("GET", `/api/plans/${w.plans.org_a}/approvals`)).grants).toEqual([]);
  expect((await w.api("GET", `/api/plans/${w.plans.org_a}/runs`)).runs).toEqual([]);
});

test("a rehearsal the worker can't seed fails, says why, and trying again starts a new one", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const w = await world(page, { refused: true });
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Rehearse revision 1" }).click();

  const item = page.getByTestId("exec-rehearsal");
  await expect(item).toHaveAttribute("data-state", "failed", LONG);
  await expect(page.getByTestId("exec-rehearsal-say")).toContainText("not in evidence");

  await item.getByRole("button", { name: /Try again/ }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(2, LONG);
  await expect(page.getByTestId("exec-rehearsal").first()).toHaveAttribute(
    "data-state",
    "failed",
    LONG,
  );
  const stored = await w.rehearsals();
  expect(stored.map((r) => r.state)).toEqual(["failed", "failed"]);
});

test("a revision made elsewhere stops a stale start; the old rehearsal stays tied to its revision", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const w = await world(page);
  await page.goto("/e2e/live.html");
  const start = page.getByRole("button", { name: "Rehearse revision 1" });
  await start.click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveAttribute("data-state", "completed", LONG);

  // Someone else drops refund_001 (and its note), behind this page's back.
  const plan = await w.api("GET", `/api/plans/${w.plans.org_a}`);
  const revised = await w.api("POST", `/api/plans/${w.plans.org_a}/revisions`, {
    baseRevision: 1,
    basePlanHash: plan.planHash,
    excludeActionIds: ["refund_001"],
  });
  expect(revised.revision).toBe(2);
  await start.click();
  await expect(page.getByTestId("exec-rehearsal-error")).toContainText("A newer revision (2)");

  await page.reload();
  const old = page.getByTestId("exec-rehearsal");
  await expect(old).toHaveAttribute("data-relation", "older_revision");
  await expect(old).toContainText("Not the revision you're reviewing");
  await page.getByRole("button", { name: "Rehearse revision 2" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(2, LONG);
  const current = page.locator('[data-testid="exec-rehearsal"][data-relation="current"]');
  await expect(current).toHaveAttribute("data-state", "completed", LONG);
  const stored = await w.rehearsals();
  expect(stored.map((r) => [r.plan.revision, r.state])).toEqual([
    [1, "completed"],
    [2, "completed"],
  ]);
});

test("switching organization shows only that org's rehearsals", async ({ page }) => {
  test.setTimeout(90_000);
  await world(page);
  await page.goto("/e2e/live.html");
  await page.getByRole("button", { name: "Rehearse revision 1" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveAttribute("data-state", "completed", LONG);

  await page.getByRole("button", { name: "Switch to org B" }).click();
  await expect(page.getByRole("button", { name: "Rehearse revision 1" })).toBeVisible();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in as user C in org B" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(0);

  await page.getByRole("button", { name: "Be user A in org A" }).click();
  await expect(page.getByTestId("exec-rehearsal")).toHaveCount(1);
  await expect(page.getByTestId("exec-rehearsal")).toHaveAttribute("data-state", "completed");
});
