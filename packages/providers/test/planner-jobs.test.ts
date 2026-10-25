import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { plannerJobsClient } from "../src";

const JOB_ID = "7a1d3c52-8a0e-4b8e-9d55-0f3f5b8a2e11";

/** An API that accepts the connection and never answers, until the request is aborted. */
const hung: typeof fetch = (_input, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("plannerJobsClient", () => {
  it("gives up on an API that never answers, so the worker isn't wedged", async () => {
    const jobs = plannerJobsClient("http://api.test", "secret", hung, 20);
    for (const call of [
      () => jobs.next(),
      () => jobs.complete(JOB_ID, { manifest: {}, summary: "" }),
      () => jobs.fail(JOB_ID, { reason: "timeout", message: "" }),
    ]) {
      const settled = await Promise.race([
        call().then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((r) => setTimeout(() => r("wedged"), 2_000)),
      ]);
      expect(settled).toBe("rejected");
    }
  });
});

// Real loopback HTTP, as in the issue: a mocked fetch can't show what a followed redirect carries.
// One server plays the API. With `redirect` set it answers every job route with a redirect to
// another path on the same origin (where Fetch keeps Authorization) or to another origin.
describe("plannerJobsClient never follows a redirect with its secret (#242)", () => {
  let api: Server;
  let other: Server;
  let apiUrl = "";
  let otherUrl = "";
  let reached: { url?: string; authorization?: string }[] = [];
  let mode: { redirect: 307 | 308 | null; to: "same" | "other" } = { redirect: null, to: "same" };

  const listen = async (
    handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
  ) => {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const record = (req: IncomingMessage) =>
    reached.push({ url: req.url, authorization: req.headers.authorization });

  beforeAll(async () => {
    const o = await listen((req, res) => {
      record(req);
      res.writeHead(204);
      res.end();
    });
    other = o.server;
    otherUrl = o.url;
    const a = await listen((req, res) => {
      if (req.url === "/unexpected-service") {
        record(req);
        res.writeHead(204);
        res.end();
        return;
      }
      if (mode.redirect) {
        const location =
          mode.to === "same" ? "/unexpected-service" : `${otherUrl}/unexpected-service`;
        res.writeHead(mode.redirect, { location });
        res.end();
        return;
      }
      // The real API's answers, so the success paths still work.
      if (req.url?.endsWith("/next")) {
        res.writeHead(204);
      } else if (req.url?.endsWith("/complete")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ planHash: "a".repeat(64) }));
        return;
      } else {
        res.writeHead(204);
      }
      res.end();
    });
    api = a.server;
    apiUrl = a.url;
  });
  afterAll(async () => {
    for (const server of [api, other]) await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    reached = [];
    mode = { redirect: null, to: "same" };
  });

  const calls = (jobs: ReturnType<typeof plannerJobsClient>) =>
    [
      ["next", () => jobs.next()],
      ["complete", () => jobs.complete(JOB_ID, { manifest: {}, summary: "" })],
      ["fail", () => jobs.fail(JOB_ID, { reason: "timeout", message: "" })],
    ] as const;

  it.each([
    [307, "same"],
    [308, "same"],
    [307, "other"],
    [308, "other"],
  ] as const)("refuses a %i to the %s origin and sends nothing on", async (status, to) => {
    mode = { redirect: status, to };
    const jobs = plannerJobsClient(apiUrl, "dummy-planner-secret");
    for (const [what, call] of calls(jobs)) {
      await expect(call(), what).rejects.toThrow();
    }
    expect(reached).toEqual([]);
  });

  it("still talks to the API normally", async () => {
    const jobs = plannerJobsClient(apiUrl, "dummy-planner-secret");
    expect(await jobs.next()).toBeNull();
    expect(await jobs.complete(JOB_ID, { manifest: {}, summary: "" })).toEqual({
      planHash: "a".repeat(64),
    });
    await expect(jobs.fail(JOB_ID, { reason: "timeout", message: "" })).resolves.toBeUndefined();
  });
});
