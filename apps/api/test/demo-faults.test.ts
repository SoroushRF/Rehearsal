import { describe, expect, it } from "vitest";
import { assertFaultsAllowed } from "../../../scripts/inject/session";

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
