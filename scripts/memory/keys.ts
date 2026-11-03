import { memoryConfigFromEnv, memoryKeyGrants } from "@rehearsal/memory";
import {
  adminFor,
  generations,
  KeyCommandRefused,
  keyNames,
  lastUsed,
  mintKey,
  mintPair,
  revokeKeys,
  revokeOld,
  rotate,
  validLabel,
} from "./keys-run";

/**
 * Mints, rotates and revokes the Agent Memory keys Rehearsal runs with (#365, T1.55), using the
 * operator's admin key (SURREAL_AGENT_MEMORY_URL, _CONTEXT and _ADMIN_KEY in .env). No process
 * but this one, `pnpm memory:erase-org` and the memory gate ever holds the admin key.
 *
 *   pnpm memory:keys mint <label>            rehearsal-api-<label> and rehearsal-planner-<label>
 *   pnpm memory:keys rotate <label>          the next generation, rehearsal-api-<label>-g<N> and
 *                                            rehearsal-planner-<label>-g<N>; the old pair still works
 *   pnpm memory:keys rotate <label> --revoke-old
 *                                            revokes the generations older than the newest pair
 *   pnpm memory:keys revoke <label>          every generation of the label
 *   pnpm memory:keys mint-reader <label>     rehearsal-reader-<label>: read-only, for operator
 *   pnpm memory:keys revoke-reader <label>   checks such as `pnpm memory:drift` (T1.53)
 *
 * The API's key reads and writes below the precedent scope and may register an org's scope; the
 * planner's and the reader's only read (`memoryKeyGrants`, the same grants the memory gate
 * checks). A mint or a rotation prints each new key once, as the line for that process's env
 * file; the service doesn't show it again. Nothing else prints a key. Exit codes: 0 done,
 * 1 refused (nothing changed), 2 bad usage, 3 an error from the service.
 */

// Usage first, so a mistyped command says so before anything reads the admin key.
const COMMAND_NAMES = ["mint", "rotate", "revoke", "mint-reader", "revoke-reader"] as const;
type Command = (typeof COMMAND_NAMES)[number];
const isCommand = (c: string): c is Command => (COMMAND_NAMES as readonly string[]).includes(c);
const [command = "", label = "", ...rest] = process.argv.slice(2);
const revokeOldFlag = command === "rotate" && rest.length === 1 && rest[0] === "--revoke-old";
if (!isCommand(command) || !validLabel(label) || (rest.length > 0 && !revokeOldFlag)) {
  console.error(
    `usage: pnpm memory:keys ${COMMAND_NAMES.join("|")} <label>, or rotate <label> --revoke-old   (label: lowercase, digits, dashes; not ending in -g<digits>)`,
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

const COMMANDS: Record<Command, (label: string, scope: string) => Promise<void>> = {
  async mint(label, scope) {
    // The org scopes are registered below this one as orgs first publish; it must exist first.
    const res = await admin("POST", "/scopes", { path: scope });
    if (!res.ok)
      throw new Error(`POST /scopes → ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { api, planner } = await mintPair(admin, label, 1, memoryKeyGrants(scope));
    console.log(`Minted below ${scope}. Each key is shown once:\n`);
    console.log(ENV_LINES(api, planner));
  },
  async rotate(label, scope) {
    if (revokeOldFlag) {
      const { kept, revoked } = await revokeOld(admin, label, log);
      console.log(
        `\nKept generation ${kept.generation}: ${kept.api?.name} (${lastUsed(kept.api)}), ${kept.planner?.name} (${lastUsed(kept.planner)}). Revoked ${revoked.length} older key(s).`,
      );
      if (!kept.api?.lastUsedAt || !kept.planner?.lastUsedAt) {
        console.log(
          "A kept key has never been used. That is expected until the API syncs or the planner recalls; if either service is still on an older key, it now gets 401 from Agent Memory: set the new value and deploy it.",
        );
      }
      return;
    }
    const rotated = await rotate(admin, label, memoryKeyGrants(scope));
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
  3. Check the planner's ready log says "precedents on" and the API's precedent list reports
     sync enabled (no "Agent Memory not configured" warning at startup).
  4. pnpm memory:keys rotate ${label} --revoke-old`);
  },
  async revoke(label) {
    const live = await generations(admin, label);
    const names = live.flatMap((g) => [g.api?.name, g.planner?.name]).filter(Boolean) as string[];
    if (names.length === 0) {
      // Not listed: revoke the first generation's names anyway, which says 404 if they're gone.
      await revokeKeys(admin, Object.values(keyNames(label)), log);
      return;
    }
    await revokeKeys(admin, names, log);
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
    await revokeKeys(admin, [`rehearsal-reader-${label}`], log);
  },
};

try {
  await COMMANDS[command](label, config.scope);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof KeyCommandRefused ? 1 : 3;
}
