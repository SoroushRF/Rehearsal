import {
  createDb,
  enqueuePrecedentSync,
  precedentOrgs,
  precedentSyncPending,
  startPrecedentSender,
} from "@rehearsal/db";
import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  memoryConfigFromEnv,
  precedentScope,
} from "@rehearsal/memory";
import { driftCredentialViolations, runDrift } from "./drift-run";

/**
 * Compares Agent Memory with the precedent registry (T1.53, #395). Postgres decides; memory is a
 * derived recall index, so this reports where the index no longer matches and, with --repair,
 * queues the same `precedent-sync` jobs the API queues. The API's sync handler stays the only
 * writer: this process holds a read key and DATABASE_URL, and never the write or admin key. So it
 * reads `.env.drift`, not `.env` (which holds both), and refuses to start with either.
 *
 *   pnpm memory:drift <org> [--repair [--activate-waiting]]
 *   pnpm memory:drift --all [--repair [--activate-waiting]]
 *
 * --activate-waiting also queues the repairs that activate a version approved but never synced,
 * which moves its area's epoch. Exits 0 when memory matches, 1 when it found drift (queued or
 * not), 2 on bad usage, and 3 on any error, an org with no registry included. An org whose memory
 * was erased (T1.55) is refused: exit 3 when named, skipped with a line under --all.
 */

const FLAGS = ["--all", "--repair", "--activate-waiting"];
const USAGE =
  "usage: pnpm memory:drift <org>|--all [--repair [--activate-waiting]]   (exit 0 clean, 1 drift, 2 usage, 3 error)";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const orgs = args.filter((a) => !a.startsWith("-"));
const all = flags.includes("--all");
const repair = flags.includes("--repair");
const activateWaiting = flags.includes("--activate-waiting");
if (
  flags.some((f) => !FLAGS.includes(f)) ||
  (all ? orgs.length !== 0 : orgs.length !== 1) ||
  (activateWaiting && !repair)
) {
  console.error(USAGE);
  process.exit(2);
}

function fail(message: string): never {
  console.error(message);
  process.exit(3);
}

const violations = driftCredentialViolations();
if (violations.length > 0) {
  fail(
    `refusing to run with ${violations.join(", ")}: the drift check holds a read-only key (pnpm memory:keys mint-reader) and DATABASE_URL, in .env.drift`,
  );
}

let config: ReturnType<typeof memoryConfigFromEnv>;
try {
  config = memoryConfigFromEnv("read");
} catch (err) {
  fail(String(err instanceof Error ? err.message : err));
}
const url = process.env.DATABASE_URL;
if (config === null || !url) {
  fail(
    "needs DATABASE_URL plus SURREAL_AGENT_MEMORY_URL, _CONTEXT and a read-only _READ_KEY (in .env.drift)",
  );
}

const { scope: base, ...clientConfig } = config;
const client = new AgentMemoryClient(clientConfig);
const db = createDb(url);
let boss: Awaited<ReturnType<typeof startPrecedentSender>> | null = null;
try {
  // Sends only: no queue is created or updated, and no maintenance runs (the API owns those).
  boss = repair ? await startPrecedentSender(url) : null;
  const sender = boss;
  const result = await runDrift({
    db,
    orgs: all ? await precedentOrgs(db) : orgs,
    // k = 50, the service's cap, so the probes for unknown copies see as much as recall can.
    readerFor: (orgId) =>
      new AgentMemoryPrecedents(client, { scope: precedentScope(base, orgId), k: 50 }),
    log: (line) => console.log(line),
    activateWaiting,
    ...(sender && {
      enqueue: (job) =>
        db.transaction(async (tx) => {
          if (await precedentSyncPending(tx, job)) return "already_queued" as const;
          await enqueuePrecedentSync(sender, tx, job);
          return "queued" as const;
        }),
    }),
  });
  const queued = repair
    ? `; ${result.queued} sync jobs queued for the API, ${result.alreadyQueued} already queued${result.notActivated ? `, ${result.notActivated} left for --activate-waiting` : ""}`
    : "";
  console.log(`${result.findings} drift${queued}`);
  // An org named on the command line whose memory was erased is refused (exit 3); --all skips it.
  const refused = result.noRegistry.length > 0 || (!all && result.erased.length > 0);
  process.exitCode = refused ? 3 : result.findings > 0 ? 1 : 0;
} catch (err) {
  console.error(`drift check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 3;
} finally {
  await boss?.stop({ graceful: false });
  await db.$client.end();
}
