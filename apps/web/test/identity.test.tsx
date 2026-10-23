import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { dropOtherTenants, identityOf } from "../src/identity";

const seed = (qc: QueryClient, identity: string) => {
  qc.setQueryData(["tenant", identity, "plans"], { plans: [`${identity}-plan`] });
  qc.setQueryData(["tenant", identity, "grants", "p"], { grants: [] });
};

describe("identity", () => {
  it("is different for a different user or organization", () => {
    expect(identityOf("u1", "o1")).not.toBe(identityOf("u2", "o1"));
    expect(identityOf("u1", "o1")).not.toBe(identityOf("u1", "o2"));
  });

  it("drops every other identity's cache and keeps the current one's", () => {
    const qc = new QueryClient();
    seed(qc, "a/o1");
    seed(qc, "b/o2");
    qc.setQueryData(["health"], { ok: true });

    dropOtherTenants(qc, "b/o2");

    expect(qc.getQueryData(["tenant", "a/o1", "plans"])).toBeUndefined();
    expect(qc.getQueryData(["tenant", "a/o1", "grants", "p"])).toBeUndefined();
    expect(qc.getQueryData(["tenant", "b/o2", "plans"])).toEqual({ plans: ["b/o2-plan"] });
    expect(qc.getQueryData(["health"])).toEqual({ ok: true });
  });

  it("drops every tenant cache on sign-out, but not what isn't tenant data", () => {
    const qc = new QueryClient();
    seed(qc, "a/o1");
    seed(qc, "b/o2");
    qc.setQueryData(["health"], { ok: true });

    dropOtherTenants(qc, null);

    expect(qc.getQueryCache().findAll({ queryKey: ["tenant"] })).toEqual([]);
    expect(qc.getQueryData(["health"])).toEqual({ ok: true });
  });
});
