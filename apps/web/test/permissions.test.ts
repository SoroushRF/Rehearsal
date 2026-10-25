import { describe, expect, it } from "vitest";
import { actionAllowed } from "../src/permissions";

const member = ["rehearsal:read:plan", "rehearsal:read:run", "rehearsal:read:precedent"];
const owner = [
  ...member,
  "rehearsal:approve:support_step",
  "rehearsal:approve:finance_step",
  "rehearsal:apply:plan",
  "rehearsal:cancel:run",
  "rehearsal:revoke:own_grant",
  "rehearsal:revoke:any_grant",
  "rehearsal:rehearse:incident",
  "rehearsal:invite:member",
  "rehearsal:manage:role",
];

describe("actionAllowed", () => {
  it("lets an owner invite and change roles, and a member do neither", () => {
    expect(actionAllowed(owner, "invite")).toBe(true);
    expect(actionAllowed(owner, "manageRole")).toBe(true);
    expect(actionAllowed(member, "invite")).toBe(false);
    expect(actionAllowed(member, "manageRole")).toBe(false);
  });

  it("matches each action to the permission that allows it", () => {
    expect(actionAllowed(["rehearsal:approve:support_step"], "approve")).toBe(true);
    expect(actionAllowed(["rehearsal:approve:finance_step"], "approve")).toBe(true);
    expect(actionAllowed(["rehearsal:apply:plan"], "apply")).toBe(true);
    expect(actionAllowed(["rehearsal:cancel:run"], "cancel")).toBe(true);
    expect(actionAllowed(["rehearsal:revoke:own_grant"], "revoke")).toBe(true);
    expect(actionAllowed(["rehearsal:revoke:any_grant"], "revoke")).toBe(true);
    expect(actionAllowed(["rehearsal:rehearse:incident"], "rehearse")).toBe(true);
    expect(actionAllowed(member, "approve")).toBe(false);
    expect(actionAllowed(member, "apply")).toBe(false);
    expect(actionAllowed(member, "cancel")).toBe(false);
    expect(actionAllowed(member, "revoke")).toBe(false);
    expect(actionAllowed(member, "rehearse")).toBe(false);
  });

  it("keeps the older review controls when the page has no permission list", () => {
    expect(actionAllowed(null, "approve")).toBe(true);
    expect(actionAllowed(null, "apply")).toBe(true);
    expect(actionAllowed(null, "rehearse")).toBe(true);
    expect(actionAllowed(null, "invite")).toBe(false);
    expect(actionAllowed(null, "manageRole")).toBe(false);
    expect(actionAllowed(null, "cancel")).toBe(false);
    expect(actionAllowed(null, "revoke")).toBe(false);
  });
});
