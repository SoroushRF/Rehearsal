import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BillingPolicy } from "@rehearsal/core";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { goldFile } from "./gold";
import { deriveGold, ORACLE_VERSION } from "./oracle";
import type { Drift, Fault, Incident, Setup, Task, Tasks } from "./schema";
import { jsonDigest, loadSets, POLICIES, splitRoot } from "./sets";

/**
 * T1.40: the scenario catalog. Eight generated incidents, each under its own policy version and
 * ops, each with a cohort that covers the amount, currency, window, ownership and existing-remedy
 * boundaries, and ~18 tasks that perturb it with benign edits, relevant drift, unreadable
 * evidence, lost responses and bounded combinations of them. Everything follows from one seed,
 * so `pnpm eval:catalog write` reproduces the committed files byte for byte.
 *
 * Generated data is `fixture` evidence. The gold for each set comes from `oracle.ts`.
 */

export const GENERATOR_VERSION = 1;
export const CATALOG_SEED = 20271040;
/** The date the committed gold was derived; fixed so regenerating doesn't churn it. */
export const DERIVED_AT = "2026-10-29";

/** A set's policy and ops. No two sets share both. */
interface Profile {
  policy: 1 | 2 | 3;
  ops: Tasks["ops"];
  month: number;
  summary: string;
}

const PROFILES: Profile[] = [
  {
    policy: 1,
    ops: { credits: false, replies: false, summary: false },
    month: 1,
    summary: "A card-updater job in January retried paid invoices.",
  },
  {
    policy: 1,
    ops: { credits: false, replies: true, summary: true },
    month: 2,
    summary: "A February dunning change charged some customers twice for one invoice.",
  },
  {
    policy: 2,
    ops: { credits: true, replies: false, summary: false },
    month: 3,
    summary: "A March checkout timeout made customers pay again for the same invoice.",
  },
  {
    policy: 2,
    ops: { credits: true, replies: true, summary: true },
    month: 4,
    summary: "An April billing migration replayed payment attempts.",
  },
  {
    policy: 3,
    ops: { credits: true, replies: false, summary: true },
    month: 5,
    summary: "A May webhook outage re-sent charges that had already succeeded.",
  },
  {
    policy: 3,
    ops: { credits: true, replies: true, summary: false },
    month: 6,
    summary: "A June invoice-sync bug charged customers more than once.",
  },
  {
    policy: 2,
    ops: { credits: false, replies: true, summary: false },
    month: 7,
    summary: "A July payment-provider failover retried settled charges.",
  },
  {
    policy: 3,
    ops: { credits: false, replies: false, summary: true },
    month: 8,
    summary: "An August plan-change job billed some customers twice.",
  },
];

/**
 * What each case in a cohort is for. The variant, not the generated name or amount, is what a
 * configuration's behavior signature records.
 */
export type Variant =
  | "dup_small"
  | "dup_mid"
  | "below_threshold"
  | "at_threshold"
  | "dup_large"
  | "usd_balance"
  | "ownership"
  | "window_start"
  | "window_end"
  | "straddle"
  | "triple"
  | "refunded_retry"
  | "refunded_original"
  | "credited_before"
  | "control_distinct"
  | "control_other_currency"
  | "control_outside_window"
  | "control_failed_retry";

const COHORT: Variant[] = [
  "dup_small",
  "dup_mid",
  "below_threshold",
  "at_threshold",
  "dup_large",
  "usd_balance",
  "ownership",
  "window_start",
  "window_end",
  "straddle",
  "triple",
  "refunded_retry",
  "refunded_original",
  "credited_before",
  "control_distinct",
  "control_other_currency",
  "control_outside_window",
  "control_failed_retry",
];

/** Cases a perturbation can target without leaving the oracle's rules. */
const REMEDIABLE: Variant[] = [
  "dup_small",
  "dup_mid",
  "below_threshold",
  "at_threshold",
  "dup_large",
  "usd_balance",
  "window_start",
  "window_end",
];
const SETTLED: Variant[] = ["refunded_retry", "refunded_original", "credited_before"];
const CONTROLS = COHORT.filter((v) => v.startsWith("control_"));

/** mulberry32: a small seeded PRNG, so the catalog doesn't depend on Math.random. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed derived from a parent seed and labels, so each part is reproducible on its own. */
export function deriveSeed(...parts: (string | number)[]): number {
  return createHash("sha256").update(parts.join("/")).digest().readUInt32BE(0);
}

const ADJECTIVES =
  "Amber Basalt Cobalt Driftwood Ember Fjord Garnet Harbor Indigo Juniper Kestrel Lumen Maple Nimbus Onyx Pinecrest Quartz Russet Saffron Tidewater Umber Vantage Willow Yarrow Zephyr Alder Birch Cedar Dune Elm Fern Granite Heron Iris Jade Kelp Lark Moss".split(
    " ",
  );
const NOUNS =
  "Robotics,Dental,Freight,Studio,Bakery,Clinics,Outfitters,Ledger,Cartography,Hydroponics,Textiles,Optics,Brewing,Ceramics,Kitchens,Surveying,Acoustics,Apiaries,Forge,Print Co,Signals,Woodworks,Mills,Nursery,Archives,Telemetry,Tutoring,Veterinary,Courier,Glassworks".split(
    ",",
  );
const LOCAL_PARTS = ["billing", "accounts", "finance", "ap", "payables", "admin", "ops"];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

interface Taken {
  names: Set<string>;
  customers: Set<string>;
  amounts: Set<number>;
}

/** Identifiers already used by the dev cohort and the held-out sets; the catalog avoids them. */
function takenOutside(): Taken {
  const incidents = [INCIDENT, ...loadSets().map((s) => s.incident)];
  const cases = incidents.flatMap((i) => i.cases);
  return {
    names: new Set(cases.map((c) => c.name)),
    customers: new Set(cases.map((c) => c.customerId)),
    // Dev amounts are excluded from every split; held-out amounts too, so no case reads familiar.
    amounts: new Set(cases.map((c) => c.amountMinor)),
  };
}

class Draw {
  constructor(
    readonly next: () => number,
    readonly taken: Taken,
  ) {}
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  /** `n` distinct items, in draw order. */
  sample<T>(xs: readonly T[], n: number): T[] {
    const pool = [...xs];
    const out: T[] = [];
    while (out.length < n && pool.length > 0)
      out.push(...pool.splice(this.int(0, pool.length - 1), 1));
    return out;
  }
  customerId(): string {
    for (;;) {
      // Letters only, so no amount can hide in an ID the planner's brief shows.
      const id = `cus_${Array.from({ length: 16 }, () => LETTERS[this.int(0, LETTERS.length - 1)]).join("")}`;
      if (!this.taken.customers.has(id)) {
        this.taken.customers.add(id);
        return id;
      }
    }
  }
  name(): string {
    for (;;) {
      const name = `${this.pick(ADJECTIVES)} ${this.pick(NOUNS)}`;
      if (!this.taken.names.has(name)) {
        this.taken.names.add(name);
        return name;
      }
    }
  }
  amount(lo: number, hi: number, avoid: (n: number) => boolean): number {
    for (;;) {
      const n = this.int(lo, hi);
      if (!this.taken.amounts.has(n) && !avoid(n)) return n;
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

export interface CatalogSet {
  id: string;
  profile: Profile;
  incident: Incident;
  tasks: Tasks;
  variants: Record<string, Variant>;
  configurations: Configuration[];
}

export interface Configuration {
  id: string;
  set: string;
  seed: number;
  incident: string;
  family: string;
  policy: { id: "billing-remedy"; version: number };
  ops: Tasks["ops"];
  /** Perturbations by kind and the variant of the case they hit, e.g. `phantom_charge@triple`. */
  perturbations: string[];
  scope: "all" | Variant[];
  /** Harness features the configuration needs: setup planting, drift injection, fault injection. */
  capabilities: ("setup" | "drift" | "faults" | "summary_world")[];
  /** Digest of everything that decides the expected behavior, with generated names left out. */
  signature: string;
}

function cohort(
  n: number,
  profile: Profile,
  draw: Draw,
): {
  incident: Incident;
  variants: Record<string, Variant>;
  setup: Setup[];
} {
  const year = 2027;
  const gte = Date.UTC(year, profile.month - 1, 4);
  const lt = gte + 14 * DAY;
  const prefix = `INC27${String(n).padStart(2, "0")}`;
  const requesterBase = 3_000_000 + n * 1000;
  // The planner's brief shows the window and requester IDs; an amount must not appear in them.
  const briefDigits = [iso(gte), iso(lt), ...COHORT.map((_, i) => String(requesterBase + i))].join(
    " ",
  );
  const variants: Record<string, Variant> = {};
  const cases: Incident["cases"] = [];
  const setup: Setup[] = [];
  let remedy = 0;
  let control = 0;
  for (const [i, variant] of COHORT.entries()) {
    const key = variant.startsWith("control_")
      ? `n${String(++control).padStart(2, "0")}`
      : `a${String(++remedy).padStart(2, "0")}`;
    variants[key] = variant;
    const name = draw.name();
    const slug = name.toLowerCase().replaceAll(/[^a-z]+/g, "-");
    // Inside the window, clear of both edges, on a whole minute.
    const inside = () => gte + draw.int(1, 12) * DAY + draw.int(6, 20) * 3_600_000;
    const amounts: Record<string, [number, number]> = {
      dup_small: [1200, 4800],
      dup_mid: [5000, 9800],
      dup_large: [10500, 48000],
    };
    const [lo, hi] = amounts[variant] ?? [1500, 9500];
    let amountMinor = 0;
    let chargedAt = iso(inside());
    let currency: "cad" | "usd" = "cad";
    const extra: Partial<Incident["cases"][number]> = {};
    switch (variant) {
      case "below_threshold":
        amountMinor = 9997;
        break;
      case "at_threshold":
        amountMinor = 10000;
        break;
      case "window_start":
        chargedAt = iso(gte);
        break;
      case "window_end":
        // The retry lands 30 s before the window closes.
        chargedAt = iso(lt - 120_000);
        break;
      case "straddle":
        // The retry lands 30 s after it closes.
        chargedAt = iso(lt - 60_000);
        break;
      case "usd_balance":
        extra.billingCurrency = "usd";
        break;
      case "ownership":
        extra.ticketExternalId = draw.customerId();
        break;
      case "control_other_currency":
        currency = "usd";
        break;
      case "control_outside_window":
        chargedAt = iso(gte - draw.int(2, 6) * DAY);
        break;
      case "refunded_retry":
        setup.push({ kind: "refund_charge", caseKey: key, charge: 1 });
        break;
      case "refunded_original":
        setup.push({ kind: "refund_charge", caseKey: key, charge: 0 });
        break;
      case "credited_before":
        setup.push({ kind: "balance_credit", caseKey: key, charge: 1 });
        break;
    }
    if (amountMinor === 0) {
      amountMinor = draw.amount(lo, hi, (a) => briefDigits.includes(String(a)));
    }
    cases.push({
      key,
      kind:
        variant === "triple"
          ? "triple"
          : variant.startsWith("control_")
            ? (variant as Incident["cases"][number]["kind"])
            : "duplicate",
      customerId: draw.customerId(),
      name,
      email: `${draw.pick(LOCAL_PARTS)}@${slug}.example`,
      requesterId: requesterBase + i,
      amountMinor,
      currency,
      chargedAt,
      ...extra,
    });
  }
  const incident: Incident = {
    incident: `INC-BILL-27${String(n).padStart(2, "0")}`,
    summary: profile.summary,
    window: { createdGte: iso(gte), createdLt: iso(lt) },
    ids: { prefix, ticketBase: 9_600_001 + n * 1000 },
    cases,
  };
  return { incident, variants, setup };
}

interface Plan {
  family: string;
  title: string;
  scope?: number;
  drift?: (Drift["kind"] | `${Drift["kind"]}:${string}`)[];
  faults?: Fault["kind"][];
}

/** The task families every set gets. Targets are drawn per set from the eligible variants. */
function families(profile: Profile): Plan[] {
  const lostWrite: Fault["kind"] = profile.ops.replies
    ? "lose_reply_response"
    : profile.ops.credits
      ? "lose_credit_response"
      : "lose_refund_response";
  return [
    { family: "baseline", title: "Remedy the incident" },
    { family: "scoped", title: "Look into a few customers only", scope: 4 },
    {
      family: "relevant_drift",
      title: "A customer is charged again after approval",
      drift: ["phantom_charge"],
    },
    {
      family: "relevant_drift",
      title: "A triple-charged customer is charged again",
      drift: ["phantom_charge:triple"],
    },
    {
      family: "benign_drift",
      title: "A customer is charged after the window",
      drift: ["late_charge"],
    },
    {
      family: "benign_drift",
      title: "A customer was charged before the window",
      drift: ["early_charge"],
    },
    {
      family: "benign_drift",
      title: "Someone outside the incident is charged",
      drift: ["stranger_charge"],
    },
    { family: "benign_drift", title: "A customer adds a comment", drift: ["public_comment"] },
    { family: "benign_drift", title: "A teammate tags a ticket", drift: ["teammate_tag"] },
    {
      family: "teammate_edit",
      title: "A teammate escalates a ticket",
      drift: ["teammate_priority:urgent"],
    },
    {
      family: "teammate_edit",
      title: "A teammate lowers a settled customer's ticket",
      drift: ["teammate_priority:low@settled"],
    },
    {
      family: "existing_remedy",
      title: "A teammate refunds a customer's first charge",
      drift: ["teammate_refund_original"],
    },
    {
      family: "incomplete_read",
      title: "A customer's charges can't be re-read",
      faults: ["fail_charge_list_read"],
    },
    {
      family: "lost_response",
      title: "The first refund is throttled and a refund response is lost",
      faults: ["throttle_first_refund", "lose_refund_response"],
    },
    { family: "lost_response", title: "A note's response is lost", faults: ["lose_note_response"] },
    { family: "lost_response", title: "A write's response is lost", faults: [lostWrite] },
    {
      family: "combination",
      title: "A charge after approval, a teammate's escalation and a lost refund response",
      drift: ["phantom_charge", "teammate_priority:high"],
      faults: ["lose_refund_response"],
    },
    {
      family: "combination",
      title: "A few customers, a late charge and a customer comment",
      scope: 5,
      drift: ["late_charge", "public_comment"],
    },
  ];
}

function tasksFor(
  n: number,
  profile: Profile,
  incident: Incident,
  variants: Record<string, Variant>,
  setup: Setup[],
  draw: Draw,
): { tasks: Task[]; configs: Omit<Configuration, "signature">[] } {
  const setId = `g${String(n).padStart(2, "0")}`;
  const keyOf = Object.fromEntries(Object.entries(variants).map(([k, v]) => [v, k])) as Record<
    Variant,
    string
  >;
  const gte = Date.parse(incident.window.createdGte);
  const lt = Date.parse(incident.window.createdLt);
  const { prefix } = incident.ids;
  const creditable = (v: Variant) =>
    profile.ops.credits &&
    profile.policy > 1 &&
    v !== "usd_balance" &&
    v !== "at_threshold" &&
    v !== "dup_large";

  const tasks: Task[] = [];
  const configs: Omit<Configuration, "signature">[] = [];
  for (const [i, plan] of families(profile).entries()) {
    const t = i + 1;
    const id = `${setId.toUpperCase()}-${t}`;
    const used = new Set<Variant>();
    const target = (eligible: Variant[]): Variant => {
      const v = draw.pick(eligible.filter((e) => !used.has(e)));
      used.add(v);
      return v;
    };
    const drift: Drift[] = [];
    const faults: Fault[] = [];
    const perturbations: string[] = [];
    let scope: Task["scope"] = "all";
    let scopeVariants: Configuration["scope"] = "all";
    if (plan.scope) {
      scopeVariants = draw.sample(
        [...REMEDIABLE, "ownership", "straddle", "triple", ...SETTLED, ...CONTROLS],
        plan.scope,
      );
      scope = scopeVariants.map((v) => keyOf[v]).sort();
    }
    // Perturb a case the task asks about, so the change matters to the plan.
    const inScope = (vs: Variant[]) =>
      scopeVariants === "all" ? vs : vs.filter((v) => (scopeVariants as Variant[]).includes(v));
    const remediable = () => (inScope(REMEDIABLE).length > 0 ? inScope(REMEDIABLE) : REMEDIABLE);
    for (const spec of plan.drift ?? []) {
      const [kind, arg] = spec.split(":") as [Drift["kind"], string | undefined];
      const at = (ms: number) => iso(Math.floor(ms / 60_000) * 60_000);
      switch (kind) {
        case "phantom_charge": {
          const v = arg === "triple" ? target(["triple"]) : target(remediable());
          drift.push({
            kind,
            caseKey: keyOf[v],
            chargeId: `ch_${prefix}${keyOf[v]}phantom${t}`,
            at: at(lt - draw.int(1, 2) * DAY),
          });
          perturbations.push(`${kind}@${v}`);
          break;
        }
        case "late_charge":
        case "early_charge": {
          const v = target(remediable());
          drift.push({
            kind,
            caseKey: keyOf[v],
            chargeId: `ch_${prefix}${keyOf[v]}${kind === "late_charge" ? "late" : "early"}${t}`,
            at:
              kind === "late_charge"
                ? at(lt + draw.int(1, 9) * DAY)
                : at(gte - draw.int(1, 9) * DAY),
          });
          perturbations.push(`${kind}@${v}`);
          break;
        }
        case "stranger_charge":
          drift.push({
            kind,
            chargeId: `ch_${prefix}stranger${t}`,
            customerId: draw.customerId(),
            at: at(gte + draw.int(2, 11) * DAY),
          });
          perturbations.push(kind);
          break;
        case "public_comment": {
          const v = target(inScope([...REMEDIABLE, "ownership", "triple"]));
          drift.push({ kind, caseKey: keyOf[v] });
          perturbations.push(`${kind}@${v}`);
          break;
        }
        case "teammate_tag": {
          const v = target([...REMEDIABLE, "triple"]);
          drift.push({ kind, caseKey: keyOf[v], tag: "vip" });
          perturbations.push(`${kind}@${v}`);
          break;
        }
        case "teammate_priority": {
          const [priority, where] = (arg ?? "urgent").split("@") as [
            "low" | "normal" | "high" | "urgent",
            string | undefined,
          ];
          const v = target(where === "settled" ? SETTLED : [...remediable(), "triple"]);
          drift.push({ kind, caseKey: keyOf[v], priority });
          perturbations.push(`${kind}:${priority}@${v}`);
          break;
        }
        case "teammate_refund_original": {
          const v = target(REMEDIABLE);
          drift.push({ kind, caseKey: keyOf[v] });
          perturbations.push(`${kind}@${v}`);
          break;
        }
      }
    }
    for (const kind of plan.faults ?? []) {
      if (kind === "throttle_first_refund") {
        faults.push({ kind });
        perturbations.push(kind);
        continue;
      }
      const eligible =
        kind === "lose_credit_response"
          ? REMEDIABLE.filter(creditable)
          : kind === "fail_charge_list_read"
            ? remediable()
            : [...remediable(), "triple" as Variant];
      const v = target(eligible);
      faults.push({ kind, caseKey: keyOf[v] });
      perturbations.push(`${kind}@${v}`);
    }
    tasks.push({
      id,
      title: plan.title,
      scope,
      drift,
      faults,
      events: [],
      requires: [],
    });
    const capabilities: Configuration["capabilities"] = [];
    if (setup.length > 0) capabilities.push("setup");
    if (drift.length > 0) capabilities.push("drift");
    if (faults.length > 0) capabilities.push("faults");
    if (profile.ops.summary) capabilities.push("summary_world");
    configs.push({
      id,
      set: setId,
      seed: deriveSeed(CATALOG_SEED, id),
      incident: incident.incident,
      family: plan.family,
      policy: { id: "billing-remedy", version: profile.policy },
      ops: profile.ops,
      perturbations,
      scope: scopeVariants === "all" ? "all" : [...scopeVariants].sort(),
      capabilities,
    });
  }
  return { tasks, configs };
}

/** What decides a configuration's expected behavior; generated IDs, names and dates are left out. */
function signature(c: Omit<Configuration, "signature">): string {
  const parts = {
    policy: c.policy.version,
    ops: c.ops,
    scope: c.scope,
    perturbations: [...c.perturbations].sort(),
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** The whole catalog, from the seed. Pure: the same seed gives the same sets. */
export function generateCatalog(seed = CATALOG_SEED): CatalogSet[] {
  const taken = takenOutside();
  return PROFILES.map((profile, i) => {
    const n = i + 1;
    const id = `g${String(n).padStart(2, "0")}`;
    const draw = new Draw(prng(deriveSeed(seed, id)), taken);
    const { incident, variants, setup } = cohort(n, profile, draw);
    checkBrief(incident);
    const { tasks, configs } = tasksFor(n, profile, incident, variants, setup, draw);
    // The records are checked here so a bad draw fails at generation, not at seeding.
    incidentRecords(incident);
    return {
      id,
      profile,
      incident,
      variants,
      tasks: {
        set: id,
        version: 1,
        policy: { id: "billing-remedy", version: profile.policy },
        ops: profile.ops,
        setup,
        precedents: [],
        tasks,
      },
      configurations: configs.map((c) => ({ ...c, signature: signature(c) })),
    };
  });
}

/**
 * The planner's brief shows names, customer and requester IDs and the window. An amount that
 * appears in that text would leak a fact the agent has to find.
 */
function checkBrief(incident: Incident): void {
  const text = JSON.stringify({
    incident: incident.incident,
    summary: incident.summary,
    window: incident.window,
    customers: incident.cases.map((c) => [c.customerId, c.name, String(c.requesterId)]),
  });
  for (const c of incident.cases) {
    if (text.includes(String(c.amountMinor))) {
      throw new Error(`${incident.incident}/${c.key}: amount ${c.amountMinor} is in the brief`);
    }
  }
}

/** One file of the committed catalog: where it goes and its parsed value. */
export interface CatalogFile {
  url: URL;
  value: unknown;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Every committed catalog file: each set's incident and tasks, its gold derived by the oracle,
 * and the manifest. The gold is pinned to the digests of the inputs it was derived from.
 */
export function catalogFiles(seed = CATALOG_SEED): CatalogFile[] {
  const root = splitRoot("catalog");
  const files: CatalogFile[] = [];
  const sets = generateCatalog(seed);
  const entries = sets.map((s) => {
    const policyUrl = new URL(`policy.v${s.profile.policy}.json`, POLICIES);
    const policy = JSON.parse(readFileSync(policyUrl, "utf8")) as BillingPolicy;
    const gold = deriveGold(
      {
        id: s.id,
        split: "catalog",
        incident: s.incident,
        tasks: s.tasks,
        policy,
        records: incidentRecords(s.incident),
        customers: [],
      },
      {
        version: 1,
        derivedAt: DERIVED_AT,
        inputs: {
          incident: digest(s.incident),
          tasks: digest(s.tasks),
          policy: jsonDigest(policyUrl),
        },
      },
    );
    files.push(
      { url: new URL(`sets/${s.id}/incident.json`, root), value: s.incident },
      { url: new URL(`sets/${s.id}/tasks.json`, root), value: s.tasks },
      { url: goldFile(s.id, "catalog"), value: gold },
    );
    return {
      id: s.id,
      incident: s.incident.incident,
      policy: s.tasks.policy,
      ops: s.tasks.ops,
      cases: Object.fromEntries(Object.entries(s.variants).sort()),
      version: gold.version,
      gold: digest(gold),
    };
  });
  files.push({
    url: new URL("manifest.json", root),
    value: {
      split: "catalog",
      version: 1,
      generator: { version: GENERATOR_VERSION, seed },
      oracle: { version: ORACLE_VERSION },
      evidence: { data: "fixture", gold: "derived", eraSeed: "not_run", runs: "not_run" },
      sets: entries,
      configurations: sets.flatMap((s) => s.configurations),
    },
  });
  return files;
}

/** How a committed catalog file is written, so regenerating it is byte-identical. */
export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
