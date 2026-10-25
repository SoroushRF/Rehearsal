import { expect, test } from "@playwright/test";
import { violations } from "./axe";
import { fakeApi } from "./fake-live-api";

const MEMBER = {
  clerkRole: "org:member",
  permissions: ["rehearsal:read:plan", "rehearsal:read:run", "rehearsal:read:precedent"],
};

const OWNER = {
  clerkRole: "org:owner",
  permissions: [
    ...MEMBER.permissions,
    "rehearsal:invite:member",
    "rehearsal:manage:role",
    "rehearsal:approve:support_step",
    "rehearsal:approve:finance_step",
    "rehearsal:apply:plan",
    "rehearsal:cancel:run",
    "rehearsal:revoke:any_grant",
    "rehearsal:rehearse:incident",
  ],
};

test("a member without invite permission does not see an invite form", async ({ page }) => {
  await page.route("**/api/**", fakeApi({ me: MEMBER }).handle);
  await page.goto("/e2e/live.html");
  await page.getByTestId("action-row").first().waitFor();
  await expect(page.getByTestId("access")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("invite-form")).toHaveCount(0);
  await expect(page.getByTestId("role-form")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test("an owner can invite a member and change a role", async ({ page }) => {
  const api = fakeApi({ me: OWNER });
  await page.route("**/api/**", api.handle);
  await page.goto("/e2e/live.html");
  await expect(page.getByTestId("access")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("invite-form")).toBeVisible();
  await expect(page.getByTestId("role-form")).toBeVisible();

  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Invite role").selectOption("org:support_lead");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText("Invited ada@example.com as org:support_lead.")).toBeVisible();

  await page.getByLabel("Member").fill("user_b");
  await page.getByLabel("New role").selectOption("org:finance_lead");
  await page.getByRole("button", { name: "Change role" }).click();
  await expect(page.getByText("user_b is now org:finance_lead.")).toBeVisible();

  const invite = api.requests.find((r) => r.path === "/api/members/invitations");
  const role = api.requests.find((r) => r.path === "/api/members/user_b/role");
  expect(invite).toMatchObject({
    method: "POST",
    body: { email: "ada@example.com", role: "org:support_lead" },
  });
  expect(role).toMatchObject({
    method: "PATCH",
    body: { role: "org:finance_lead" },
  });
  expect(invite?.body).not.toHaveProperty("org");
  expect(invite?.body).not.toHaveProperty("orgId");
  expect(role?.body).not.toHaveProperty("org");
  expect(role?.body).not.toHaveProperty("orgId");
  expect(await violations(page)).toEqual([]);
});
