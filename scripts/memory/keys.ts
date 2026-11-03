import { memoryConfigFromEnv, memoryKeyGrants } from "@rehearsal/memory";

/**
 * Mints and revokes the Agent Memory keys Rehearsal runs with (#365), using the operator's admin
 * key (SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY in .env). No process but this one and
 * the memory gate ever holds the admin key.
 *
 *   pnpm memory:keys mint <label>            rehearsal-api-<label> and rehearsal-planner-<label>
 *   pnpm memory:keys revoke <label>
 *   pnpm memory:keys mint-reader <label>     rehearsal-reader-<label>: read-only, for operator
 *   pnpm memory:keys revoke-reader <label>   checks such as `pnpm memory:drift` (T1.53)
 *
 * The API's key reads and writes below the precedent scope and may register an org's scope; the
 * planner's and the reader's only read (`memoryKeyGrants`, the same grants the memory gate
 * checks). A mint prints each key once, as the line for that process's env file; the service
 * doesn't show it again.
 */

// Usage first, so a mistyped command says so before anything reads the admin key.
const COMMAND_NAMES = ["mint", "revoke", "mint-reader", "revoke-reader"] as const;
type Command = (typeof COMMAND_NAMES)[number];
const isCommand = (c: string): c is Command => (COMMAND_NAMES as readonly string[]).includes(c);
const [command = "", label = ""] = process.argv.slice(2);
if (!isCommand(command) || !/^[a-z0-9-]+$/.test(label)) {
  console.error(
    `usage: pnpm memory:keys ${COMMAND_NAMES.join("|")} <label>   (label: lowercase, digits, dashes)`,
  );
  process.exit(2);
}

const config = memoryConfigFromEnv("admin");
if (config === null) {
  console.error("needs SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY (in .env)");
  process.exit(1);
}
const base = `${config.url.replace(/\/+$/, "")}/api/v1/${encodeURIComponent(config.context)}`;

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${config?.apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

/** The response body, trimmed: never the request, which carries no secret but the header. */
async function detail(res: Response): Promise<string> {
  return (await res.text()).slice(0, 300);
}

/** Mints one key with exactly `grants` and returns it. */
async function mintKey(name: string, grants: unknown): Promise<string> {
  const res = await admin("POST", "/keys", { name, grants });
  if (res.status !== 201)
    throw new Error(`POST /keys ${name} → ${res.status} ${await detail(res)}`);
  return ((await res.json()) as { key: string }).key;
}

async function revokeKeys(names: string[]): Promise<void> {
  for (const name of names) {
    const res = await admin("DELETE", `/keys/${encodeURIComponent(name)}`);
    console.log(
      `${name}: ${res.status === 204 ? "revoked" : `${res.status} ${await detail(res)}`}`,
    );
  }
}

const names = (label: string) => ({
  api: `rehearsal-api-${label}`,
  planner: `rehearsal-planner-${label}`,
  reader: `rehearsal-reader-${label}`,
});

const COMMANDS: Record<Command, (label: string, scope: string) => Promise<void>> = {
  async mint(label, scope) {
    // The org scopes are registered below this one as orgs first publish; it must exist first.
    const res = await admin("POST", "/scopes", { path: scope });
    if (!res.ok) throw new Error(`POST /scopes → ${res.status} ${await detail(res)}`);
    const grants = memoryKeyGrants(scope);
    const api = await mintKey(names(label).api, grants.api);
    const planner = await mintKey(names(label).planner, grants.planner);
    console.log(`Minted below ${scope}. Each key is shown once:\n`);
    console.log(
      `# API (.env, or the rehearsal-api service)\nSURREAL_AGENT_MEMORY_WRITE_KEY=${api}\n`,
    );
    console.log(
      `# Planner worker (.env.planner, or the rehearsal-planner service)\nSURREAL_AGENT_MEMORY_READ_KEY=${planner}`,
    );
  },
  async revoke(label) {
    await revokeKeys([names(label).api, names(label).planner]);
  },
  async "mint-reader"(label, scope) {
    // The planner's grants (read only), on a key of the operator's own: never the planner's key.
    const name = names(label).reader;
    const key = await mintKey(name, memoryKeyGrants(scope).planner);
    console.log(`Minted ${name}, read-only below ${scope}. Shown once:\n`);
    console.log(
      `# Operator checks (pnpm memory:drift), in .env.drift; never .env, .env.planner or a deployed service\nSURREAL_AGENT_MEMORY_READ_KEY=${key}`,
    );
  },
  async "revoke-reader"(label) {
    await revokeKeys([names(label).reader]);
  },
};

await COMMANDS[command](label, config.scope);
