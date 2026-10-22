import type { World } from "@rehearsal/contracts";
import { z } from "zod";
import { resolveWorld, type WorldConfig } from "./worlds";

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

type EraVendor = "stripe" | "zendesk";

/**
 * A worker's Stripe and Zendesk worlds, each carrying a token source that mints through the
 * operator (the API process, which alone holds ERA_ADMIN_TOKEN). The worker's secret only ever
 * mints tokens for its own world.
 */
export function workerWorlds(
  role: WorkerRole,
  env: NodeJS.ProcessEnv = process.env,
  options: { clock?: { now(): Date }; fetch?: typeof fetch } = {},
): Record<EraVendor, WorldConfig> {
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
        body: JSON.stringify({ vendor }),
      });
      if (!res.ok) throw new Error(`mint ${vendor}/${world} → ${res.status}`);
      return MintedToken.parse(await res.json());
    };
    return {
      ...resolveWorld(vendor, world, env),
      tenantToken: new RefreshingTokenSource(mint, options.clock),
    };
  };
  return { stripe: bind("stripe"), zendesk: bind("zendesk") };
}

/** Mint every world's token now, so a misconfigured minter fails at startup, not mid-run. */
export async function primeTokens(worlds: Record<string, WorldConfig>): Promise<void> {
  for (const world of Object.values(worlds)) {
    if (typeof world.tenantToken !== "object") throw new Error(`${world.baseUrl} has no token`);
    await world.tenantToken.get();
  }
}
