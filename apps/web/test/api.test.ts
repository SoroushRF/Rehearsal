import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ApiFetch, call, explain, RefusedError } from "../src/api";

const respond =
  (status: number, body: unknown): ApiFetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("call", () => {
  it("parses a success body and posts JSON", async () => {
    let sent: RequestInit | undefined;
    const apiFetch: ApiFetch = async (_path, init) => {
      sent = init;
      return new Response(JSON.stringify({ ok: 1 }), { status: 201 });
    };
    await expect(call(apiFetch, z.object({ ok: z.number() }), "/x", { a: 1 })).resolves.toEqual({
      ok: 1,
    });
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toBe('{"a":1}');
  });

  it("throws the server's refusal", async () => {
    const err = await call(
      respond(409, { error: "stale_revision", latestRevision: 3 }),
      z.any(),
      "/x",
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).refusal).toMatchObject({
      error: "stale_revision",
      latestRevision: 3,
    });
  });

  it("keeps a refusal without a JSON body readable", async () => {
    const apiFetch: ApiFetch = async () => new Response("bad gateway", { status: 502 });
    await expect(call(apiFetch, z.any(), "/x")).rejects.toMatchObject({
      refusal: { error: "http_502" },
    });
  });
});

describe("explain", () => {
  const refused = (body: object) => new RefusedError(400, { error: "x", ...body });
  it.each([
    [{ error: "missing_roles", missing: ["finance_lead"] }, "Needs a finance lead to approve."],
    [{ error: "missing_roles", missing: [] }, "Your role can read plans but not approve them."],
    [
      { error: "stale_revision", latestRevision: 3 },
      "A newer revision (3) exists. Reload to review it.",
    ],
    [
      { error: "policy_violation", violations: [{ rule: "R3.finance_threshold", detail: "d" }] },
      "Breaks policy: R3.finance_threshold (d)",
    ],
    [{ error: "forbidden" }, "You don't have permission to do that."],
    [
      { error: "invalid_role" },
      "That role can't be assigned. Choose owner, finance lead, support lead, or member.",
    ],
    [
      { error: "last_owner" },
      "This organization still needs an owner, so that role change was refused.",
    ],
    [{ error: "incident_not_found" }, "This deployment can't rehearse that incident."],
    [{ error: "not_enqueued" }, "The planner queue didn't accept the request. Try again."],
    [{ error: "something_new" }, "Refused: something_new."],
  ])("explains %j", (body, text) => {
    expect(explain(refused(body))).toBe(text);
  });

  it("doesn't leak a raw error", () => {
    expect(explain(new TypeError("Failed to fetch"))).toBe("Something went wrong. Try again.");
  });

  it("explains a 403 in plain words", () => {
    expect(explain(new RefusedError(403, { error: "http_403" }))).toBe(
      "You don't have permission to do that.",
    );
  });
});
