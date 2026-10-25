import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { generateDevCerts } from "../../apps/iam/src/dev-certs.ts";

/**
 * One entry point for running and testing Rehearsal locally: `pnpm rehearsal <command>`.
 *
 * Each process gets only its own env file (.env for the API, .env.planner, .env.executor), with
 * every variable those files define stripped from the inherited shell first, so a worker can't
 * pick up the other side's credentials from the terminal. The workers' own startup checks still
 * run; this only stops the script from being the thing that leaks.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const COMPOSE = ["compose", "-f", "infra/compose.yaml"];
const ERA_CORE = [
  "stripe-planning",
  "stripe-operational",
  "zendesk-planning",
  "zendesk-operational",
];
const ERA_SLACK = ["slack-planning", "slack-operational"];
const ENV_FILES = { api: ".env", planner: ".env.planner", executor: ".env.executor" } as const;
/** Optional: the execution-rehearsal worker (T3.16). Without it, rehearsals stay queued. */
const REHEARSAL_ENV = ".env.rehearsal";
const IAM_PORT = 3443;
const IAM_DEV_CERTS = resolve(ROOT, "infra/iam/dev");

const HELP = `pnpm rehearsal <command> [flags]

  doctor          check Docker, env files, Postgres and the Era worlds
  up              start the Era worlds (and the compose Postgres when .env points at it),
                  wait until they're writable, then reset and seed them
                    --core       skip the Slack worlds
                    --no-reset   leave the worlds' current state alone
  start           run IAM, the API, the executor worker and the planner worker.
                  IAM is mTLS on 127.0.0.1:3443. Dev certificates are generated under
                  infra/iam/dev. The planner is not given a certificate or the IAM url.
                    --web        also run the Vite dev server (the API serves the built web app)
                    --no-planner skip the planner worker (no model key or ADC)
  test            typecheck, lint and unit tests
                    --db         also the real-Postgres tests (DB_TESTS=1)
                    --era        also the Era conformance tests (ERA_CONFORMANCE=1) and smoke:apply
                    --all        both
  smoke           smoke:era, then smoke:apply against the running API
  reset           reset and seed the worlds (demo:reset)
  stop            kill leftover API, worker and "start" processes (a killed terminal leaves them)
  down            stop the processes, then the containers (volumes are kept)
  status          show containers and which local ports answer`;

function loadEnv(file: string): Record<string, string> {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}

/** Every variable any env file (or the example) defines: none of them is inherited from the shell. */
function managedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of [...Object.values(ENV_FILES), REHEARSAL_ENV, ".env.example"]) {
    for (const k of Object.keys(loadEnv(f))) keys.add(k);
  }
  // The planner must not inherit a way to reach IAM from the shell. `start` adds these only to
  // IAM, the API and the executor.
  for (const k of [
    "IAM_URL",
    "IAM_PORT",
    "IAM_HOST",
    "IAM_RULES_DIR",
    "IAM_CLIENT_CERT",
    "IAM_CLIENT_KEY",
    "IAM_CLIENT_CA",
    "IAM_TLS_CERT",
    "IAM_TLS_KEY",
    "IAM_TLS_CLIENT_CA",
  ]) {
    keys.add(k);
  }
  return keys;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const managed = managedKeys();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!managed.has(k)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * One shell command line from the script's own fixed arguments, never user input. It goes through
 * a shell so `pnpm.cmd` resolves on Windows; an args array with `shell: true` is deprecated (DEP0190).
 */
function commandLine(cmd: string, args: string[]): string {
  const quote = (a: string) => (/^[\w@./:={},-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
  return [cmd, ...args.map(quote)].join(" ");
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const line = commandLine(cmd, args);
  console.log(`\n$ ${line}`);
  return spawnSync(line, { cwd: ROOT, env, stdio: "inherit", shell: true }).status === 0;
}

function quiet(cmd: string, args: string[], timeoutMs = 20_000) {
  return spawnSync(commandLine(cmd, args), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: true,
  });
}

function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host, port });
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

function dbTarget(url: string | undefined): { host: string; port: number } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 5432) };
  } catch {
    return undefined;
  }
}

/** The compose Postgres binds 127.0.0.1:5432; anything else in .env is a Postgres you run yourself. */
function usesComposePostgres(api: Record<string, string>): boolean {
  const t = dbTarget(api.DATABASE_URL);
  return !t || (["localhost", "127.0.0.1"].includes(t.host) && t.port === 5432);
}

function dockerUp(): boolean {
  const r = quiet("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

function eraUrls(api: Record<string, string>, slack: boolean): [string, string][] {
  const keys = [
    "ERA_STRIPE_PLANNING_URL",
    "ERA_STRIPE_OPERATIONAL_URL",
    "ERA_ZENDESK_PLANNING_URL",
    "ERA_ZENDESK_OPERATIONAL_URL",
    ...(slack ? ["ERA_SLACK_PLANNING_URL", "ERA_SLACK_OPERATIONAL_URL"] : []),
  ];
  return keys.filter((k) => api[k]).map((k) => [k, api[k] as string]);
}

async function eraAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/_meta", url), { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function doctor(): Promise<boolean> {
  let ok = true;
  const line = (good: boolean, msg: string) => {
    console.log(`${good ? "ok  " : "FAIL"} ${msg}`);
    if (!good) ok = false;
  };
  line(dockerUp(), "Docker engine answers (start Docker Desktop if not)");
  for (const [who, f] of Object.entries(ENV_FILES)) {
    line(
      existsSync(resolve(ROOT, f)),
      `${f} exists (${who}; copy the matching section of .env.example)`,
    );
  }
  const api = loadEnv(ENV_FILES.api);
  const db = dbTarget(api.DATABASE_URL);
  if (db) line(await tcpOpen(db.host, db.port), `Postgres reachable at ${db.host}:${db.port}`);
  else line(false, "DATABASE_URL set in .env");
  for (const [k, url] of eraUrls(api, Boolean(api.ERA_SLACK_PLANNING_URL))) {
    line(await eraAnswers(url), `${k} answers at ${url}`);
  }
  // A warning, not a failure: everything but a model-planned rehearsal runs without one.
  const planner = loadEnv(ENV_FILES.planner);
  const model = planner.PLANNER_MODEL ?? "claude-sonnet-5-5";
  const hasModel = model.startsWith("gemini-")
    ? Boolean(planner.GOOGLE_CLOUD_PROJECT)
    : Boolean(planner.ANTHROPIC_API_KEY);
  if (!hasModel) {
    console.log(
      `warn planner: no credentials for ${model} in .env.planner (ANTHROPIC_API_KEY, or GOOGLE_CLOUD_PROJECT for gemini-*)`,
    );
  }
  return ok;
}

async function waitForEra(api: Record<string, string>, slack: boolean): Promise<boolean> {
  const urls = eraUrls(api, slack);
  for (let i = 0; i < 60; i++) {
    const up = await Promise.all(urls.map(([, u]) => eraAnswers(u)));
    if (up.every(Boolean)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("The Era worlds didn't answer within 2 minutes. Check `pnpm rehearsal status`.");
  return false;
}

async function up(flags: Set<string>): Promise<boolean> {
  generateDevCerts(IAM_DEV_CERTS);
  if (!dockerUp()) {
    console.error("Docker isn't answering. Start Docker Desktop, then run this again.");
    return false;
  }
  const api = loadEnv(ENV_FILES.api);
  const slack = !flags.has("--core");
  const services = [
    ...(usesComposePostgres(api) ? ["postgres"] : []),
    ...ERA_CORE,
    ...(slack ? ERA_SLACK : []),
  ];
  if (!usesComposePostgres(api)) {
    console.log(
      `DATABASE_URL points at your own Postgres (${dbTarget(api.DATABASE_URL)?.port}); not starting the compose one.`,
    );
  }
  const profile = slack ? ["--profile", "full"] : [];
  if (!run("docker", [...COMPOSE, ...profile, "up", "-d", ...services])) return false;
  if (!(await waitForEra(api, slack))) return false;
  const env = { ...process.env, ...api };
  if (!run("pnpm", ["-s", "smoke:era"], env)) return false;
  if (!flags.has("--no-reset") && !run("pnpm", ["-s", "demo:reset"], env)) return false;
  return true;
}

async function startAll(flags: Set<string>): Promise<boolean> {
  const procs: { name: string; child: ChildProcess }[] = [];
  const certs = generateDevCerts(IAM_DEV_CERTS);
  const iamMaterial = {
    iam: {
      IAM_TLS_CERT: certs.serverCert,
      IAM_TLS_KEY: certs.serverKey,
      IAM_TLS_CLIENT_CA: certs.ca,
      IAM_PORT: String(IAM_PORT),
    },
    api: {
      IAM_URL: `https://127.0.0.1:${IAM_PORT}`,
      IAM_CLIENT_CERT: certs.apiCert,
      IAM_CLIENT_KEY: certs.apiKey,
      IAM_CLIENT_CA: certs.ca,
    },
    executor: {
      IAM_URL: `https://127.0.0.1:${IAM_PORT}`,
      IAM_CLIENT_CERT: certs.executorCert,
      IAM_CLIENT_KEY: certs.executorKey,
      IAM_CLIENT_CA: certs.ca,
    },
  };

  const launch = (
    name: string,
    file: string,
    args: string[],
    extra: Record<string, string> = {},
  ) => {
    if (!existsSync(resolve(ROOT, file))) {
      console.error(`${file} is missing; not starting ${name}.`);
      return;
    }
    const child = spawn(commandLine("pnpm", args), {
      cwd: ROOT,
      env: cleanEnv({ ...loadEnv(file), ...extra }),
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
    });
    const tag = `[${name}]`.padEnd(11);
    const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
      let buf = "";
      stream?.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) out.write(`${tag} ${l}\n`);
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("exit", (code) => console.log(`${tag} exited with ${code}`));
    procs.push({ name, child });
  };

  const api = loadEnv(ENV_FILES.api);
  const port = Number(api.API_PORT ?? 3000);
  if (await tcpOpen("127.0.0.1", port)) {
    console.error(
      `Something is already listening on :${port}. Stop it first (an earlier \`start\`?).`,
    );
    return false;
  }
  launch("iam", ENV_FILES.api, ["--filter", "@rehearsal/iam", "start"], iamMaterial.iam);
  launch("api", ENV_FILES.api, ["--filter", "@rehearsal/api", "start"], iamMaterial.api);
  // The workers mint their Era tenant tokens through the API at startup, so it has to be up first.
  let apiUp = false;
  for (let i = 0; i < 60 && !apiUp; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    apiUp = await tcpOpen("127.0.0.1", port);
  }
  if (!apiUp)
    console.error(`The API didn't open :${port} within a minute; starting the workers anyway.`);
  launch(
    "executor",
    ENV_FILES.executor,
    ["--filter", "@rehearsal/executor-worker", "start"],
    iamMaterial.executor,
  );
  if (!flags.has("--no-planner")) {
    launch("planner", ENV_FILES.planner, ["--filter", "@rehearsal/planner-worker", "start"]);
  }
  if (existsSync(resolve(ROOT, REHEARSAL_ENV))) {
    launch("rehearsal", REHEARSAL_ENV, ["--filter", "@rehearsal/rehearsal-worker", "start"]);
  } else {
    console.log(`No ${REHEARSAL_ENV}: execution rehearsals will stay queued (see .env.example).`);
  }
  if (flags.has("--web")) launch("web", ENV_FILES.api, ["--filter", "@rehearsal/web", "dev"]);
  console.log(`The app is at http://localhost:${port}/. Ctrl+C stops everything.`);

  return new Promise((done) => {
    const stop = () => {
      for (const { child } of procs) {
        if (child.exitCode !== null || child.pid === undefined) continue;
        // On Windows the pnpm shell's node children survive a plain kill and keep taking jobs.
        if (process.platform === "win32")
          quiet("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        else process.kill(-child.pid, "SIGTERM");
      }
      done(true);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function test(flags: Set<string>): Promise<boolean> {
  const db = flags.has("--db") || flags.has("--all");
  const era = flags.has("--era") || flags.has("--all");
  const api = loadEnv(ENV_FILES.api);
  const env = cleanEnv({
    ...(db || era ? api : {}),
    ...(db ? { DB_TESTS: "1", DATABASE_URL: api.TEST_DATABASE_URL ?? api.DATABASE_URL ?? "" } : {}),
    ...(era ? { ERA_CONFORMANCE: "1" } : {}),
  });
  for (const step of [["typecheck"], ["lint"], ["test"]]) {
    if (!run("pnpm", ["-s", ...step], env)) return false;
  }
  if (era) return smoke();
  return true;
}

/** smoke:apply needs the API and an executor worker running (`pnpm rehearsal start`). */
async function smoke(): Promise<boolean> {
  const api = loadEnv(ENV_FILES.api);
  const env = { ...process.env, ...api };
  if (!run("pnpm", ["-s", "smoke:era"], env)) return false;
  if (!(await tcpOpen("127.0.0.1", Number(api.API_PORT ?? 3000)))) {
    console.log(
      "\nSkipped smoke:apply: the API isn't running. Start it with `pnpm rehearsal start`.",
    );
    return true;
  }
  return run("pnpm", ["-s", "smoke:apply"], env);
}

async function status(): Promise<boolean> {
  if (dockerUp()) run("docker", [...COMPOSE, "--profile", "full", "ps"]);
  else console.log("Docker isn't answering.");
  const api = loadEnv(ENV_FILES.api);
  const port = Number(api.API_PORT ?? 3000);
  console.log(`API on :${port}: ${(await tcpOpen("127.0.0.1", port)) ? "up" : "down"}`);
  console.log(`IAM on :${IAM_PORT}: ${(await tcpOpen("127.0.0.1", IAM_PORT)) ? "up" : "down"}`);
  return doctor();
}

/**
 * What `start` launches: itself, the pnpm wrappers, and the tsx processes under them. Matched on
 * the command line, because an orphaned child no longer has a parent PID to kill it through.
 */
const OURS = [
  String.raw`rehearsal[\\/]cli\.ts[" ]+start`,
  '@rehearsal/(api|executor-worker|planner-worker|rehearsal-worker|iam)[" ]+start',
  String.raw`rehearsal[\\/]node_modules.*tsx.*src[\\/]main\.ts`,
].join("|");

function stop(): boolean {
  if (process.platform === "win32") {
    const ps = `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match '${OURS}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $_.ProcessId }`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    const killed = r.stdout.trim().split(/\s+/).filter(Boolean);
    console.log(
      killed.length
        ? `Stopped ${killed.length} process(es): ${killed.join(", ")}`
        : "Nothing to stop.",
    );
    return true;
  }
  spawnSync("pkill", ["-f", OURS], { stdio: "inherit" });
  return true;
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest);
const commands: Record<string, () => boolean | Promise<boolean>> = {
  doctor,
  up: () => up(flags),
  start: () => startAll(flags),
  test: () => test(flags),
  smoke,
  reset: () => run("pnpm", ["-s", "demo:reset"], { ...process.env, ...loadEnv(ENV_FILES.api) }),
  stop,
  down: () => stop() && run("docker", [...COMPOSE, "--profile", "full", "down"]),
  status,
};

const fn = command ? commands[command] : undefined;
if (!fn) {
  console.log(HELP);
  process.exitCode = command && command !== "help" ? 1 : 0;
} else {
  // exitCode, not process.exit(): see scripts/smoke/era-meta.ts on the Windows libuv assertion.
  process.exitCode = (await fn()) ? 0 : 1;
}
