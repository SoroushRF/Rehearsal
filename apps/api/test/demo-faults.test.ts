import { orgTenant } from "@rehearsal/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFaultsAllowed, bind, demoTenant } from "../../../scripts/inject/session";

/** Era faults are container-wide: on a shared Era they would hit every org's tenant at once. */
describe("demo faults", () => {
  it("are allowed on a local Era", () => {
    for (const baseUrl of ["http://localhost:8102", "http://127.0.0.1:8102", "http://[::1]:8102"]) {
      expect(() => assertFaultsAllowed({ baseUrl }, {})).not.toThrow();
    }
  });

  it("are refused on a shared Era unless asked for by name", () => {
    const shared = { baseUrl: "https://stripe-operational.onrender.com" };
    expect(() => assertFaultsAllowed(shared, {})).toThrow(/every org's tenant/);
    expect(() => assertFaultsAllowed(shared, { REHEARSAL_SHARED_FAULTS: "1" })).not.toThrow();
  });
});

describe("demo tenant routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("derives the same org tenant as the workers, with an explicit CLI override", () => {
    expect(demoTenant({ DEMO_ORG_ID: "org_demo" }, [])).toBe(orgTenant("org_demo"));
    expect(demoTenant({ DEMO_ORG_ID: "org_demo" }, ["--org=org_judge"])).toBe(
      orgTenant("org_judge"),
    );
    expect(demoTenant({}, [])).toBeUndefined();
    expect(() => demoTenant({}, ["--org=bad"])).toThrow("invalid demo org");
    expect(() => demoTenant({}, ["--org="])).toThrow("invalid demo org");
  });
  it("binds the operational injection to that org, not ERA_TENANT", async () => {
    vi.stubEnv("DEMO_ORG_ID", "org_demo");
    vi.stubEnv("ERA_TENANT", "rehearsal-demo");
    vi.stubEnv("ERA_ADMIN_TOKEN", "fixture-admin");
    vi.stubEnv("ERA_STRIPE_OPERATIONAL_URL", "http://stripe.test");
    const tenants: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      tenants.push(new URLSearchParams(String(init.body)).get("tenant"));
      return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    });
    const world = await bind("stripe", "operational");
    expect(world.tenant).toBe(orgTenant("org_demo"));
    expect(tenants).toEqual([orgTenant("org_demo")]);
  });
});
