import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { incidentBrief } from "@rehearsal/planner";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { loadSets } from "../src/sets";

/**
 * T4.14: the held-out sets share nothing with the development cohort (INC-BILL-0927) or with each
 * other, a planner's brief carries none of the answers, and no planner or baseline code can reach
 * the gold.
 */

const sets = loadSets();
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Split {
  name: string;
  incident: string;
  window: { createdGte: string; createdLt: string };
  values: Record<string, string[]>;
}

const dev = incidentRecords(INCIDENT);
const splits: Split[] = [
  {
    name: "dev",
    incident: INCIDENT.incident,
    window: INCIDENT.window,
    values: identifiers(dev, INCIDENT.cases),
  },
  ...sets.map((s) => ({
    name: s.id,
    incident: s.incident.incident,
    window: s.incident.window,
    values: {
      ...identifiers(s.records, s.incident.cases),
      // Charges a task adds later must not collide either.
      drift: s.tasks.tasks.flatMap((t) =>
        t.drift.flatMap((d) => ("chargeId" in d ? [d.chargeId] : [])),
      ),
    },
  })),
];

function identifiers(
  records: ReturnType<typeof incidentRecords>,
  cases: { customerId: string; email: string; name: string; requesterId: number }[],
): Record<string, string[]> {
  return {
    customer: cases.map((c) => c.customerId),
    email: cases.map((c) => c.email),
    name: cases.map((c) => c.name),
    requester: cases.map((c) => String(c.requesterId)),
    charge: records.stripe.charges.map((c) => String(c.id)),
    invoice: records.stripe.charges.map((c) => String(c.invoice)),
    ticket: records.cases.map((c) => String(c.ticketId)),
  };
}

describe("split separation", () => {
  it("shares no identifier between any two splits", () => {
    for (const [i, a] of splits.entries()) {
      for (const b of splits.slice(i + 1)) {
        expect(a.incident).not.toBe(b.incident);
        for (const field of Object.keys(a.values)) {
          const theirs = new Set(Object.values(b.values).flat());
          const shared = (a.values[field] ?? []).filter((v) => theirs.has(v));
          expect(shared, `${a.name}/${b.name} share ${field}`).toEqual([]);
        }
      }
    }
  });

  it("uses no development amount for a held-out case", () => {
    const devAmounts = new Set(INCIDENT.cases.map((c) => c.amountMinor));
    for (const s of sets) {
      expect(s.incident.cases.filter((c) => devAmounts.has(c.amountMinor))).toEqual([]);
    }
  });

  it("puts every split in its own incident window", () => {
    const spans = splits.map(
      (s) => [Date.parse(s.window.createdGte), Date.parse(s.window.createdLt)] as const,
    );
    for (const [i, [a0, a1]] of spans.entries()) {
      for (const [b0, b1] of spans.slice(i + 1)) expect(a1 <= b0 || b1 <= a0).toBe(true);
    }
  });
});

describe("what a planner gets", () => {
  it.each(sets)("$id: the brief names who reported it and nothing it has to find", (set) => {
    const brief = incidentBrief(set.incident.incident, set.incident);
    expect(brief?.customers).toHaveLength(set.incident.cases.length);
    const text = JSON.stringify(brief);
    for (const c of set.records.cases) {
      expect(text).not.toContain(c.kind);
      expect(text).not.toContain(String(c.amountMinor));
      for (const id of c.chargeIds) expect(text).not.toContain(id);
    }
    expect(text).not.toMatch(/gold|accept|mustNotApply/);
  });
});

/** Source files outside node_modules and build output. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (["node_modules", "dist", "dist-e2e", ".git", "ml"].includes(d.name)) return [];
    const path = `${dir}/${d.name}`;
    if (d.isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(d.name) ? [path] : [];
  });
}

/** Where gold may be read. A scoring module that needs it (T1.25, T1.26) is added here. */
const GOLD_READERS = [/^evals\/held-out\//];
/** Never, whatever the list above says. */
const NEVER = [
  /^packages\/planner\//,
  /^apps\/planner-worker\//,
  /^evals\/scorecard\/src\/(agent|model)\.ts$/,
];

describe("gold isolation", () => {
  it("is read only by its own loader and allowed scoring code", () => {
    const readers = sources(ROOT)
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((file) =>
        /held-out\/gold|evals-held-out\/gold|\.gold\.json/.test(
          readFileSync(`${ROOT}/${file}`, "utf8"),
        ),
      );
    for (const file of readers) {
      expect(
        NEVER.some((re) => re.test(file)),
        `${file} reads held-out gold`,
      ).toBe(false);
      expect(
        GOLD_READERS.some((re) => re.test(file)),
        `${file} reads held-out gold`,
      ).toBe(true);
    }
    // Inside the package only the gold loader and tests touch it.
    for (const file of readers.filter((f) => f.startsWith("evals/held-out/src/"))) {
      expect(file).toBe("evals/held-out/src/gold.ts");
    }
  });
});
