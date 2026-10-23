import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  type FakeCharge,
  FakeClock,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  phantomBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import policy from "../../scenarios/billing/policy.v1.json" with { type: "json" };

// The root package doesn't depend on @rehearsal/contracts, so take the types from what uses them.
type ReplayBundle = ReturnType<typeof happyPathBundle>;
type PlanManifest = ReplayBundle["manifest"];
type RunEvent = MemoryJournal["events"][number];
type RunState = Awaited<ReturnType<typeof executeRun>>["state"];

/**
 * Saved replays for the review page (T2.11). Each one is a real run of the executor engine on the
 * in-memory fake provider, so the events and receipts are what the engine produces, not hand-written.
 * That is fixture evidence: no Era image and no model were involved, and the file says so.
 */
export interface SavedReplayFile {
  schemaVersion: 1;
  id: string;
  title: string;
  /** When the run happened, on the engine's test clock, not wall time. */
  savedAt: string;
  evidence: "fixture" | "era_integration";
  /** How the run was produced, shown to whoever opens the replay. */
  source: string;
  planHash: string;
  manifest: PlanManifest;
  run: {
    id: string;
    planId: string;
    revision: number;
    planHash: string;
    approvalId: string;
    requestedBy: string;
    state: RunState;
    createdAt: string;
    updatedAt: string;
  };
  events: RunEvent[];
}

const START = "2026-10-21T12:00:00.000Z";
const RUN = "run_replay";
const APPROVAL = "grant_replay";
const SOURCE =
  "The executor engine run on the in-memory fake provider (pnpm replay:build). Event times come from the engine's test clock.";

/** Stamps each event from the engine's own clock, so a rebuilt file is byte-identical. */
class StampedJournal extends MemoryJournal {
  constructor(private readonly clock: FakeClock) {
    super();
  }
  override async appendEvent(runId: string, type: string, payload: unknown) {
    const event = await super.appendEvent(runId, type, payload);
    event.at = this.clock.now().toISOString();
    this.clock.advance(1000);
    return event;
  }
}

async function replayOf(
  bundle: ReplayBundle,
  title: string,
  perturb: (world: ReturnType<typeof worldFromManifest>) => void,
): Promise<SavedReplayFile> {
  const { manifest } = bundle;
  const hash = planHash(manifest);
  const clock = new FakeClock(START);
  const store = new MemoryApplyStore();
  store.runs.set(RUN, {
    planId: manifest.planId,
    revision: manifest.revision,
    planHash: hash,
    approvalId: APPROVAL,
  });
  store.plans.set(`${manifest.planId}@${manifest.revision}`, { planHash: hash, manifest });
  store.grants.set(APPROVAL, {
    id: APPROVAL,
    orgId: manifest.orgId,
    planId: manifest.planId,
    revision: manifest.revision,
    planHash: hash,
    actorUserId: "user_finance",
    actorSessionId: "sess_replay",
    roles: ["support_lead", "finance_lead"],
    grantedAt: "2026-10-21T11:00:00.000Z",
    expiresAt: "2026-10-21T13:00:00.000Z",
    revokedAt: null,
  });

  const world = worldFromManifest(manifest.observations);
  perturb(world);
  const providers: Record<"stripe" | "zendesk", ProviderPort> = {
    stripe: world.provider("stripe"),
    zendesk: world.provider("zendesk"),
  };
  const worlds = {
    stripe: { world: "operational", tenant: "replay" },
    zendesk: { world: "operational", tenant: "replay" },
  } as const;
  let n = 0;
  const journal = new StampedJournal(clock);
  const deps: ExecutorDeps = {
    store,
    journal,
    clock,
    providers,
    worlds,
    policies: [policy as BillingPolicyV1],
    newId: (prefix: string) => `${prefix}_${++n}`,
    guard: createReadGuard({ providers, worlds, clock }),
  };

  const outcome = await executeRun(
    {
      orgId: manifest.orgId,
      runId: RUN,
      planId: manifest.planId,
      revision: manifest.revision,
      planHash: hash,
    },
    deps,
  );
  const events = journal.events.map((e) => structuredClone(e));
  return {
    schemaVersion: 1,
    id: bundle.id,
    title,
    savedAt: events[0]?.at ?? START,
    evidence: "fixture",
    source: SOURCE,
    planHash: hash,
    manifest,
    run: {
      id: RUN,
      planId: manifest.planId,
      revision: manifest.revision,
      planHash: hash,
      approvalId: APPROVAL,
      requestedBy: "user_finance",
      state: outcome.state,
      createdAt: events[0]?.at ?? START,
      updatedAt: events.at(-1)?.at ?? START,
    },
    events,
  };
}

/** The replays the review page ships with. */
export async function buildReplays(): Promise<SavedReplayFile[]> {
  const phantom = phantomBundle();
  return [
    await replayOf(
      happyPathBundle(),
      "Two customers refunded, nothing changes after approval",
      () => {},
    ),
    await replayOf(
      phantom,
      "A new duplicate charge appears after approval: that refund is held",
      (world) => {
        // The bundle's own perturbation: records injected into the operational world before apply.
        for (const p of phantom.perturbations) {
          if (p.kind !== "inject_records" || p.at !== "before_apply" || p.world !== "operational") {
            continue;
          }
          for (const charge of p.records.charges ?? []) {
            const c = charge as unknown as FakeCharge;
            world.charges.set(c.id, c);
          }
        }
      },
    ),
  ];
}

export const replayIndex = (replays: readonly SavedReplayFile[]) =>
  replays.map((r) => ({ id: r.id, title: r.title, evidence: r.evidence }));
