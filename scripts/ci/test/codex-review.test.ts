import { describe, expect, it } from "vitest";
import { type Api, dispatch } from "../codex-review";

const OWNER = 98989697;
const NOW = Date.parse("2026-10-24T18:00:00Z");
const HOUR = 3_600_000;
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const context = { repo: { owner: "SoroushRF", repo: "Rehearsal" } };
const pull = (number = 1) => ({
  number,
  state: "open",
  draft: false,
  head: { sha: HEAD },
  labels: [{ name: "ai-review-ready" }],
  requested_reviewers: [{ id: OWNER }],
});
const comment = (body: string, id = 1, age = 0, user = OWNER) => ({
  body,
  id,
  user: { id: user },
  created_at: new Date(NOW - age).toISOString(),
  updated_at: new Date(NOW - age).toISOString(),
});
const receipt = (head = OTHER, queue = "99", override = 0) =>
  `@codex review\n\n<!-- rehearsal-codex-dispatch:v1 ${JSON.stringify({ head, queue, override })} -->`;
type Pull = ReturnType<typeof pull>;
type Comment = ReturnType<typeof comment>;
type Event = {
  id: number;
  event: string;
  requested_reviewer?: { id: number };
  label?: { name: string };
};

function fixture(count = 1) {
  const pulls = Array.from({ length: count }, (_, i) => pull(i + 1));
  const histories = new Map(pulls.map((pr) => [pr.number, [] as Comment[]]));
  const events = new Map(
    pulls.map((pr) => [
      pr.number,
      [{ id: 100, event: "review_requested", requested_reviewer: { id: OWNER } }] as Event[],
    ]),
  );
  const ledger: Comment[] = [];
  const writes: Comment[] = [];
  const state = {
    pulls,
    histories,
    events,
    ledger,
    writes,
    owner: OWNER,
    ci: "success",
    latestRunId: 2,
    failRead: false,
    lostResponse: false,
    changeHead: false,
    now: NOW,
  };
  const page = <T>(items: T[], parameters: Record<string, unknown>) =>
    structuredClone(
      items.slice((Number(parameters.page) - 1) * 100, Number(parameters.page) * 100),
    );
  const account: Api = {
    async request<T>(route: string, parameters: Record<string, unknown>) {
      const number = Number(parameters.issue_number ?? parameters.pull_number);
      let data: unknown;
      if (route === "GET /user") data = { id: state.owner };
      else if (route.endsWith("/issues/comments") && route.startsWith("GET"))
        data = page(ledger, parameters);
      else if (route.endsWith("/pulls"))
        data = page(
          pulls.filter((pr) => pr.state === "open"),
          parameters,
        );
      else if (route.endsWith("/timeline")) data = page(events.get(number) ?? [], parameters);
      else if (route.endsWith("/comments") && route.startsWith("GET"))
        data = page(histories.get(number) ?? [], parameters);
      else if (route.endsWith("/pulls/{pull_number}")) {
        data = structuredClone(pulls.find((pr) => pr.number === number));
        if (state.changeHead) (data as Pull).head.sha = OTHER;
      } else if (route.startsWith("PATCH")) {
        const existing = [...histories.values()]
          .flat()
          .find((item) => item.id === parameters.comment_id);
        if (!existing) throw new Error("Missing comment");
        existing.body = String(parameters.body);
        data = structuredClone(existing);
      } else if (route.startsWith("POST")) {
        const posted = comment(String(parameters.body), 10_000 + writes.length);
        posted.created_at = posted.updated_at = new Date(state.now).toISOString();
        histories.get(number)?.push(posted);
        writes.push(posted);
        if (posted.body.startsWith("@codex review")) {
          ledger.push(posted);
          if (state.lostResponse) {
            state.lostResponse = false;
            throw new Error("Response lost");
          }
        }
        data = structuredClone(posted);
      } else throw new Error(`Unexpected route ${route}`);
      return { data: data as T };
    },
  };
  const read: Api = {
    async request<T>(_route: string, parameters: Record<string, unknown>) {
      if (state.failRead) throw new Error("CI unavailable");
      const pr = pulls.find((item) => item.head.sha === parameters.head_sha);
      return {
        data: {
          workflow_runs: [
            {
              id: state.latestRunId,
              run_started_at: new Date(NOW).toISOString(),
              head_sha: parameters.head_sha,
              status: state.ci === "pending" ? "in_progress" : "completed",
              conclusion: state.ci,
              pull_requests: [{ number: pr?.number }],
            },
            {
              id: 1,
              run_started_at: new Date(NOW - HOUR).toISOString(),
              head_sha: parameters.head_sha,
              status: "completed",
              conclusion: "success",
              pull_requests: [{ number: pr?.number }],
            },
          ],
        } as T,
      };
    },
  };
  // Give every PR a distinct head, as actual branches normally have.
  pulls.forEach((pr, i) => {
    pr.head.sha = (i + 10).toString(16).padStart(40, "0");
  });
  const add = (item: Comment, number = 1) => {
    histories.get(number)?.push(item);
    if (item.body.startsWith("@codex review")) ledger.push(item);
  };
  const run = () => dispatch(read, account, context, state.now);
  const starts = () => writes.filter((item) => item.body.startsWith("@codex review"));
  const pr = () => {
    const first = pulls[0];
    if (!first) throw new Error("Fixture requires a PR");
    return first;
  };
  return { state, run, add, starts, pr };
}

describe("Codex admission", () => {
  it("reserves the twelfth slot across PRs and queues the rest, including spend on closed PRs", async () => {
    const f = fixture(3);
    f.state.ledger.push(...Array.from({ length: 11 }, (_, i) => comment("@codex review", i)));
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.state.writes.at(-1)?.body).toContain("12-review rolling 5-hour");
  });

  it("counts a paginated ledger and releases slots exactly five hours later", async () => {
    const f = fixture();
    f.state.ledger.push(...Array.from({ length: 100 }, (_, i) => comment("ordinary", i)));
    f.state.ledger.push(...Array.from({ length: 12 }, (_, i) => comment("@codex review", 200 + i)));
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.now += 5 * HOUR;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });

  it("holds a changed commit for 60 minutes, then drains without another request", async () => {
    const f = fixture();
    f.add(comment(receipt(), 1, HOUR / 2));
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.now += HOUR / 2;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });

  it("deduplicates an old commit even after quotas reset and a new request arrives", async () => {
    const f = fixture();
    f.add(comment(receipt(f.state.pulls[0]?.head.sha), 1, 6 * HOUR));
    await f.run();
    expect(f.starts()).toHaveLength(0);
    expect(f.state.writes.at(-1)?.body).toContain("no repeat review");
  });

  it("does not turn later pushes into new requests", async () => {
    const f = fixture();
    await f.run();
    f.pr().head.sha = OTHER;
    f.state.now += 6 * HOUR;
    await f.run();
    expect(f.starts()).toHaveLength(1);
    f.state.events
      .get(1)
      ?.push({ id: 101, event: "review_requested", requested_reviewer: { id: OWNER } });
    await f.run();
    expect(f.starts()).toHaveLength(2);
  });

  it.each(["pending", "failure"])(
    "waits for current-head CI when its latest run is %s",
    async (ci) => {
      const f = fixture();
      f.state.ci = ci;
      await f.run();
      expect(f.starts()).toHaveLength(0);
      f.state.ci = "success";
      f.pr().head.sha = OTHER;
      await f.run();
      expect(f.starts()).toHaveLength(1);
      expect(f.starts()[0]?.body).toContain(OTHER);
    },
  );

  it("uses the latest rerun time rather than trusting a higher historical run ID", async () => {
    const f = fixture();
    f.state.latestRunId = 0;
    f.state.ci = "failure";
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });

  it.each(["draft", "missing-label", "removed-reviewer", "head-race"])(
    "defers or cancels %s",
    async (reason) => {
      const f = fixture();
      const pr = f.pr();
      if (reason === "draft") pr.draft = true;
      if (reason === "missing-label") pr.labels = [];
      if (reason === "removed-reviewer") pr.requested_reviewers = [];
      if (reason === "head-race") f.state.changeHead = true;
      await f.run();
      expect(f.starts()).toHaveLength(0);
      expect(f.state.writes.at(-1)?.body).toMatch(/not reviewed/);
    },
  );

  it("lets only the owner's exact new command bypass budget, cooldown, readiness, and dedupe once", async () => {
    const f = fixture();
    const pr = f.pr();
    pr.labels = [];
    pr.requested_reviewers = [];
    f.add(comment(receipt(pr.head.sha), 1));
    f.state.ledger.push(...Array.from({ length: 12 }, (_, i) => comment("@codex review", 100 + i)));
    f.add(comment("/codex-review-now", 1000));
    await f.run();
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]?.body).toContain('"override":1000');
  });

  it.each(["impostor", "quoted", "edited"])("rejects a %s override", async (kind) => {
    const f = fixture();
    f.state.ledger.push(...Array.from({ length: 12 }, (_, i) => comment("@codex review", i)));
    const command = comment(
      kind === "quoted" ? "> /codex-review-now" : "/codex-review-now",
      1000,
      0,
      kind === "impostor" ? 123 : OWNER,
    );
    if (kind === "edited") command.updated_at = new Date(NOW + 1).toISOString();
    f.add(command);
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });

  it.each(["pending", "draft"])(
    "an override still waits for %s and survives until ready",
    async (gate) => {
      const f = fixture();
      f.add(comment("/codex-review-now", 1000));
      if (gate === "pending") f.state.ci = "pending";
      else f.pr().draft = true;
      await f.run();
      expect(f.starts()).toHaveLength(0);
      f.state.ci = "success";
      f.pr().draft = false;
      await f.run();
      expect(f.starts()).toHaveLength(1);
    },
  );

  it("coalesces several queued owner commands and counts overrides against following admissions", async () => {
    const f = fixture(2);
    f.state.ledger.push(...Array.from({ length: 12 }, (_, i) => comment("@codex review", i)));
    f.add(comment("/codex-review-now", 1000));
    f.add(comment("/codex-review-now", 1001));
    await f.run();
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]?.body).toContain('"override":1001');
  });

  it("reconciles a lost dispatch response even if the PR head changes before retry", async () => {
    const f = fixture();
    f.state.lostResponse = true;
    await expect(f.run()).rejects.toThrow("Response lost");
    f.pr().head.sha = OTHER;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });

  it("does not trust forged receipts or budget entries from another account", async () => {
    const f = fixture();
    f.add(comment(receipt(f.state.pulls[0]?.head.sha, "100"), 1, 0, 123));
    f.state.ledger.push(
      ...Array.from({ length: 12 }, (_, i) => comment("@codex review", i, 0, 123)),
    );
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });

  it("fails closed before dispatch on a wrong token owner or unavailable CI", async () => {
    const f = fixture();
    f.state.owner = 123;
    await expect(f.run()).rejects.toThrow("must belong");
    f.state.owner = OWNER;
    f.state.failRead = true;
    await expect(f.run()).rejects.toThrow("CI unavailable");
    expect(f.starts()).toHaveLength(0);
  });

  it("fails closed on malformed trusted ledger data instead of repeating uncertain work", async () => {
    const f = fixture();
    f.add(comment('@codex review\n\n<!-- rehearsal-codex-dispatch:v1 {"head":"bad"} -->'));
    await expect(f.run()).rejects.toThrow();
    expect(f.starts()).toHaveLength(0);
  });
});
