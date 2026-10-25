import { describe, expect, it } from "vitest";
import { assessCoverage } from "../src/coverage";
import { POLICY, POLICY_V2, world } from "./world";

describe("recorded plan coverage", () => {
  it("refuses a proposal whose row reads disagree with the later invoice query", async () => {
    const { session, records, charges } = world();
    const c = records.cases[0];
    if (!c) throw new Error("missing case");
    const values = charges.values.bind(charges);
    charges.values = () => {
      for (const id of c.chargeIds) {
        const charge = charges.get(id);
        if (charge) charge.amount = 9999;
      }
      return values();
    };
    expect(
      await session.call("propose_duplicate_refund", {
        chargeId: c.chargeIds[1],
        duplicateOfChargeId: c.chargeIds[0],
        rationale: "Duplicate.",
      }),
    ).toMatchObject({ ok: false });
    expect(session.actions).toEqual([]);
  });
  it("distinguishes an unexamined customer from an eligible duplicate without a remedy", async () => {
    const { session, records, reads } = world();
    const c = records.cases[0];
    if (!c) throw new Error("missing case");
    expect(session.coverage([c.customerId])).toEqual([
      { kind: "unexamined", customerId: c.customerId, chargeIds: [] },
    ]);
    await session.call("list_customer_charges", { customerId: c.customerId });
    const before = reads.length;
    expect(session.coverage([c.customerId])).toEqual([
      { kind: "missing_remedy", customerId: c.customerId, chargeIds: c.chargeIds },
    ]);
    expect(reads).toHaveLength(before);
    const query = session.queryObservations[0];
    if (!query) throw new Error("missing query");
    expect(assessCoverage([c.customerId], [{ ...query, complete: false }], [], POLICY)).toEqual([
      { kind: "incomplete_query", customerId: c.customerId, chargeIds: [] },
    ]);
  });

  it.each(["propose_duplicate_refund", "propose_balance_credit"])(
    "accepts an eligible obligation covered by %s",
    async (tool) => {
      const { session, records } = world({ credits: true, policy: POLICY_V2 });
      const c = records.cases[0];
      if (!c) throw new Error("missing case");
      expect(
        await session.call(tool, {
          chargeId: c.chargeIds[1],
          duplicateOfChargeId: c.chargeIds[0],
          rationale: "Duplicate invoice.",
        }),
      ).toMatchObject({ ok: true });
      expect(session.coverage([c.customerId])).toEqual([]);
    },
  );

  it("does not require remedies for examined controls", async () => {
    const { session, records } = world();
    const controls = records.cases.filter((c) => c.kind !== "duplicate");
    for (const c of controls)
      await session.call("list_customer_charges", { customerId: c.customerId });
    expect(session.coverage(controls.map((c) => c.customerId))).toEqual([]);
  });

  it("requires every excess charge and uses the most recent recorded query", async () => {
    const { session, records, charges } = world();
    const c = records.cases[0];
    if (!c) throw new Error("missing case");
    const charge = charges.get(c.chargeIds[1]);
    if (!charge) throw new Error("missing charge");
    charges.set("ch_third", { ...charge, id: "ch_third", created: Number(charge.created) + 1 });
    await session.call("list_customer_charges", { customerId: c.customerId });
    expect(session.coverage([c.customerId])).toHaveLength(2);
    charges.delete("ch_third");
    await session.call("list_customer_charges", { customerId: c.customerId });
    expect(session.coverage([c.customerId])).toEqual([
      { kind: "missing_remedy", customerId: c.customerId, chargeIds: c.chargeIds },
    ]);
  });
});
