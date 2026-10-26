import type { World } from "@rehearsal/contracts";
import { orgTenant } from "@rehearsal/core";
import { z } from "zod";
import { NO_REDIRECTS } from "./era";
import {
  REHEARSAL_URL_KEYS,
  resolveRehearsalWorld,
  resolveWorld,
  SHARED_URL_KEYS,
  type WorldConfig,
  worldEnvKey,
  worldUrl,
} from "./worlds";

/** A signed tenant token and when it stops working (epoch ms). */
export const MintedToken = z.object({ token: z.string().min(1), expiresAt: z.number().int() });
export type MintedToken = z.infer<typeof MintedToken>;

/** Something that hands out a current tenant token, or throws. Never a plaintext tenant name. */
export interface TokenSource {
  get(): Promise<string>;
}

/** Refresh this long before expiry (tokens live 3600 s on the pinned images). */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Caches a minted token and re-mints once `now` is inside the refresh margin. If a refresh fails
 * while the old token is still valid, the old token is used; once it has expired, `get()` throws.
 * It never falls back to an unsigned tenant, which the simulators would serve as "default".
 */
export class RefreshingTokenSource implements TokenSource {
  #current: MintedToken | undefined;
  #inflight: Promise<MintedToken> | undefined;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    private readonly clock: { now(): Date } = { now: () => new Date() },
    private readonly marginMs = DEFAULT_REFRESH_MARGIN_MS,
  ) {}

  async get(): Promise<string> {
    const now = this.clock.now().getTime();
    const current = this.#current;
    if (current && now < current.expiresAt - this.marginMs) return current.token;
    try {
      // One mint at a time, however many requests are waiting.
      this.#inflight ??= this.mint().finally(() => {
        this.#inflight = undefined;
      });
      const minted = MintedToken.parse(await this.#inflight);
      if (minted.expiresAt <= this.clock.now().getTime()) throw new Error("minted token expired");
      this.#current = minted;
      return minted.token;
    } catch (error) {
      if (current && this.clock.now().getTime() < current.expiresAt) return current.token;
      throw new Error(`no valid Era tenant token: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** Worker role → the world it may touch and the secret it presents to the operator's minter. */
export const WORKER_ROLES = {
  planner: { world: "planning", secretEnv: "PLANNER_WORKER_SECRET" },
  executor: { world: "operational", secretEnv: "EXECUTOR_WORKER_SECRET" },
} as const satisfies Record<string, { world: World; secretEnv: string }>;
export type WorkerRole = keyof typeof WORKER_ROLES;

/** Path of the operator's mint route in apps/api. */
export const TENANT_TOKEN_ROUTE = "/internal/era/tenant-token";

type EraVendor = "stripe" | "zendesk" | "slack";
/** A rehearsal has no Slack world: the operator's rehearsal mint route refuses it. */
type RehearsalVendor = "stripe" | "zendesk";

/**
 * A worker's Stripe and Zendesk worlds, plus the executor's Slack world when its URL is set (only
 * the executor posts the optional run summary), each carrying a token source that mints through the operator (the API
 * process, which alone holds ERA_ADMIN_TOKEN). The worker's secret only ever mints tokens for its
 * own world.
 */
export function workerWorlds(
  role: WorkerRole,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    clock?: { now(): Date };
    fetch?: typeof fetch;
    /**
     * The org whose job this is (#330): its own tenant, `orgTenant(orgId)`, in this worker's own
     * world. The operator mints it only while this worker's queue has live work for that org.
     */
    orgId?: string;
  } = {},
): Record<"stripe" | "zendesk", WorldConfig> & { slack?: WorldConfig } {
  const { world, secretEnv } = WORKER_ROLES[role];
  const apiUrl = env.REHEARSAL_API_URL?.replace(/\/$/, "");
  const secret = env[secretEnv];
  if (!apiUrl) throw new Error("REHEARSAL_API_URL is not set");
  if (!secret) throw new Error(`${secretEnv} is not set`);
  const doFetch = options.fetch ?? fetch;

  const bind = (vendor: EraVendor): WorldConfig => {
    const mint = async () => {
      const res = await doFetch(`${apiUrl}${TENANT_TOKEN_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ vendor, ...(options.orgId ? { orgId: options.orgId } : {}) }),
        ...NO_REDIRECTS,
      });
      if (!res.ok) throw new Error(`mint ${vendor}/${world} → ${res.status}`);
      return MintedToken.parse(await res.json());
    };
    const tenant = options.orgId ? orgTenant(options.orgId) : undefined;
    return {
      ...resolveWorld(vendor, world, env, tenant),
      tenantToken: new RefreshingTokenSource(mint, options.clock),
    };
  };
  return {
    stripe: bind("stripe"),
    zendesk: bind("zendesk"),
    ...(role === "executor" && env[worldEnvKey("slack", world)] ? { slack: bind("slack") } : {}),
  };
}

/** Mint every world's token now, so a misconfigured minter fails at startup, not mid-run. */
export async function primeTokens(worlds: Record<string, WorldConfig>): Promise<void> {
  for (const world of Object.values(worlds)) {
    if (typeof world.tenantToken !== "object") throw new Error(`${world.baseUrl} has no token`);
    await world.tenantToken.get();
  }
}

// --- Execution rehearsal worker (T1.23, decision 0013 §3) -------------------

/** Path of the operator's rehearsal mint route in apps/api. Separate from the workers' route. */
export const REHEARSAL_TENANT_TOKEN_ROUTE = "/internal/era/rehearsal-tenant-token";

/**
 * The operator's routes the rehearsal worker calls with REHEARSAL_WORKER_SECRET (T3.16, decision
 * 0013 §3): seed a claimed rehearsal's tenants from its stored plan, and reset them once it has
 * ended. The admin token stays in the API; neither route returns a token or a world.
 */
export const REHEARSAL_PROVISION_ROUTE = "/internal/rehearsals/:id/provision";
export const REHEARSAL_TEARDOWN_ROUTE = "/internal/rehearsals/:id/teardown";
export const REHEARSAL_CHALLENGE_ROUTE = "/internal/rehearsals/:id/challenge";
export const rehearsalOperatorPath = (route: string, rehearsalId: string) =>
  route.replace(":id", encodeURIComponent(rehearsalId));

/** What the operator minted, and for which tenant and container, so the worker can check both. */
export const RehearsalMintedToken = MintedToken.extend({
  tenant: z.string().min(1),
  baseUrl: z.url(),
});
export type RehearsalMintedToken = z.infer<typeof RehearsalMintedToken>;

/**
 * What a rehearsal worker refuses to start next to: model keys, both admin tokens, the other
 * workers' secrets, and every planning and operational URL. The names are listed, not matched by a
 * `REHEARSAL_` prefix, because REHEARSAL_API_URL is every worker's way to the API.
 */
export const REHEARSAL_WORKER_FORBIDDEN = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ERA_ADMIN_TOKEN",
  "REHEARSAL_ERA_ADMIN_TOKEN",
  "PLANNER_WORKER_SECRET",
  "EXECUTOR_WORKER_SECRET",
  ...SHARED_URL_KEYS,
] as const;

/** What the planner and executor refuse: the rehearsal admin token, secret and worlds. */
export const REHEARSAL_CREDENTIALS = [
  "REHEARSAL_ERA_ADMIN_TOKEN",
  "REHEARSAL_WORKER_SECRET",
  ...Object.values(REHEARSAL_URL_KEYS),
] as const;

export function rehearsalWorkerViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return REHEARSAL_WORKER_FORBIDDEN.filter((k) => env[k]);
}

/**
 * One rehearsal's Stripe and Zendesk worlds for the rehearsal worker. Each token is minted by the
 * operator for this rehearsal only, with REHEARSAL_WORKER_SECRET, and refreshed before it expires.
 * A mint for another tenant, or for a container other than the one this worker is configured to
 * call, fails closed: the operator, which knows every world, checked that its URL isn't a shared one.
 */
export function rehearsalWorkerWorlds(
  rehearsalId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { clock?: { now(): Date }; fetch?: typeof fetch } = {},
): Record<RehearsalVendor, WorldConfig> {
  const violations = rehearsalWorkerViolations(env);
  if (violations.length > 0) {
    throw new Error(`a rehearsal worker must not hold ${violations.join(", ")}`);
  }
  const apiUrl = env.REHEARSAL_API_URL?.replace(/\/$/, "");
  const secret = env.REHEARSAL_WORKER_SECRET;
  if (!apiUrl) throw new Error("REHEARSAL_API_URL is not set");
  if (!secret) throw new Error("REHEARSAL_WORKER_SECRET is not set");
  const doFetch = options.fetch ?? fetch;

  const bind = (vendor: RehearsalVendor): WorldConfig => {
    const config = resolveRehearsalWorld(vendor, rehearsalId, env);
    const mint = async () => {
      const res = await doFetch(`${apiUrl}${REHEARSAL_TENANT_TOKEN_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ vendor, rehearsalId }),
        ...NO_REDIRECTS,
      });
      if (!res.ok) throw new Error(`mint ${vendor}/${config.tenant} → ${res.status}`);
      const minted = RehearsalMintedToken.parse(await res.json());
      if (minted.tenant !== config.tenant) {
        throw new Error(`minted for ${minted.tenant}, not ${config.tenant}`);
      }
      if (worldUrl(minted.baseUrl) !== worldUrl(config.baseUrl)) {
        throw new Error(`minted for ${minted.baseUrl}, but configured for ${config.baseUrl}`);
      }
      return { token: minted.token, expiresAt: minted.expiresAt };
    };
    return { ...config, tenantToken: new RefreshingTokenSource(mint, options.clock) };
  };
  return { stripe: bind("stripe"), zendesk: bind("zendesk") };
}
