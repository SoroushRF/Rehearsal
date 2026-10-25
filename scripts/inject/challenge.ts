import type { PlanManifest, RehearsalScenarioRef } from "@rehearsal/contracts";
import {
  assertRehearsalChallengeTarget,
  type ChallengeOperation,
  challengeOperations,
  injectChargeRecord,
  type ResolvedScenario,
  resolveScenario,
} from "@rehearsal/core";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  resolveRehearsalWorld,
  SHARED_URL_KEYS,
  worldEndpoint,
} from "@rehearsal/providers";
import { fixtureTemplates } from "@rehearsal/testkit";
import { rehearsalAdminToken } from "../seed/snapshot";

/**
 * T4.11 operator side. Applies a resolved, allowlisted challenge to one rehearsal tenant.
 *
 * Inject and the teammate edit stay here, with the rehearsal admin token, and only on worlds
 * `resolveRehearsalWorld` accepts. A lost response and a failed step are transport modes: this
 * module returns them as waiting and does not invent a fault body for them. v1 sets no
 * container-wide fault, so there is nothing to clean up and nothing that can reach another
 * rehearsal or a planning or operational world. A reset is not this module's job.
 */

export interface AppliedChallenges {
  scenario: ResolvedScenario;
  /** What this call sent. */
  applied: string[];
  /** Challenges this phase does not perform. The runner applies them at their own time. */
  waiting: string[];
}

export async function applyRehearsalChallenges(opts: {
  rehearsalId: string;
  manifest: PlanManifest;
  scenario: RehearsalScenarioRef;
  phase: "before_run" | "after_rejected";
  /** The step that was rejected. Required when `phase` is `after_rejected`. */
  actionId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AppliedChallenges> {
  const env = opts.env ?? process.env;
  const resolved = resolveScenario(opts.manifest, opts.scenario);
  if (!resolved.ok) throw new Error(resolved.reason);
  if (resolved.scenario.containerWide) {
    throw new Error(
      "refusing a container-wide fault: this catalog version has no confirmed cleanup",
    );
  }
  if (opts.phase === "after_rejected" && !opts.actionId) {
    throw new Error("an edit after a rejection names the step that was rejected");
  }

  const applied: string[] = [];
  const waiting: string[] = [];
  for (const op of challengeOperations(resolved.scenario)) {
    if (opts.phase === "before_run" && op.kind === "inject_records") {
      await injectCharges(opts.rehearsalId, op, env);
      applied.push(`inject ${op.charges.map((c) => c.id).join(", ")}`);
      continue;
    }
    if (
      opts.phase === "after_rejected" &&
      op.kind === "vendor_write" &&
      op.when.afterActionId === opts.actionId
    ) {
      await writeTicket(opts.rehearsalId, op, env);
      applied.push(`priority ${op.body.ticket.priority} on ${op.path}`);
      continue;
    }
    waiting.push(waitingLabel(op));
  }
  return { scenario: resolved.scenario, applied, waiting };
}

function waitingLabel(op: ChallengeOperation): string {
  switch (op.kind) {
    case "inject_records":
      return "inject waits for the before-run phase";
    case "vendor_write":
      return `ticket edit waits until ${op.when.afterActionId} is ${op.when.outcome}, before compensation reads the ticket`;
    case "runner_transport":
      return `${op.mode} ${op.actionId}${op.thenRestart ? " then restart" : ""}`;
  }
}

function sharedEndpoints(env: NodeJS.ProcessEnv): string[] {
  const endpoints: string[] = [];
  for (const key of SHARED_URL_KEYS) {
    const raw = env[key];
    if (!raw) continue;
    endpoints.push(worldEndpoint(raw));
  }
  return endpoints;
}

async function injectCharges(
  rehearsalId: string,
  op: Extract<ChallengeOperation, { kind: "inject_records" }>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (op.path !== "/inject") throw new Error("a challenge injects records and does nothing else");
  const world = resolveRehearsalWorld("stripe", rehearsalId, env);
  assertRehearsalChallengeTarget({
    rehearsalId,
    tenant: world.tenant,
    endpoint: worldEndpoint(world.baseUrl),
    sharedEndpoints: sharedEndpoints(env),
  });
  const template = fixtureTemplates().charge;
  const charges = op.charges.map((charge) => injectChargeRecord(template, charge));
  const res = await eraAdmin(world, rehearsalAdminToken(env), "/inject", { charges });
  if (!res.ok) throw new Error(`/inject → ${res.status} ${await res.text()}`);
}

async function writeTicket(
  rehearsalId: string,
  op: Extract<ChallengeOperation, { kind: "vendor_write" }>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const config = resolveRehearsalWorld("zendesk", rehearsalId, env);
  assertRehearsalChallengeTarget({
    rehearsalId,
    tenant: config.tenant,
    endpoint: worldEndpoint(config.baseUrl),
    sharedEndpoints: sharedEndpoints(env),
  });
  const { token } = await mintTenantToken(config, rehearsalAdminToken(env));
  const res = await eraFetch({ ...config, tenantToken: token }, op.path, {
    method: op.method,
    headers: { "content-type": "application/json", authorization: "Bearer rehearsal-challenge" },
    body: JSON.stringify(op.body),
  });
  if (!res.ok) throw new Error(`${op.method} ${op.path} → ${res.status} ${await res.text()}`);
}
