import { describe, expect, it } from "vitest";
import { sweepTimings } from "../src/worker";

describe("sweep timings", () => {
  it("defaults to a 1 min sweep, a 15 min lease and a 1 h hand-off", () => {
    expect(sweepTimings({})).toEqual({
      SWEEP_EVERY_MS: 60_000,
      LEASE_MS: 900_000,
      HAND_OFF_AFTER_MS: 3_600_000,
    });
  });

  it("takes whole positive milliseconds from the env and ignores anything else", () => {
    expect(
      sweepTimings({
        REHEARSAL_SWEEP_EVERY_MS: "5000",
        REHEARSAL_LEASE_MS: "-1",
        REHEARSAL_HAND_OFF_AFTER_MS: "1.5",
      }),
    ).toEqual({ SWEEP_EVERY_MS: 5000, LEASE_MS: 900_000, HAND_OFF_AFTER_MS: 3_600_000 });
    expect(sweepTimings({ REHEARSAL_LEASE_MS: "soon" }).LEASE_MS).toBe(900_000);
  });
});
