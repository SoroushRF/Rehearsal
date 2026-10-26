import { CompanySnapshot, StoredIncident } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { companyFixture, incidentFixtures } from "../src/fixtures";

describe("live company fixtures", () => {
  it("parse with the contracts the real routes use", () => {
    expect(CompanySnapshot.safeParse(companyFixture).success).toBe(true);
    for (const i of incidentFixtures) expect(StoredIncident.safeParse(i).success).toBe(true);
  });

  it("only mark records that exist in the snapshot", () => {
    const ids = new Set([
      ...companyFixture.charges.map((c) => c.id),
      ...companyFixture.customers.map((c) => c.id),
      ...companyFixture.tickets.map((t) => String(t.id)),
      ...companyFixture.slack.map((m) => m.ts),
    ]);
    for (const id of Object.keys(companyFixture.changed)) expect(ids).toContain(id);
  });
});
