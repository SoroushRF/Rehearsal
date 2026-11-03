import { memoryConfigFromEnv, memoryKeyGrants } from "@rehearsal/memory";

/**
 * Mints and revokes the two Agent Memory keys Rehearsal runs with (#365), using the operator's
 * admin key (SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY in .env). Neither process ever
 * holds the admin key.
 *
 *   pnpm memory:keys mint <label>     rehearsal-api-<label> and rehearsal-planner-<label>
 *   pnpm memory:keys revoke <label>
 *
 * The API's key reads and writes below the precedent scope and may register an org's scope; the
 * planner's only reads (`memoryKeyGrants`, the same grants the memory gate checks). `mint` prints
 * each key once, as the line to put in that process's env file; the service doesn't show it again.
 */

const [command, label] = process.argv.slice(2);
if ((command !== "mint" && command !== "revoke") || !label || !/^[a-z0-9-]+$/.test(label)) {
  console.error("usage: pnpm memory:keys mint|revoke <label>   (label: lowercase, digits, dashes)");
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

const names = { api: `rehearsal-api-${label}`, planner: `rehearsal-planner-${label}` };

if (command === "revoke") {
  for (const name of Object.values(names)) {
    const res = await admin("DELETE", `/keys/${encodeURIComponent(name)}`);
    console.log(
      `${name}: ${res.status === 204 ? "revoked" : `${res.status} ${await detail(res)}`}`,
    );
  }
} else {
  // The org scopes are registered below this one as orgs first publish; it must exist first.
  const scope = await admin("POST", "/scopes", { path: config.scope });
  if (!scope.ok) throw new Error(`POST /scopes → ${scope.status} ${await detail(scope)}`);

  const grants = memoryKeyGrants(config.scope);
  const minted: Record<keyof typeof names, string> = { api: "", planner: "" };
  for (const role of ["api", "planner"] as const) {
    const res = await admin("POST", "/keys", { name: names[role], grants: grants[role] });
    if (res.status !== 201) {
      throw new Error(`POST /keys ${names[role]} → ${res.status} ${await detail(res)}`);
    }
    minted[role] = ((await res.json()) as { key: string }).key;
  }
  console.log(`Minted below ${config.scope}. Each key is shown once:\n`);
  console.log(
    `# API (.env, or the rehearsal-api service)\nSURREAL_AGENT_MEMORY_WRITE_KEY=${minted.api}\n`,
  );
  console.log(
    `# Planner worker (.env.planner, or the rehearsal-planner service)\nSURREAL_AGENT_MEMORY_READ_KEY=${minted.planner}`,
  );
}
