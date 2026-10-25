import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type GateSession, openSession } from "../../../scripts/smoke/gate-clerk";

/**
 * The T4.13 gate's review-UI half (G1 and G3; docs/acceptance/T4.13-isolation-recovery-gate.md).
 * The live review page, signed in through real Clerk as the gate's support lead, reads the
 * rehearsals and reports that `pnpm smoke:rehearsal-gate run` left on the real API. Run that
 * first: it writes GATE_STATE_FILE. Every /api call goes to that API with the session's token.
 */
const STATE_FILE = process.env.GATE_STATE_FILE ?? "";
const ENABLED =
  process.env.ERA_REHEARSAL === "1" && !!process.env.DB_TESTS && existsSync(STATE_FILE);
test.skip(!ENABLED, "needs a finished gate run (ERA_REHEARSAL=1, DB_TESTS, GATE_STATE_FILE)");
test.describe.configure({ mode: "serial" });

type GateState = {
  api: string;
  plans: Record<"main" | "prec", string>;
  precedent: string;
  rehearsals: Record<string, string>;
};
const state = (ENABLED ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null) as GateState;
const SHOTS = process.env.GATE_SHOTS ?? join(tmpdir(), "t413-gate-shots");
const LONG = { timeout: 30_000 };
let session: GateSession;

test.beforeAll(async () => {
  const tenant = process.env.ERA_TENANT ?? "";
  if (!/^t413-[a-z0-9-]+$/.test(tenant)) {
    throw new Error(`refusing ERA_TENANT=${tenant}: not a t413- gate tenant`);
  }
  mkdirSync(SHOTS, { recursive: true });
  session = await openSession(
    {
      secretKey: process.env.CLERK_SECRET_KEY ?? "",
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "",
      origin:
        process.env.GATE_ORIGIN ??
        process.env.CLERK_AUTHORIZED_PARTIES?.split(",").at(-1)?.trim() ??
        "http://localhost:5173",
    },
    process.env.GATE_SUPPORT_USER ?? "rehearsal-support",
  );
});

test.afterAll(async () => {
  await session?.revoke();
});

async function openPlan(page: Page, planId: string) {
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers: Record<string, string> = {
      ...req.headers(),
      authorization: `Bearer ${await session.token()}`,
    };
    delete headers["x-test-identity"];
    const response = await route.fetch({
      url: `${state.api}${url.pathname}${url.search}`,
      headers,
    });
    await route.fulfill({ response });
  });
  await page.goto("/e2e/live.html");
  await page
    .getByRole("navigation", { name: "Plans" })
    .getByRole("button", { name: new RegExp(planId) })
    .click();
  await expect(page.getByTestId("exec-rehearsal").first()).toBeVisible(LONG);
}

/** The one rehearsal on screen with this scenario title in this state, and its opened report. */
async function reportOf(page: Page, title: string, rehearsalState: string) {
  const item = page
    .getByTestId("exec-rehearsal")
    .filter({ hasText: title })
    .and(page.locator(`[data-state="${rehearsalState}"]`));
  await expect(item).toHaveCount(1, LONG);
  await item.getByTestId("exec-report-toggle").click();
  const view = item.getByTestId("exec-report");
  await expect(view).toBeVisible(LONG);
  return { item, view };
}

const step = (view: Locator, actionId: string) => view.locator(`[data-action="${actionId}"]`);
const shot = (item: Locator, name: string) => item.screenshot({ path: join(SHOTS, `${name}.png`) });

test("G1: the clean rehearsal shows the verifier's report, labelled as Era evidence", async ({
  page,
}) => {
  await openPlan(page, state.plans.main);
  const { item, view } = await reportOf(page, "Clean control", "completed");
  await expect(item).toHaveAttribute("data-relation", "current");
  await expect(view).toHaveAttribute("data-verdict", "passed");
  await expect(view).toHaveAttribute("data-state", "completed");
  await expect(view).toHaveAttribute("data-stale", "false");
  await expect(view.getByTestId("exec-report-step")).toHaveCount(6);
  await expect(view.locator('[data-verification="matched"]')).toHaveCount(6);
  const provenance = view.getByTestId("exec-report-provenance");
  await expect(provenance).toContainText("Era simulator");
  await expect(provenance).toContainText("verifier@1");
  await expect(provenance).toContainText("clean@1");
  await shot(item, "G1-clean-report");
});

test("G3: the phantom charge holds that refund, with its reason; the other customer proceeds", async ({
  page,
}) => {
  await openPlan(page, state.plans.main);
  const { item, view } = await reportOf(page, "A new duplicate charge appears", "completed");
  await expect(view).toHaveAttribute("data-verdict", "passed");
  const refund = step(view, "refund_001");
  await expect(refund).toContainText("Held");
  await expect(refund).toHaveAttribute("data-verification", "matched");
  await expect(refund).toContainText("New matching record appeared after approval");
  await expect(step(view, "note_001")).toContainText("Skipped");
  await expect(step(view, "refund_002")).toContainText("Applied");
  await expect(view.getByTestId("exec-report-provenance")).toContainText("phantom_membership@1");
  await shot(item, "G3-phantom-report");
});

test("G3: a teammate's edit is kept and the conflict is recorded", async ({ page }) => {
  await openPlan(page, state.plans.main);
  const { item, view } = await reportOf(page, "A teammate edits a ticket", "completed");
  await expect(view).toHaveAttribute("data-verdict", "passed");
  await expect(step(view, "note_001")).toContainText("Refused");
  const patch = step(view, "patch_001");
  await expect(patch).toHaveAttribute("data-verification", "matched");
  await expect(patch).toContainText("changed by someone else");
  await expect(patch).toContainText("compensation conflict");
  await shot(item, "G3-teammate-report");
});

test("G3: the benign control passes with nothing held", async ({ page }) => {
  await openPlan(page, state.plans.main);
  const { item, view } = await reportOf(page, "An unrelated change (control)", "completed");
  await expect(view).toHaveAttribute("data-verdict", "passed");
  await expect(view).toContainText("Every step read back as expected");
  await expect(view).not.toContainText("Held");
  await expect(view.getByTestId("exec-report-provenance")).toContainText(
    "benign_nonmatching_change@1",
  );
  await shot(item, "G3-benign-report");
});

test("G3: a cancelled rehearsal says cancelled, not passed, and shows what ran", async ({
  page,
}) => {
  await openPlan(page, state.plans.main);
  const { item, view } = await reportOf(page, "Clean control", "cancelled");
  await expect(item.getByTestId("exec-rehearsal-say")).toContainText("cancelled");
  await expect(view).toHaveAttribute("data-state", "cancelled");
  await expect(view).not.toHaveAttribute("data-verdict", "passed");
  await expect(view).toContainText("The rehearsal was cancelled");
  await expect(view).not.toContainText("Every step read back as expected");
  await expect(step(view, "refund_001")).toContainText("Applied");
  await expect(step(view, "note_002")).toContainText("Never ran");
  await shot(item, "G3-cancel-report");
});

test("G3: a rehearsal refused for a withdrawn precedent names the precedent and why", async ({
  page,
}) => {
  await openPlan(page, state.plans.prec);
  const item = page.getByTestId("exec-rehearsal").and(page.locator('[data-state="failed"]'));
  await expect(item).toHaveCount(1, LONG);
  await expect(item.getByTestId("exec-rehearsal-say")).toContainText(
    `precedent changed since planning: ${state.precedent} v1 is withdrawn`,
  );
  await shot(item, "G3-precedent-refused");
});
