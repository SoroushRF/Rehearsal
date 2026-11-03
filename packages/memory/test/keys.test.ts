import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adminFor,
  generations,
  KeyCommandRefused,
  keyNames,
  mintPair,
  parseKeyName,
  revokeOld,
  rotate,
  validLabel,
} from "../../../scripts/memory/keys-run";
import { AgentMemoryClient } from "../src/client";
import { memoryKeyGrants } from "../src/config";
import { AgentMemoryPrecedents } from "../src/precedents";
import { FakeAgentMemory } from "./fake-agent-memory";
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

    const { kept, revoked } = await revokeOld(w.admin, "prod", w.log);
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
    await expect(rotate(failing, "prod", GRANTS)).rejects.toThrow(/503/);
    expect(w.fake.named.has(keyNames("prod", 2).api)).toBe(false);
    expect((await generations(w.admin, "prod")).map((g) => g.generation)).toEqual([1]);
  });

  it("refuses bad usage before it reads the admin key", () => {
    for (const args of [
      ["rotate"],
      ["rotate", "prod-g2"],
      ["rotate", "prod", "--revoke"],
      ["mint", "prod", "--revoke-old"],
      ["rotate", "prod", "--revoke-old", "extra"],
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
