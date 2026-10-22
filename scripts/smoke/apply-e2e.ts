import { randomUUID } from "node:crypto";
import type { PlanManifest } from "@rehearsal/contracts";
import { planHash } from "@rehearsal/core";
import { createDb, migrateDb, requestApply, schema, startQueue } from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { adminOrThrow, bind, fixture, getJson, report } from "../inject/session";

/**
 * End-to-end smoke for the executor worker. Seeds one CAD charge in the operational world of
 * ERA_TENANT, stores an approved plan (refund → guarded patch → private note), enqueues it with the
 * real apply command, and waits for a running executor worker to finish it. Then checks Era.
 *
 * Run the API (the tenant-token minter) and `pnpm --filter @rehearsal/executor-worker start` with
 * the same DATABASE_URL and ERA_TENANT first. Operator script: it needs ERA_ADMIN_TOKEN.
 */

const TICKET = 4000002;
const stripe = await bind("stripe", "operational");
const zendesk = await bind("zendesk", "operational");
const chargeId = `ch_smoke${randomUUID().replaceAll("-", "").slice(0, 12)}`;
await adminOrThrow(stripe, "/inject", {
  charges: [
    {
      ...fixture("stripe.charge.json"),
      id: chargeId,
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    },
  ],
});
const { ticket } = await getJson<{ ticket: { priority: string | null } }>(
  "zendesk",
  zendesk,
  `/api/v2/tickets/${TICKET}.json`,
);

const orgId = `org_smoke_${randomUUID().slice(0, 8)}`;
const base = billingManifest(`plan_smoke_${randomUUID().slice(0, 8)}`);
const manifest: PlanManifest = {
  ...base,
  orgId,
  actions: base.actions
    .filter((a) => a.caseId === "case_001")
    .map((a) => {
      const copy = structuredClone(a);
      if (copy.kind === "stripe.refund.create") copy.args.chargeId = chargeId;
      else copy.args.ticketId = String(TICKET);
      if (copy.kind === "zendesk.ticket.patchFields") {
        copy.args.set = { priority: ticket.priority === "urgent" ? "high" : "urgent" };
        copy.args.before = { priority: ticket.priority as "low" };
      }
      return copy;
    }),
  // No planning-world evidence here: the guard has nothing to re-check, so this exercises the
  // queue → worker → Era path, not the guards (phantom.test.ts covers those on Era).
  observations: [],
  queryObservations: [],
};
for (const a of manifest.actions) {
  a.evidence = [];
  a.queryEvidence = [];
}
const hash = planHash(manifest);

const db = createDb();
await migrateDb(db);
const boss = await startQueue();
const now = new Date();
await db.insert(schema.planVersions).values({
  orgId,
  planId: manifest.planId,
  revision: 1,
  planHash: hash,
  manifest,
});
await db.insert(schema.approvalGrants).values({
  id: `grant_${randomUUID()}`,
  orgId,
  planId: manifest.planId,
  revision: 1,
  planHash: hash,
  actorUserId: "smoke",
  actorSessionId: "smoke",
  roles: ["support_lead", "finance_lead"],
  grantedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 3_600_000),
});
const accepted = await requestApply(db, boss, {
  orgId,
  userId: "smoke",
  planId: manifest.planId,
  revision: 1,
  planHash: hash,
  now,
});
if (accepted.kind !== "accepted") throw new Error(`apply refused: ${accepted.kind}`);
console.log(`enqueued ${accepted.runId}; waiting for the executor worker…`);

let state = "approved";
for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, accepted.runId));
  state = run?.state ?? "missing";
  if (!["approved", "applying"].includes(state)) break;
  await new Promise((r) => setTimeout(r, 500));
}

const receipts = (await db.select().from(schema.stepReceipts)).filter((r) => r.orgId === orgId);
const refunds = await getJson<{ data: Array<{ id: string }> }>(
  "stripe",
  stripe,
  `/v1/refunds?charge=${chargeId}&limit=100`,
);
const after = await getJson<{ ticket: { priority: string } }>(
  "zendesk",
  zendesk,
  `/api/v2/tickets/${TICKET}.json`,
);
const comments = await getJson<{ comments: Array<{ body: string; public: boolean }> }>(
  "zendesk",
  zendesk,
  `/api/v2/tickets/${TICKET}/comments.json`,
);
const note = comments.comments.at(-1);
const patch = manifest.actions.find((a) => a.kind === "zendesk.ticket.patchFields");
report([
  [state === "completed", `run ${accepted.runId} → ${state}`],
  [receipts.length === 3, `${receipts.length} receipts journaled`],
  [refunds.data.length === 1, `${refunds.data.length} refund on ${chargeId}`],
  [
    patch?.kind === "zendesk.ticket.patchFields" &&
      after.ticket.priority === patch.args.set.priority,
    `ticket ${TICKET} priority → ${after.ticket.priority}`,
  ],
  [
    note?.public === false && note.body.includes(refunds.data[0]?.id ?? "?"),
    "private note names the refund",
  ],
]);
await boss.stop({ graceful: false });
await db.$client.end();
