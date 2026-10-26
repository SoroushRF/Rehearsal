import {
  type Action,
  type CompanyCharge,
  type CompanyCustomer,
  type CompanySlackMessage,
  CompanySnapshot,
  type CompanyTicket,
  PlanManifest,
  Receipt,
} from "@rehearsal/contracts";
import { type Db, schema } from "@rehearsal/db";
import {
  listCharges,
  listCustomers,
  listSlackMessages,
  listTickets,
  mintTenantToken,
  type ReadTarget,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authorizeCollection, bearerToken, type IamClient, refuse } from "./iam";

const { runs, stepReceipts, planVersions } = schema;

/** What the overview shows of the org's operational world: everything but `asOf` and `changed`. */
export type CompanyWorld = Pick<CompanySnapshot, "charges" | "customers" | "tickets" | "slack">;

export interface CompanyDeps {
  db: Db;
  iam?: IamClient;
  /**
   * Reads the org's operational world. The default reads the operational Era worlds with tenant
   * tokens the API mints with its own admin token (the API is the operator; no worker is given
   * anything here).
   */
  readWorld?: (orgId: string) => Promise<CompanyWorld>;
  /** Seeds a new org's worlds before its first read (#330, per-org tenants). Absent: no seeding. */
  ensureSeeded?: (orgId: string) => Promise<void>;
  now?: () => Date;
}

/**
 * `GET /api/company` (live demo, #330): the signed-in org's operational world as a company console,
 * plus which records a run of this org changed. Read-only. The org comes from the verified session,
 * never from the request.
 */
export function registerCompanyRoutes(app: FastifyInstance, deps: CompanyDeps): void {
  const read = deps.readWorld ?? ((orgId: string) => readOperationalWorld(orgId));
  app.get("/api/company", async (req, reply) => {
    const gate = await authorizeCollection(deps.iam, bearerToken(req), "GET /api/company");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    const { orgId } = gate.person;
    try {
      await deps.ensureSeeded?.(orgId);
      const [world, changed] = await Promise.all([read(orgId), changedBy(deps.db, orgId)]);
      return CompanySnapshot.parse({
        asOf: (deps.now?.() ?? new Date()).toISOString(),
        ...world,
        changed,
      });
    } catch (error) {
      req.log.error({ err: error }, "company snapshot failed");
      return reply.code(502).send({ error: "world_unavailable" });
    }
  });
}

/**
 * The record each confirmed write of this org's runs targeted, mapped to the run. Later receipts
 * win. A receipt is tied to its run by plan hash and approval; its target comes from the stored,
 * hash-checked plan's action, never from the receipt's own fields.
 */
export async function changedBy(db: Db, orgId: string): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(stepReceipts)
    .where(eq(stepReceipts.orgId, orgId))
    .orderBy(asc(stepReceipts.recordedAt));
  if (rows.length === 0) return {};
  const runRows = await db
    .select()
    .from(runs)
    .where(eq(runs.orgId, orgId))
    .orderBy(asc(runs.createdAt));
  const runOf = new Map<string, string>();
  for (const r of runRows) runOf.set(`${r.planHash}|${r.approvalId}`, r.id); // the latest wins
  const plans = new Map<string, Map<string, Action>>();
  const actionsOf = async (planHash: string) => {
    const cached = plans.get(planHash);
    if (cached) return cached;
    const [plan] = await db.select().from(planVersions).where(eq(planVersions.planHash, planHash));
    const manifest = plan && plan.orgId === orgId ? PlanManifest.safeParse(plan.manifest) : null;
    const byId = new Map(manifest?.success ? manifest.data.actions.map((a) => [a.id, a]) : []);
    plans.set(planHash, byId);
    return byId;
  };
  const changed: Record<string, string> = {};
  for (const row of rows) {
    const receipt = Receipt.safeParse(row.receipt);
    if (!receipt.success || receipt.data.outcome !== "confirmed") continue;
    const runId = runOf.get(`${row.planHash}|${receipt.data.approvalId}`);
    if (!runId) continue;
    const action = (await actionsOf(row.planHash)).get(row.actionId);
    if (!action) continue;
    for (const id of targetsOf(action, receipt.data)) changed[id] = runId;
  }
  return changed;
}

/** The overview record IDs a confirmed write changed. */
function targetsOf(action: Action, receipt: Receipt): string[] {
  switch (action.kind) {
    case "stripe.refund.create":
      return [action.args.chargeId];
    case "stripe.customer.balanceCredit":
      return [action.args.customerId];
    case "zendesk.ticket.patchFields":
    case "zendesk.ticket.appendPrivateNote":
    case "zendesk.ticket.appendPublicReply":
      return [String(action.args.ticketId)];
    case "slack.message.postSummary":
      return receipt.providerRef?.vendor === "slack" ? [receipt.providerRef.id] : [];
    default:
      return [];
  }
}

/**
 * The operational world of the org. Until each org has its own tenant (#330, PR B), every org
 * reads the shared operational tenant (`ERA_TENANT`).
 */
export async function readOperationalWorld(
  _orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompanyWorld> {
  const adminToken = env.ERA_ADMIN_TOKEN;
  if (!adminToken) throw new Error("ERA_ADMIN_TOKEN is not set");
  const target = async (config: WorldConfig, authorization: string): Promise<ReadTarget> => {
    const { token } = await mintTenantToken(config, adminToken);
    return {
      world: "operational",
      config: { ...config, tenantToken: token },
      authorization,
      timeoutMs: 10_000,
    };
  };
  const stripe = await target(
    resolveWorld("stripe", "operational", env),
    "Bearer sk_test_rehearsal_overview",
  );
  const zendesk = await target(
    resolveWorld("zendesk", "operational", env),
    "Bearer rehearsal-overview",
  );
  const channel = env.RUN_SUMMARY_CHANNEL;
  const slack =
    channel && env.ERA_SLACK_OPERATIONAL_URL
      ? await target(resolveWorld("slack", "operational", env), "Bearer xoxb-rehearsal-overview")
      : null;
  const [charges, customers, tickets, messages]: [
    CompanyCharge[],
    CompanyCustomer[],
    CompanyTicket[],
    CompanySlackMessage[],
  ] = await Promise.all([
    listCharges(stripe),
    listCustomers(stripe),
    listTickets(zendesk),
    slack && channel ? listSlackMessages(slack, channel) : Promise.resolve([]),
  ]);
  return { charges, customers, tickets, slack: messages };
}
