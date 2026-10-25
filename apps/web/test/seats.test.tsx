import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalStatus } from "../src/api";
import { Seats } from "../src/components/LivePlans";

const html = (status: ApprovalStatus) => renderToStaticMarkup(<Seats status={status} />);
const seat = (out: string, role: string) =>
  out.match(new RegExp(`data-seat="${role}"[^>]*>(.*?)</li>`))?.[1]?.replace(/<[^>]+>/g, " ") ?? "";

describe("approver seats (T2.13)", () => {
  it("shows both seats waiting when nobody has signed", () => {
    const out = html({
      dualRequired: true,
      satisfied: false,
      signed: [],
      needed: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
    });
    expect(out).toContain('aria-label="Approvers"');
    expect(seat(out, "support_lead")).toContain("Waiting");
    expect(seat(out, "finance_lead")).toContain("Waiting");
  });

  it("names who signed and which seat is still open", () => {
    const out = html({
      dualRequired: true,
      satisfied: false,
      signed: [
        {
          permission: "rehearsal:approve:finance_step",
          grantId: "g1",
          actorUserId: "user_fin",
        },
      ],
      needed: ["rehearsal:approve:support_step"],
    });
    expect(seat(out, "finance_lead")).toContain("user_fin");
    expect(seat(out, "finance_lead")).toContain("rehearsal:approve:finance_step");
    expect(seat(out, "support_lead")).toContain("Waiting");
    expect(out).toContain('data-signed="true"');
    expect(out).toContain('data-signed="false"');
  });

  it("shows both signers once the plan is covered", () => {
    const out = html({
      dualRequired: true,
      satisfied: true,
      signed: [
        {
          permission: "rehearsal:approve:support_step",
          grantId: "g1",
          actorUserId: "user_sup",
        },
        {
          permission: "rehearsal:approve:finance_step",
          grantId: "g2",
          actorUserId: "user_fin",
        },
      ],
      needed: [],
    });
    expect(seat(out, "support_lead")).toContain("user_sup");
    expect(seat(out, "finance_lead")).toContain("user_fin");
    expect(out).not.toContain("Waiting");
  });

  it("reads the API's status, and a response without one", () => {
    expect(
      ApprovalStatus.safeParse({ dualRequired: false, satisfied: true, signed: [], needed: [] })
        .success,
    ).toBe(true);
    expect(ApprovalStatus.safeParse({ dualRequired: true }).success).toBe(false);
    expect(
      ApprovalStatus.safeParse({
        dualRequired: true,
        satisfied: false,
        signed: [{ role: "finance_lead", grantId: "g1", actorUserId: "user_fin" }],
        needed: [],
      }).success,
    ).toBe(false);
  });
});
