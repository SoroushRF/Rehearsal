import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthzCheck, AuthzRuleFile, PERMISSIONS_V1 } from "@rehearsal/contracts";
import {
  PLANNER_JOB_ROUTES,
  REHEARSAL_TENANT_TOKEN_ROUTE,
  TENANT_TOKEN_ROUTE,
} from "@rehearsal/providers";
import { afterAll, describe, expect, it, vi } from "vitest";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import { buildApp } from "../src/app";
import type { ApplyDeps } from "../src/apply";
import type { ApprovalDeps } from "../src/approvals";
import type { PlanDeps } from "../src/plans";
import type { PrecedentDeps } from "../src/precedents";
import type { RehearsalTokenDeps } from "../src/rehearsal-tokens";
import type { RehearseDeps } from "../src/rehearse";
import type { RunDeps } from "../src/runs";
import type { TenantTokenDeps } from "../src/tenant-tokens";

// `buildApp` adds its routes before returning, so the hook goes on as each instance is created.
const registered = vi.hoisted(() => new Set<string>());
vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const create = ((opts?: object) => {
    const app = mod.default(opts);
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD" && method !== "OPTIONS") registered.add(`${method} ${route.url}`);
      }
    });
    return app;
  }) as typeof mod.default;
  return { ...mod, default: create };
});

const file = AuthzRuleFile.parse(raw);
const ADMIT = "run:admit";

/** Registered routes that take no rule (decision 0014, point 5). */
const EXEMPT: Record<string, string> = {
  "GET /api/health": "liveness, no person and no org",
  "GET /api/me": "signed in with an active org; returns identity and permissions, no rule",
  [`POST ${PLANNER_JOB_ROUTES.next}`]: "planner worker's machine secret, not a person",
  [`POST ${PLANNER_JOB_ROUTES.complete}`]: "planner worker's machine secret, not a person",
  [`POST ${PLANNER_JOB_ROUTES.fail}`]: "planner worker's machine secret, not a person",
  [`POST ${TENANT_TOKEN_ROUTE}`]: "worker machine secret, not a person",
  [`POST ${REHEARSAL_TENANT_TOKEN_ROUTE}`]: "rehearsal worker's machine secret, not a person",
  "GET /*": "@fastify/static serving the built web app",
};

const webRoot = mkdtempSync(join(tmpdir(), "rehearsal-authz-"));
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Review</title>");
afterAll(() => rmSync(webRoot, { recursive: true }));

/** Every route either build registers: the no-database stubs, and the real handlers (never called). */
async function registeredRoutes() {
  const fake = <T>() => ({}) as T;
  for (const app of [
    buildApp({ webRoot }),
    buildApp({
      webRoot,
      apply: fake<ApplyDeps>(),
      plans: fake<PlanDeps>(),
      approvals: fake<ApprovalDeps>(),
      runs: fake<RunDeps>(),
      rehearse: fake<RehearseDeps>(),
      precedents: fake<PrecedentDeps>(),
      reviewer: () => null,
      tenantTokens: fake<TenantTokenDeps>(),
      rehearsalTokens: fake<RehearsalTokenDeps>(),
    }),
  ]) {
    await app.ready();
    await app.close();
  }
  return [...registered].sort();
}

const roleSet = (role: keyof typeof file.roles) => new Set(file.roles[role]);
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((p) => b.has(p));

/** The `where` filters of every `some` and `seats` check, at any depth. */
function grantFilters(checks: AuthzCheck[]): AuthzCheck[][] {
  return checks.flatMap((c) => {
    if ("some" in c) return [c.some.where, ...grantFilters(c.some.where)];
    if ("seats" in c) return [c.seats.where, ...grantFilters(c.seats.where)];
    return [];
  });
}

describe("rehearsal-authz@1", () => {
  it("parses as an AuthzRuleFile with the agreed id, version and Clerk mapping", () => {
    expect(file.id).toBe("rehearsal-authz");
    expect(file.version).toBe(1);
    expect(file.rolesFromClerk).toEqual({
      "org:owner": "owner",
      "org:finance_lead": "finance_lead",
      "org:support_lead": "support_lead",
      "org:member": "member",
    });
  });

  it("climbs member ⊂ support_lead ⊂ finance_lead ⊂ owner, with owner holding everything", () => {
    const ladder = [
      ["member", "support_lead"],
      ["support_lead", "finance_lead"],
      ["finance_lead", "owner"],
    ] as const;
    for (const [lower, upper] of ladder) {
      expect(isSubset(roleSet(lower), roleSet(upper)), `${lower} ⊂ ${upper}`).toBe(true);
      expect(roleSet(upper).size, `${lower} ⊂ ${upper}`).toBeGreaterThan(roleSet(lower).size);
    }
    for (const role of Object.keys(file.roles) as (keyof typeof file.roles)[]) {
      expect(file.roles[role]).toHaveLength(roleSet(role).size);
    }
    expect([...roleSet("owner")].sort()).toEqual([...PERMISSIONS_V1].sort());
    expect([...roleSet("member")].sort()).toEqual([
      "rehearsal:read:plan",
      "rehearsal:read:precedent",
      "rehearsal:read:run",
    ]);
    for (const perm of ["rehearsal:invite:member", "rehearsal:manage:role"] as const) {
      const holders = Object.entries(file.roles).filter(([, perms]) => perms.includes(perm));
      expect(holders.map(([role]) => role)).toEqual(["owner"]);
    }
  });

  it("keeps every person-facing rule inside the subject's org, behind a permission", () => {
    const people = file.rules.filter((r) => r.action !== ADMIT);
    expect(people.length).toBeGreaterThan(0);
    for (const rule of people) {
      expect(rule.abac, rule.action).toContainEqual({ eq: ["subject.orgId", "resource.orgId"] });
      expect(Object.keys(rule.rbac), rule.action).not.toHaveLength(0);
      if ("anyOf" in rule.rbac) expect(rule.rbac.anyOf, rule.action).not.toHaveLength(0);
    }
  });

  it("admits a run only on live grants for this org, hash and revision", () => {
    const admit = file.rules.filter((r) => r.action === ADMIT);
    expect(admit).toHaveLength(2);
    for (const rule of admit) {
      expect(rule.rbac).toEqual({});
      const filters = grantFilters(rule.abac);
      expect(filters.length).toBeGreaterThan(0);
      for (const where of filters) {
        expect(where).toEqual(
          expect.arrayContaining([
            { eq: ["item.orgId", "resource.orgId"] },
            { eq: ["item.planHash", "resource.planHash"] },
            { eq: ["item.revision", "resource.revision"] },
            { isNull: "item.revokedAt" },
            { gt: ["env.now", "item.grantedAt"] },
            { gt: ["item.expiresAt", "env.now"] },
          ]),
        );
      }
    }
    const kinds = admit.flatMap((r) => r.abac.flatMap((c) => Object.keys(c)));
    expect(kinds).toEqual(expect.arrayContaining(["some", "seats"]));
  });

  it("gates precedent routes on read, promote, and withdraw", () => {
    const rbac = (action: string) => {
      const matches = file.rules.filter((rule) => rule.action === action);
      expect(matches, action).toHaveLength(1);
      return matches[0]?.rbac;
    };
    expect(rbac("GET /api/precedents")).toEqual({ anyOf: ["rehearsal:read:precedent"] });
    expect(rbac("POST /api/runs/:id/precedents")).toEqual({
      anyOf: ["rehearsal:promote:precedent"],
    });
    expect(rbac("POST /api/precedents/:id/withdraw")).toEqual({
      anyOf: ["rehearsal:withdraw:precedent"],
    });
    for (const perm of ["rehearsal:promote:precedent", "rehearsal:withdraw:precedent"] as const) {
      expect(file.roles.finance_lead, perm).toContain(perm);
      expect(file.roles.owner, perm).toContain(perm);
      expect(file.roles.member, perm).not.toContain(perm);
      expect(file.roles.support_lead, perm).not.toContain(perm);
    }
  });

  it("has a rule for every registered route that is not exempt", async () => {
    const routes = await registeredRoutes();
    expect(routes).toContain("POST /api/plans/:id/apply");
    const actions = new Set(file.rules.map((r) => r.action));
    const missing = routes.filter((route) => !(route in EXEMPT) && !actions.has(route));
    expect(missing, `routes with no rule in rehearsal-authz@1: ${missing.join(", ")}`).toEqual([]);
    const staleExemptions = Object.keys(EXEMPT).filter((route) => !routes.includes(route));
    expect(staleExemptions, "exempted routes that are no longer registered").toEqual([]);
  });
});
