import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { AgentMemoryClient } from "../src/client";
import { memoryConfigFromEnv } from "../src/config";

/**
 * Plumbing for the memory gate on the hosted service. Each run works in its own scope under
 * rehearsal/test and erases it afterwards. Operator calls (erase, key minting) live here, not in
 * src: `/scopes/forget` erases permanently and ignores `dryRun`.
 */

export const LIVE = process.env.MEMORY_GATE === "1";

const ENV = new URL("../../../.env", import.meta.url);
if (LIVE && existsSync(ENV)) process.loadEnvFile(ENV);

export function liveConfig() {
  const config = memoryConfigFromEnv();
  if (config === null) throw new Error("MEMORY_GATE=1 needs SURREAL_AGENT_MEMORY_* in .env");
  return config;
}

export const runId = () => `g${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

export function clientWithKey(apiKey: string): AgentMemoryClient {
  const { scope: _, ...config } = liveConfig();
  return new AgentMemoryClient({ ...config, apiKey });
}

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  const { url, context, apiKey } = liveConfig();
  return fetch(`${url.replace(/\/+$/, "")}/api/v1/${context}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A key for the same principal, narrowed to memory reads and writes under `subtree`. */
export async function mintNarrowKey(name: string, subtree: string): Promise<string> {
  const res = await admin("POST", "/keys", {
    name,
    grants: {
      "memory:read": [`${subtree}/*`],
      "memory:write": [`${subtree}/*`],
      "scope:create": ["/*"],
    },
  });
  if (res.status !== 201) throw new Error(`POST /keys → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { key: string }).key;
}

export async function revokeKey(name: string): Promise<number> {
  return (await admin("DELETE", `/keys/${encodeURIComponent(name)}`)).status;
}

/** Erase everything under `scope`, then tombstone the scope nodes, deepest first. */
export async function eraseScope(scope: string, nodes: string[]): Promise<void> {
  const res = await admin("POST", "/scopes/forget", { path: scope });
  if (!res.ok) throw new Error(`POST /scopes/forget → ${res.status} ${await res.text()}`);
  for (const node of nodes) await admin("DELETE", `/scopes?path=${encodeURIComponent(node)}`);
}
