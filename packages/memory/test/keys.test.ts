import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adminFor,
  generations,
  KeyCommandRefused,
  KeyCommandUnsafe,
  keyNames,
  mintPair,
  parseKeyName,
  refuseExisting,
  revokeOld,
  rotate,
  validLabel,
} from "../../../scripts/memory/keys-run";
import { AgentMemoryClient } from "../src/client";
import { memoryKeyGrants } from "../src/config";
import { AgentMemoryPrecedents } from "../src/precedents";
import { FakeAgentMemory } from "./fake-agent-memory";
import { serveFake } from "./fake-server";
import { precedent, SCOPE } from "./fixtures";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ORG_SCOPE = `${SCOPE}/org-test`;
const GRANTS = memoryKeyGrants(SCOPE);

function world() {
  const fake = new FakeAgentMemory();
  const admin = adminFor({
    url: "http://fake/",
    context: "ctx",
    apiKey: "sp-test-key",
    fetch: fake.fetch,
  });
  const store = (apiKey: string) =>
    new AgentMemoryPrecedents(
      new AgentMemoryClient({ url: "http://fake/", context: "ctx", apiKey, fetch: fake.fetch }),
      { scope: ORG_SCOPE },
    );
  const lines: string[] = [];
  return { fake, admin, store, lines, log: (line: string) => lines.push(line) };
}

/** Whether `key` can still do its job: the API's publishes, the planner's reads back. */
async function works(w: ReturnType<typeof world>, role: "api" | "planner", key: string) {
  try {
    if (role === "api") await w.store(key).publish(precedent());
    else await w.store(key).read(precedent().id);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 401) return false;
    throw err;
  }
}

describe("key names and generations (T1.55)", () => {
  it("names generation 1 as mint always has, and later ones with a -g<N> suffix", () => {
    expect(keyNames("prod")).toEqual({
      api: "rehearsal-api-prod",
      planner: "rehearsal-planner-prod",
    });
    expect(keyNames("prod", 3).planner).toBe("rehearsal-planner-prod-g3");
    expect(parseKeyName("rehearsal-api-prod-g3", "prod")).toEqual({ role: "api", generation: 3 });
    expect(parseKeyName("rehearsal-planner-prod", "prod")).toEqual({
      role: "planner",
      generation: 1,
    });
    // Another label's keys, the reader, and a -g1 nobody mints are not this label's.
    for (const name of [
      "rehearsal-api-prod-eu",
      "rehearsal-api-prod-eu-g2",
      "rehearsal-reader-prod",
      "rehearsal-api-prod-g1",
      "rehearsal-api-prod-g0",
    ]) {
      expect(parseKeyName(name, "prod")).toBeNull();
    }
    // So no label may end like a generation.
    expect(validLabel("prod")).toBe(true);
    expect(validLabel("prod-g2")).toBe(false);
    expect(validLabel("Prod")).toBe(false);
  });
});

describe("pnpm memory:keys rotate against the fake (T1.55)", () => {
  it("mints a new pair with the same grants; the old pair works until --revoke-old, then stops", async () => {
    const w = world();
    // Before any key exists there is nothing to rotate or revoke.
    await expect(rotate(w.admin, "prod", GRANTS)).rejects.toBeInstanceOf(KeyCommandRefused);
    await w.admin("POST", "/scopes", { path: ORG_SCOPE });

    const first = await mintPair(w.admin, "prod", 1, GRANTS);
    expect(await works(w, "api", first.api)).toBe(true);
    // One generation: --revoke-old would revoke the newest pair, so it refuses and revokes nothing.
    await expect(revokeOld(w.admin, "prod", w.log)).rejects.toThrow(/only one/);
    expect(w.fake.named.size).toBe(2);

    const second = await rotate(w.admin, "prod", GRANTS);
    expect(second.generation).toBe(2);
    expect(second.names).toEqual(keyNames("prod", 2));
    expect([second.api, second.planner]).not.toContain(first.api);
    // Same grants as the first pair, from memoryKeyGrants.
    const minted = w.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/keys"));
    expect(minted.map((r) => r.body)).toEqual([
      { name: "rehearsal-api-prod", grants: GRANTS.api },
      { name: "rehearsal-planner-prod", grants: GRANTS.planner },
      { name: "rehearsal-api-prod-g2", grants: GRANTS.api },
      { name: "rehearsal-planner-prod-g2", grants: GRANTS.planner },
    ]);

    // Both generations work side by side while the services are redeployed.
    for (const [role, key] of [
      ["api", first.api],
      ["planner", first.planner],
      ["api", second.api],
      ["planner", second.planner],
    ] as const) {
      expect(await works(w, role, key)).toBe(true);
    }
    // The new planner key still only reads.
    await expect(w.store(second.planner).publish(precedent({ version: 2 }))).rejects.toMatchObject({
      status: 403,
    });

    const { kept, revoked } = await revokeOld(w.admin, "prod", w.log);
    expect(kept.generation).toBe(2);
    expect(revoked).toEqual(["rehearsal-api-prod", "rehearsal-planner-prod"]);
    expect(await works(w, "api", first.api)).toBe(false);
    expect(await works(w, "planner", first.planner)).toBe(false);
    expect(await works(w, "api", second.api)).toBe(true);
    expect(await works(w, "planner", second.planner)).toBe(true);

    // Again: generation 2 is now the only one, and is never revoked this way.
    await expect(revokeOld(w.admin, "prod", w.log)).rejects.toBeInstanceOf(KeyCommandRefused);
    expect([...w.fake.named.keys()]).toEqual(Object.values(keyNames("prod", 2)));
  });

  it("revokes every older generation, never the newest pair or an incomplete newer one", async () => {
    const w = world();
    await mintPair(w.admin, "prod", 1, GRANTS);
    await rotate(w.admin, "prod", GRANTS);
    await rotate(w.admin, "prod", GRANTS);
    // Another label's keys are someone else's.
    await mintPair(w.admin, "staging", 1, GRANTS);
    // A generation 4 whose planner key never got minted.
    await w.admin("POST", "/keys", { name: keyNames("prod", 4).api, grants: GRANTS.api });

    // Nobody has used generation 3: refused, nothing revoked, unless forced.
    await expect(revokeOld(w.admin, "prod", w.log)).rejects.toBeInstanceOf(KeyCommandUnsafe);
    expect(w.fake.named.size).toBe(9);
    const { kept, revoked } = await revokeOld(w.admin, "prod", w.log, { force: true });
    expect(kept.generation).toBe(3);
    expect(revoked.sort()).toEqual(
      [...Object.values(keyNames("prod", 1)), ...Object.values(keyNames("prod", 2))].sort(),
    );
    expect(w.lines.some((l) => l.startsWith("left alone: generation 4"))).toBe(true);
    expect((await generations(w.admin, "prod")).map((g) => g.generation)).toEqual([3, 4]);
    expect(w.fake.named.has("rehearsal-api-staging")).toBe(true);
  });

  it("takes the first key back when the second mint fails, so no generation is half there", async () => {
    const w = world();
    await mintPair(w.admin, "prod", 1, GRANTS);
    // The service refuses the planner's mint.
    const failing: typeof w.admin = (method, path, body) =>
      (body as { name?: string } | undefined)?.name === keyNames("prod", 2).planner
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : w.admin(method, path, body);
    await expect(rotate(failing, "prod", GRANTS, w.log)).rejects.toThrow(/503/);
    expect(w.fake.named.has(keyNames("prod", 2).api)).toBe(false);
    expect((await generations(w.admin, "prod")).map((g) => g.generation)).toEqual([1]);
    expect(w.lines).toContain(`${keyNames("prod", 2).api}: revoked`);
    expect(w.lines.some((l) => l.includes("still live"))).toBe(false);
  });

  it("says so, and names revoke <label>, when taking the first key back fails too", async () => {
    const w = world();
    await mintPair(w.admin, "prod", 1, GRANTS);
    const failing: typeof w.admin = (method, path, body) =>
      (body as { name?: string } | undefined)?.name === keyNames("prod", 2).planner ||
      method === "DELETE"
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : w.admin(method, path, body);
    await expect(rotate(failing, "prod", GRANTS, w.log)).rejects.toThrow(/503/);
    expect(w.fake.named.has(keyNames("prod", 2).api)).toBe(true);
    expect(w.lines).toContain(
      `${keyNames("prod", 2).api} is still live (never shown to anyone): run pnpm memory:keys revoke prod once the service answers`,
    );
  });

  it("--revoke-old checks use first: a kept key never used, or an old key used after it, refuses (T1.55 review)", async () => {
    const w = world();
    await w.admin("POST", "/scopes", { path: ORG_SCOPE });
    const first = await mintPair(w.admin, "prod", 1, GRANTS);
    expect(await works(w, "api", first.api)).toBe(true);
    expect(await works(w, "planner", first.planner)).toBe(true);
    const second = await rotate(w.admin, "prod", GRANTS);

    // Deployed but only the API moved: the new planner key was never used.
    expect(await works(w, "api", second.api)).toBe(true);
    await expect(revokeOld(w.admin, "prod", w.log)).rejects.toBeInstanceOf(KeyCommandUnsafe);
    expect(w.lines).toContain(
      `  problem: ${second.names.planner} has never been used: no service shows it runs on the new key yet`,
    );
    // The check is printed before anything is revoked, and nothing was.
    expect(w.lines.some((l) => l.startsWith(`  kept ${second.names.api}: created`))).toBe(true);
    expect(w.fake.requests.some((r) => r.method === "DELETE")).toBe(false);

    // Both new keys used, but something still runs on the old API key afterwards.
    expect(await works(w, "planner", second.planner)).toBe(true);
    expect(await works(w, "api", first.api)).toBe(true);
    w.lines.length = 0;
    await expect(revokeOld(w.admin, "prod", w.log)).rejects.toBeInstanceOf(KeyCommandUnsafe);
    expect(w.lines.some((l) => l.includes(`problem: ${first.names.api} was used at`))).toBe(true);
    expect(w.fake.named.size).toBe(4);

    // The new key used last: the old one was only used during the move. Goes ahead.
    expect(await works(w, "api", second.api)).toBe(true);
    w.lines.length = 0;
    const done = await revokeOld(w.admin, "prod", w.log);
    expect(done.revoked.sort()).toEqual(Object.values(keyNames("prod")).sort());
    expect(done.failed).toEqual([]);
    expect(w.lines).toContain(
      "  ok: both kept keys are in use, and no old key was used after them",
    );
  });

  it("--revoke-old reports the keys it failed to revoke", async () => {
    const w = world();
    await w.admin("POST", "/scopes", { path: ORG_SCOPE });
    await mintPair(w.admin, "prod", 1, GRANTS);
    const second = await rotate(w.admin, "prod", GRANTS);
    expect(await works(w, "api", second.api)).toBe(true);
    expect(await works(w, "planner", second.planner)).toBe(true);
    const failing: typeof w.admin = (method, path, body) =>
      method === "DELETE" && path.endsWith(encodeURIComponent(keyNames("prod").planner))
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : w.admin(method, path, body);
    const done = await revokeOld(failing, "prod", w.log);
    expect(done.revoked).toEqual([keyNames("prod").api]);
    expect(done.failed).toEqual([keyNames("prod").planner]);
  });

  it("mint refuses a label that has any generation, so it can't re-create generation 1 (T1.55 review)", async () => {
    const w = world();
    await refuseExisting(w.admin, "prod");
    await mintPair(w.admin, "prod", 1, GRANTS);
    await expect(refuseExisting(w.admin, "prod")).rejects.toBeInstanceOf(KeyCommandRefused);
    await rotate(w.admin, "prod", GRANTS);
    await revokeOld(w.admin, "prod", w.log, { force: true });
    // Only generation 2 is left; a mint would have put a second generation 1 beside it.
    await expect(refuseExisting(w.admin, "prod")).rejects.toThrow(/generation 2/);
    // Another label is free.
    await refuseExisting(w.admin, "staging");
  });

  it("refuses keys a pre-T1.55 label ending in -g<N> may own (T1.55 review)", async () => {
    // A gap: `mint prod-g3` before T1.55 made what reads as generation 3 of prod.
    const gap = world();
    await mintPair(gap.admin, "prod", 1, GRANTS);
    for (const name of Object.values(keyNames("prod", 3))) {
      await gap.admin("POST", "/keys", { name, grants: GRANTS.api });
    }
    for (const run of [
      () => rotate(gap.admin, "prod", GRANTS),
      () => revokeOld(gap.admin, "prod", gap.log, { force: true }),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(KeyCommandUnsafe);
    }
    expect(gap.fake.named.size).toBe(4);

    // Out of order: `mint prod-g2` was minted before prod's own first pair.
    const early = world();
    for (const name of Object.values(keyNames("prod", 2))) {
      await early.admin("POST", "/keys", { name, grants: GRANTS.api });
    }
    await mintPair(early.admin, "prod", 1, GRANTS);
    await expect(rotate(early.admin, "prod", GRANTS)).rejects.toThrow(
      /generation 2 was created before generation 1/,
    );
    expect(early.fake.named.size).toBe(4);
  });

  it("refuses bad usage before it reads the admin key", () => {
    for (const args of [
      ["rotate"],
      ["rotate", "prod-g2"],
      ["rotate", "prod", "--revoke"],
      ["mint", "prod", "--revoke-old"],
      ["rotate", "prod", "--revoke-old", "extra"],
      ["rotate", "prod", "--force"],
      ["rotate", "prod", "--force", "--revoke-old"],
      ["status", "prod", "--force"],
    ]) {
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/memory/keys.ts", ...args],
        {
          cwd: ROOT,
          env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
          encoding: "utf8",
        },
      );
      expect([args.join(" "), res.status]).toEqual([args.join(" "), 2]);
      expect(res.stderr).toContain("usage: pnpm memory:keys");
    }
  });
});

/** `pnpm memory:keys` itself, as a child process against the fake served over HTTP. */
function keysCli(args: string[], url: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/memory/keys.ts", ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        SURREAL_AGENT_MEMORY_URL: url,
        SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
        SURREAL_AGENT_MEMORY_ADMIN_KEY: "sp-test-key",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("pnpm memory:keys exit codes (T1.55 review)", () => {
  it("mint refuses an existing label (1); revoke-old refuses unused keys (3) unless --force; a failed revoke exits 3", async () => {
    const w = world();
    let failDeletes = false;
    const served = await serveFake(w.fake, (method) =>
      failDeletes && method === "DELETE" ? new Response("unavailable", { status: 503 }) : undefined,
    );
    try {
      const minted = await keysCli(["mint", "prod"], served.url);
      expect(minted.status).toBe(0);
      expect((await keysCli(["mint", "prod"], served.url)).status).toBe(1);
      expect((await keysCli(["rotate", "prod"], served.url)).status).toBe(0);

      // Nobody uses generation 2: the check is printed, nothing is revoked, exit 3.
      const refused = await keysCli(["rotate", "prod", "--revoke-old"], served.url);
      expect(refused.status).toBe(3);
      expect(refused.stdout).toContain("Check before revoking");
      expect(refused.stdout).toContain("has never been used");
      expect(w.fake.named.size).toBe(4);

      // status says the same, and prints no key.
      const status = await keysCli(["status", "prod"], served.url);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("--revoke-old would refuse");
      expect(status.stdout).not.toMatch(/sp-minted-/);

      // Forced, but the service fails the revokes: exit 3, and the keys are still there.
      failDeletes = true;
      const failed = await keysCli(["rotate", "prod", "--revoke-old", "--force"], served.url);
      expect(failed.status).toBe(3);
      expect(failed.stderr).toContain("Not revoked");
      expect(w.fake.named.size).toBe(4);
      const revokeFailed = await keysCli(["revoke", "prod"], served.url);
      expect(revokeFailed.status).toBe(3);
      expect(w.fake.named.size).toBe(4);

      failDeletes = false;
      expect(
        (await keysCli(["rotate", "prod", "--revoke-old", "--force"], served.url)).status,
      ).toBe(0);
      expect([...w.fake.named.keys()].sort()).toEqual(Object.values(keyNames("prod", 2)).sort());
      expect((await keysCli(["revoke", "prod"], served.url)).status).toBe(0);
      // Nothing left to revoke: refused, nothing sent.
      expect((await keysCli(["revoke", "prod"], served.url)).status).toBe(1);
    } finally {
      await served.close();
    }
  }, 120_000);
});
