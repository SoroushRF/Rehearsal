import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { createDb, loadRegistry, memoryErased, recordMemoryErasure } from "@rehearsal/db";
import { AgentMemoryClient, memoryConfigFromEnv } from "@rehearsal/memory";
import { confirmationMatches, databaseTarget, EraseRefused, eraseOrg } from "./erase-run";
import { adminFor } from "./keys-run";

/**
 * Erases one organization's Agent Memory scope (T1.55, #398), with the operator's admin key and
 * DATABASE_URL (both in .env). An operator command: app code never erases memory.
 *
 *   pnpm memory:erase-org <org>                 dry run, then type the org ID to erase
 *   pnpm memory:erase-org <org> --yes <org>     for scripts: the same ID twice, or nothing happens
 *   ... --force                                 erase even if Postgres and memory disagree
 *
 * It always lists first with reads only (`/scopes/forget` ignores `dryRun`), showing the database,
 * memory URL, context and base scope it acts on, and refuses (exit 3) when the registry and the
 * scope don't agree (`eraseMismatches`), unless `--force`. Then it records an
 * append-only `erased` event in Postgres before it forgets anything, then forgets and tombstones
 * the scope. From the event on, the API's sync, the planner's recall (through its plan jobs), the
 * promote panel's hint and the drift check refuse the org. The registry in Postgres is not
 * touched: plans that cite its precedents still check against it, and planning and execution
 * carry on without memory. Exits 0 erased, 1 aborted, 2 bad usage, 3 an error or a mismatch.
 */

const USAGE =
  "usage: pnpm memory:erase-org <org> [--yes <org>] [--force]   (exit 0 erased, 1 aborted, 2 usage, 3 error or a target mismatch)";
const ORG = /^[A-Za-z0-9_-]+$/;

// Usage first, so a mistyped command says so before anything reads a credential.
const argv = process.argv.slice(2);
const force = argv.includes("--force");
if (argv.filter((a) => a === "--force").length > 1) {
  console.error(USAGE);
  process.exit(2);
}
const args = argv.filter((a) => a !== "--force");
const yesAt = args.indexOf("--yes");
const yes = yesAt === -1 ? null : (args[yesAt + 1] ?? "");
const positional = args.filter((_, i) => yesAt === -1 || (i !== yesAt && i !== yesAt + 1));
const orgId = positional[0] ?? "";
if (
  positional.length !== 1 ||
  positional.some((a) => a.startsWith("-")) ||
  !ORG.test(orgId) ||
  args.filter((a) => a === "--yes").length > 1 ||
  (yes !== null && (yes === "" || yes.startsWith("-")))
) {
  console.error(USAGE);
  process.exit(2);
}
if (yes !== null && yes !== orgId) {
  console.error(`--yes ${JSON.stringify(yes)} doesn't match ${orgId}; nothing was read or erased`);
  process.exit(2);
}

function fail(message: string): never {
  console.error(message);
  process.exit(3);
}

let config: ReturnType<typeof memoryConfigFromEnv>;
try {
  config = memoryConfigFromEnv("admin");
} catch (err) {
  fail(String(err instanceof Error ? err.message : err));
}
const url = process.env.DATABASE_URL;
if (config === null || !url) {
  fail("needs DATABASE_URL plus SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY (in .env)");
}

function operator(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

async function typed(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // A closed stdin (no terminal, no --yes) never answers: treat it as no.
    const answer = await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(`\nThis permanently erases the scope above. Type the org ID to go on: `).then(
        resolve,
        () => resolve(null),
      );
    });
    return confirmationMatches(answer, orgId);
  } finally {
    rl.close();
  }
}

const { scope: baseScope, ...clientConfig } = config;
const db = createDb(url);
try {
  const result = await eraseOrg({
    admin: adminFor(clientConfig),
    client: new AgentMemoryClient(clientConfig),
    baseScope,
    orgId,
    registry: (await loadRegistry(db, orgId)).entries,
    alreadyErased: await memoryErased(db, orgId),
    targets: {
      database: databaseTarget(url),
      memoryUrl: clientConfig.url,
      context: clientConfig.context,
    },
    force,
    confirm: async () => yes === orgId || (await typed()),
    record: async (kind, scope, summary) => {
      await recordMemoryErasure(db, { orgId, kind, scope, summary, operator: operator() });
    },
    log: (line) => console.log(line),
  });
  process.exitCode = result.outcome === "erased" ? 0 : 1;
} catch (err) {
  console.error(
    err instanceof EraseRefused
      ? err.message
      : `erase failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 3;
} finally {
  await db.$client.end();
}
