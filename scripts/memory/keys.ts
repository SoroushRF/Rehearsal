import { memoryConfigFromEnv, memoryKeyGrants } from "@rehearsal/memory";
import {
  adminFor,
  ambiguousGenerations,
  generations,
  KeyCommandRefused,
  LAST_USED_CAVEAT,
  lastUsed,
  mintKey,
  mintPair,
  refuseAmbiguous,
  refuseExisting,
  revokeKeys,
  revokeOld,
  revokeOldCheck,
  revokeOldPlan,
  rotate,
  validLabel,
} from "./keys-run";

/**
 * Mints, rotates and revokes the Agent Memory keys Rehearsal runs with (#365, T1.55), using the
 * operator's admin key (SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY in .env). No process
 * but this one, `pnpm memory:erase-org` and the memory gate ever holds the admin key.
 *
 *   pnpm memory:keys mint <label>            rehearsal-api-<label> and rehearsal-planner-<label>;
 *                                            refused once the label has any keys
 *   pnpm memory:keys rotate <label>          the next generation, rehearsal-api-<label>-g<N> and
 *                                            rehearsal-planner-<label>-g<N>; the old pair still works
 *   pnpm memory:keys status <label>          each key's dates and last use, and whether
 *                                            --revoke-old would go ahead; prints no key
 *   pnpm memory:keys rotate <label> --revoke-old [--force]
 *                                            revokes the generations older than the newest pair,
 *                                            once both new keys are in use (--force: anyway)
 *   pnpm memory:keys revoke <label>          every generation of the label
 *   pnpm memory:keys mint-reader <label>     rehearsal-reader-<label>: read-only, for operator
 *   pnpm memory:keys revoke-reader <label>   checks such as `pnpm memory:drift` (T1.53)
 *
 * The API's key reads and writes below the precedent scope and may register an org's scope; the
 * planner's and the reader's only read (`memoryKeyGrants`, the same grants the memory gate
 * checks). A mint or a rotation prints each new key once, as the line for that process's env
 * file; the service doesn't show it again. Nothing else prints a key. Exit codes: 0 done,
 * 1 refused (nothing changed), 2 bad usage, 3 an error from the service, a revoke that failed,
 * or a refusal because the keys aren't as the runbook expects (`KeyCommandUnsafe`).
 */

// Usage first, so a mistyped command says so before anything reads the admin key.
const COMMAND_NAMES = [
  "mint",
  "rotate",
  "status",
  "revoke",
  "mint-reader",
  "revoke-reader",
] as const;
type Command = (typeof COMMAND_NAMES)[number];
const isCommand = (c: string): c is Command => (COMMAND_NAMES as readonly string[]).includes(c);
const [command = "", label = "", ...rest] = process.argv.slice(2);
const revokeOldFlag = command === "rotate" && rest[0] === "--revoke-old";
const force = revokeOldFlag && rest[1] === "--force";
const flagsOk = rest.length === 0 || (revokeOldFlag && rest.length === (force ? 2 : 1));
if (!isCommand(command) || !validLabel(label) || !flagsOk) {
  console.error(
    `usage: pnpm memory:keys ${COMMAND_NAMES.join("|")} <label>, or rotate <label> --revoke-old [--force]   (label: lowercase, digits, dashes; not ending in -g<digits>)`,
  );
  process.exit(2);
}

const config = memoryConfigFromEnv("admin");
if (config === null) {
  console.error("needs SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY (in .env)");
  process.exit(1);
}
const admin = adminFor(config);
const log = (line: string) => console.log(line);

const ENV_LINES = (api: string, planner: string) =>
  [
    `# API (.env, or the rehearsal-api service)\nSURREAL_AGENT_MEMORY_WRITE_KEY=${api}\n`,
    `# Planner worker (.env.planner, or the rehearsal-planner service)\nSURREAL_AGENT_MEMORY_READ_KEY=${planner}`,
  ].join("\n");

/** Revokes by name; exits 3 if any revoke failed. */
async function revokeAll(names: readonly string[]) {
  const revoked = await revokeKeys(admin, names, log);
  if (revoked.length < names.length) {
    console.error(`${names.length - revoked.length} key(s) were not revoked; run again`);
    process.exitCode = 3;
  }
}

const COMMANDS: Record<Command, (label: string, scope: string) => Promise<void>> = {
  async mint(label, scope) {
    await refuseExisting(admin, label);
    // The org scopes are registered below this one as orgs first publish; it must exist first.
    const res = await admin("POST", "/scopes", { path: scope });
    if (!res.ok)
      throw new Error(`POST /scopes → ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { api, planner } = await mintPair(admin, label, 1, memoryKeyGrants(scope), log);
    console.log(`Minted below ${scope}. Each key is shown once:\n`);
    console.log(ENV_LINES(api, planner));
  },
  async rotate(label, scope) {
    if (revokeOldFlag) {
      const { kept, revoked, failed } = await revokeOld(admin, label, log, { force });
      console.log(`\nKept generation ${kept.generation}. Revoked ${revoked.length} older key(s).`);
      if (failed.length > 0) {
        console.error(`Not revoked: ${failed.join(", ")}. Run again.`);
        process.exitCode = 3;
      }
      return;
    }
    const rotated = await rotate(admin, label, memoryKeyGrants(scope), log);
    const older = rotated.previous.map((g) => g.generation).join(", ");
    console.log(
      `Minted generation ${rotated.generation} below ${scope}: ${rotated.names.api} and ${rotated.names.planner}. Each key is shown once:\n`,
    );
    console.log(ENV_LINES(rotated.api, rotated.planner));
    console.log(`
The older generation (${older}) still works. Next, in this order:
  1. In Render, set SURREAL_AGENT_MEMORY_WRITE_KEY on rehearsal-api and
     SURREAL_AGENT_MEMORY_READ_KEY on rehearsal-planner to the values above. Paste each straight
     into that one service's field: never into chat, a ticket, a shared group or a repo file.
  2. Deploy both services.
  3. Check the deploy replaced every instance of both services. Use both new keys: open a
     completed run's promote panel (the API's key) and plan for an org with active precedents
     (the planner's). Then pnpm memory:keys status ${label} should show both new keys used
     and no old key used after them or in the last 15 min. lastUsedAt can lag or stay empty on
     the hosted service, so the deploy check is what proves the old keys are free.
  4. pnpm memory:keys rotate ${label} --revoke-old`);
  },
  async status(label) {
    const live = await generations(admin, label);
    if (live.length === 0) {
      console.log(`no live keys for ${label}`);
      return;
    }
    for (const g of live) {
      for (const k of [g.api, g.planner]) {
        if (k) {
          console.log(
            `generation ${g.generation} ${k.name}: created ${k.createdAt ?? "?"}, ${lastUsed(k)}`,
          );
        }
      }
      if (!g.api || !g.planner) console.log(`generation ${g.generation} is incomplete`);
    }
    const ambiguous = ambiguousGenerations(live);
    for (const p of ambiguous) console.log(`problem: ${p}`);
    const plan = revokeOldPlan(live);
    if (plan === null || plan.old.length === 0) {
      console.log("--revoke-old: nothing older than the newest complete pair to revoke");
      return;
    }
    const { problems } = revokeOldCheck(plan.kept, plan.old);
    for (const p of problems) console.log(`--revoke-old would refuse: ${p}`);
    console.log(LAST_USED_CAVEAT);
    if (ambiguous.length === 0 && problems.length === 0) {
      console.log(
        `--revoke-old would keep generation ${plan.kept.generation} and revoke ${plan.old.map((g) => g.generation).join(", ")}`,
      );
    }
  },
  async revoke(label) {
    const live = await generations(admin, label);
    refuseAmbiguous(live, label);
    const names = live.flatMap((g) => [g.api?.name, g.planner?.name]).filter(Boolean) as string[];
    if (names.length === 0) throw new KeyCommandRefused(`no live keys for ${label}`);
    await revokeAll(names);
  },
  async "mint-reader"(label, scope) {
    // The planner's grants (read only), on a key of the operator's own: never the planner's key.
    const name = `rehearsal-reader-${label}`;
    const key = await mintKey(admin, name, memoryKeyGrants(scope).planner);
    console.log(`Minted ${name}, read-only below ${scope}. Shown once:\n`);
    console.log(
      `# Operator checks (pnpm memory:drift), in .env.drift; never .env, .env.planner or a deployed service\nSURREAL_AGENT_MEMORY_READ_KEY=${key}`,
    );
  },
  async "revoke-reader"(label) {
    await revokeAll([`rehearsal-reader-${label}`]);
  },
};

try {
  await COMMANDS[command](label, config.scope);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof KeyCommandRefused ? 1 : 3;
}
