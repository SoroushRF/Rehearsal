import { describe, expect, it } from "vitest";
import { deriveRegistry, type PrecedentEventRow } from "../src/precedents";

let seq = 0;
const event = (
  kind: PrecedentEventRow["kind"],
  version: number,
  over: Partial<PrecedentEventRow> = {},
): PrecedentEventRow => ({
  seq: ++seq,
  orgId: "org_1",
  precedentId: "dup-refund",
  version,
  appliesTo: "billing.duplicate_charge",
  kind,
  digest: `digest-v${version}`,
  record: kind === "approved" ? { version } : null,
  actorUserId: kind === "approved" ? "user_fin" : null,
  sourceRunId: kind === "approved" ? "run_1" : null,
  at: new Date("2026-10-24T12:00:00.000Z"),
  ...over,
});

const status = (events: PrecedentEventRow[]) =>
  Object.fromEntries(deriveRegistry(events).entries.map((e) => [e.version, e.status]));
const AREA = "billing.duplicate_charge";

describe("deriveRegistry (decision 0012)", () => {
  it("keeps an approved precedent waiting, and out of the snapshot, until it is activated", () => {
    const view = deriveRegistry([event("approved", 1)]);
    expect(view.entries.map((e) => e.status)).toEqual(["waiting"]);
    expect(view.snapshot.active.size).toBe(0);
    expect(view.snapshot.epochs.get(AREA)).toBeUndefined();
  });

  it("activates on sync: active version and digest appear and the area's epoch moves", () => {
    const view = deriveRegistry([event("approved", 1), event("activated", 1)]);
    expect(view.entries.map((e) => e.status)).toEqual(["active"]);
    expect(view.snapshot.active.get("dup-refund")).toEqual({ version: 1, digest: "digest-v1" });
    expect(view.snapshot.epochs.get(AREA)).toBe(1);
  });

  it("replaces a version with the next: the old one is superseded and the epoch moves again", () => {
    const events = [
      event("approved", 1),
      event("activated", 1),
      event("approved", 2),
      event("activated", 2),
    ];
    expect(status(events)).toEqual({ 1: "superseded", 2: "active" });
    const { snapshot } = deriveRegistry(events);
    expect(snapshot.active.get("dup-refund")?.version).toBe(2);
    expect(snapshot.epochs.get(AREA)).toBe(2);
  });

  it("leaves the current version waiting while its successor hasn't synced", () => {
    const events = [event("approved", 1), event("activated", 1), event("approved", 2)];
    expect(status(events)).toEqual({ 1: "active", 2: "waiting" });
    expect(deriveRegistry(events).snapshot.epochs.get(AREA)).toBe(1);
  });

  it("ignores a late sync of an older version once a newer one is active", () => {
    const events = [
      event("approved", 1),
      event("approved", 2),
      event("activated", 2),
      event("activated", 1),
    ];
    const view = deriveRegistry(events);
    expect(view.snapshot.active.get("dup-refund")?.version).toBe(2);
    expect(view.snapshot.epochs.get(AREA)).toBe(1);
    expect(status(events)).toEqual({ 1: "superseded", 2: "active" });
  });

  it("withdraws the active version: it leaves the snapshot and the epoch moves", () => {
    const events = [event("approved", 1), event("activated", 1), event("withdrawn", 1)];
    const view = deriveRegistry(events);
    expect(status(events)).toEqual({ 1: "withdrawn" });
    expect(view.snapshot.active.has("dup-refund")).toBe(false);
    expect(view.snapshot.epochs.get(AREA)).toBe(2);
  });

  it("doesn't let a withdrawn precedent come back through an older version's sync", () => {
    const events = [
      event("approved", 1),
      event("approved", 2),
      event("activated", 2),
      event("withdrawn", 2),
      event("activated", 1),
    ];
    expect(deriveRegistry(events).snapshot.active.size).toBe(0);
  });

  it("ignores an activation for a version that was never approved", () => {
    const view = deriveRegistry([event("activated", 3)]);
    expect(view.entries).toEqual([]);
    expect(view.snapshot.active.size).toBe(0);
  });

  it("keeps areas apart, and precedents in the same area move one epoch together", () => {
    const other = { precedentId: "late-fee", appliesTo: "billing.late_fee" };
    const events = [
      event("approved", 1),
      event("activated", 1),
      event("approved", 1, other),
      event("activated", 1, other),
      event("approved", 1, { precedentId: "dup-credit" }),
      event("activated", 1, { precedentId: "dup-credit" }),
    ];
    const { snapshot } = deriveRegistry(events);
    expect(snapshot.epochs.get(AREA)).toBe(2);
    expect(snapshot.epochs.get("billing.late_fee")).toBe(1);
    expect([...snapshot.active.keys()].sort()).toEqual(["dup-credit", "dup-refund", "late-fee"]);
  });

  it("reads the same whatever order the rows arrive in", () => {
    const events = [event("approved", 1), event("activated", 1), event("approved", 2)];
    expect(deriveRegistry([...events].reverse())).toEqual(deriveRegistry(events));
  });
});
