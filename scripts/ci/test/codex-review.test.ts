import { describe, expect, it } from "vitest";
import { type Api, dispatch, LEDGER_CONTEXT, LEDGER_SHA } from "../codex-review";

const OWNER = 98989697;
const NOW = Date.parse("2026-10-24T18:00:00Z");
const HOUR = 3_600_000;
const OTHER = "b".repeat(40);
const context = { repo: { owner: "SoroushRF", repo: "Rehearsal" } };
const pull = (number = 1) => ({
  number,
  state: "open",
  draft: false,
  head: {
    sha: (number + 10).toString(16).padStart(40, "0"),
    ref: `branch-${number}`,
    repo: { full_name: "SoroushRF/Rehearsal" },
  },
  labels: [{ name: "ai-review-ready" }],
  requested_reviewers: [{ id: OWNER }],
});
const comment = (body: string, id = 1, age = 0, user = OWNER, number = 1) => ({
  body,
  id,
  node_id: `IC_${id}`,
  issue_url: `https://api.github.com/repos/SoroushRF/Rehearsal/issues/${number}`,
  user: { id: user },
  created_at: new Date(NOW - age).toISOString(),
  updated_at: new Date(NOW - age).toISOString(),
});
const reservation = (
  pr = 99,
  head = OTHER,
  request = "99",
  override = 0,
  age = 0,
  creator = OWNER,
) => ({
  id: 1000 + pr,
  creator: { id: creator },
  context: `${LEDGER_CONTEXT}2026-10-24`,
  description: JSON.stringify({ pr, head, request, override }),
  created_at: new Date(NOW - age).toISOString(),
});
type Pull = ReturnType<typeof pull>;
type Comment = ReturnType<typeof comment>;
type Event = {
  id: number | null;
  event: string;
  requested_reviewer?: { id: number };
  label?: { name: string };
};

function fixture(count = 1) {
  const pulls = Array.from({ length: count }, (_, i) => pull(i + 1));
  const comments: Comment[] = [];
  const statuses: ReturnType<typeof reservation>[] = [];
  const writes: Comment[] = [];
  const events = new Map(
    pulls.map((p) => [
      p.number,
      [{ id: 100, event: "review_requested", requested_reviewer: { id: OWNER } }] as Event[],
    ]),
  );
  const calls: { route: string; parameters: Record<string, unknown> }[] = [];
  const state = {
    pulls,
    comments,
    statuses,
    writes,
    events,
    calls,
    now: NOW,
    owner: OWNER,
    ci: "success",
    latestRunId: 2,
    failCi: new Set<number>(),
    badTimeline: new Set<number>(),
    edited: new Set<string>(),
    changeHead: false,
    lostCommentResponse: false,
    failCommentBeforeSend: false,
    lostReservationResponse: false,
    denyReservation: false,
    forkAssociationMissing: false,
    wrongCiRepository: false,
    wrongCiBranch: false,
    staleCiHead: false,
  };
  const page = <T>(items: T[], p: Record<string, unknown>) =>
    structuredClone(items.slice((Number(p.page) - 1) * 100, Number(p.page) * 100));
  const account: Api = {
    async request<T>(route: string, p: Record<string, unknown>) {
      calls.push({ route, parameters: p });
      const number = Number(p.issue_number ?? p.pull_number);
      let data: unknown;
      if (route === "GET /user") data = { id: state.owner };
      else if (route.endsWith("/statuses") && route.startsWith("GET")) {
        expect(p.ref).toBe(LEDGER_SHA);
        data = page(statuses, p);
      } else if (route.endsWith("/statuses/{sha}")) {
        if (state.denyReservation) throw new Error("403");
        expect(p.sha).toBe(LEDGER_SHA);
        const status = {
          id: 50000 + statuses.length,
          creator: { id: OWNER },
          context: String(p.context),
          description: String(p.description),
          created_at: new Date(state.now).toISOString(),
        };
        expect(status.description.length).toBeLessThanOrEqual(140);
        statuses.push(status);
        data = structuredClone(status);
        if (state.lostReservationResponse) {
          state.lostReservationResponse = false;
          throw new Error("lost reservation response");
        }
      } else if (route.endsWith("/issues/comments") && route.startsWith("GET"))
        data = page(comments, p);
      else if (route.endsWith("/pulls"))
        data = page(
          pulls.filter((pr) => pr.state === "open"),
          p,
        );
      else if (route.endsWith("/timeline"))
        data = state.badTimeline.has(number) ? [{ event: 42 }] : page(events.get(number) ?? [], p);
      else if (route === "POST /graphql")
        data = {
          data: {
            node: {
              lastEditedAt: state.edited.has((p.variables as { id: string }).id)
                ? new Date(NOW).toISOString()
                : null,
            },
          },
        };
      else if (route.endsWith("/pulls/{pull_number}")) {
        data = structuredClone(pulls.find((pr) => pr.number === number));
        if (state.changeHead) (data as Pull).head.sha = OTHER;
      } else if (route.startsWith("PATCH")) {
        const existing = comments.find((c) => c.id === p.comment_id);
        if (!existing) throw new Error("Missing comment");
        existing.body = String(p.body);
        data = structuredClone(existing);
      } else if (route.endsWith("/comments") && route.startsWith("POST")) {
        const body = String(p.body);
        if (body.startsWith("@codex review") && state.failCommentBeforeSend)
          throw new Error("crash before trigger");
        const posted = comment(body, 10000 + writes.length, 0, OWNER, number);
        posted.created_at = posted.updated_at = new Date(state.now).toISOString();
        comments.push(posted);
        writes.push(posted);
        data = structuredClone(posted);
        if (body.startsWith("@codex review") && state.lostCommentResponse) {
          state.lostCommentResponse = false;
          throw new Error("lost trigger response");
        }
      } else throw new Error(`Unexpected route ${route}`);
      return { data: data as T };
    },
  };
  const read: Api = {
    async request<T>(_route: string, p: Record<string, unknown>) {
      const pr = pulls.find((x) => x.head.sha === p.head_sha);
      if (!pr) throw new Error("CI lookup has no matching fixture PR");
      if (state.failCi.has(pr.number)) throw new Error("CI unavailable");
      const run = (id: number, age: number, ci: string) => ({
        id,
        run_started_at: new Date(NOW - age).toISOString(),
        head_sha: state.staleCiHead ? OTHER : p.head_sha,
        head_branch: state.wrongCiBranch ? "other" : pr.head.ref,
        head_repository: {
          full_name: state.wrongCiRepository ? "someone/else" : pr.head.repo.full_name,
        },
        status: ci === "pending" ? "in_progress" : "completed",
        conclusion: ci,
        pull_requests: state.forkAssociationMissing ? [] : [{ number: pr.number }],
      });
      return {
        data: {
          workflow_runs: [run(state.latestRunId, 0, state.ci), run(1, HOUR, "success")],
        } as T,
      };
    },
  };
  const run = () => dispatch(read, account, context, state.now);
  const starts = () => writes.filter((c) => c.body.startsWith("@codex review"));
  const pr = () => {
    const first = pulls[0];
    if (!first) throw new Error("Fixture requires a PR");
    return first;
  };
  return { state, run, starts, pr };
}

describe("Codex admission", () => {
  it("reserves the twelfth slot across PRs, including spend on closed PRs", async () => {
    const f = fixture(3);
    f.state.statuses.push(...Array.from({ length: 11 }, (_, i) => reservation(50 + i)));
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.state.writes.at(-1)?.body).toContain("12-review rolling");
  });
  it("enumerates older statuses and frees slots at the five-hour boundary", async () => {
    const f = fixture();
    f.state.statuses.push(
      ...Array.from({ length: 100 }, () => ({ ...reservation(), context: "ordinary-ci" })),
      ...Array.from({ length: 12 }, () => reservation()),
    );
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.now += 5 * HOUR;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("retains the per-PR cooldown independently of comments", async () => {
    const f = fixture();
    f.state.statuses.push(reservation(1, OTHER, "99", 0, HOUR / 2));
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.now += HOUR / 2;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("deduplicates an old head after quotas reset and another request arrives", async () => {
    const f = fixture();
    f.state.statuses.push(reservation(1, f.pr().head.sha, "99", 0, 6 * HOUR));
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });
  it("does not turn pushes after dispatch into a new request", async () => {
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
  it.each(["pending", "failure"])("waits for current-head CI: %s", async (ci) => {
    const f = fixture();
    f.state.ci = ci;
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.ci = "success";
    f.pr().head.sha = OTHER;
    await f.run();
    expect(f.starts()[0]?.body).toContain(OTHER);
  });
  it("uses rerun time instead of historical run IDs", async () => {
    const f = fixture();
    f.state.latestRunId = 0;
    f.state.ci = "failure";
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });
  it.each(["draft", "label", "reviewer", "head-race"])(
    "does not dispatch past %s",
    async (gate) => {
      const f = fixture();
      if (gate === "draft") f.pr().draft = true;
      if (gate === "label") f.pr().labels = [];
      if (gate === "reviewer") f.pr().requested_reviewers = [];
      if (gate === "head-race") f.state.changeHead = true;
      await f.run();
      expect(f.starts()).toHaveLength(0);
      expect(f.state.statuses).toHaveLength(0);
    },
  );
  it("allows an owner override once despite quota, readiness, cooldown and dedupe", async () => {
    const f = fixture();
    f.pr().labels = [];
    f.pr().requested_reviewers = [];
    f.state.statuses.push(
      reservation(1, f.pr().head.sha),
      ...Array.from({ length: 12 }, () => reservation()),
    );
    f.state.comments.push(comment("/codex-review-now", 1000));
    await f.run();
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.state.statuses.at(-1)?.description).toContain('"override":1000');
  });
  it.each(["impostor", "quoted", "edited", "same-second-edit"])(
    "rejects %s overrides",
    async (kind) => {
      const f = fixture();
      f.pr().labels = [];
      f.pr().requested_reviewers = [];
      const c = comment(
        kind === "quoted" ? "> /codex-review-now" : "/codex-review-now",
        1000,
        0,
        kind === "impostor" ? 123 : OWNER,
      );
      if (kind === "edited") c.updated_at = new Date(NOW + 1).toISOString();
      if (kind === "same-second-edit") f.state.edited.add(c.node_id);
      f.state.comments.push(c);
      await f.run();
      expect(f.starts()).toHaveLength(0);
    },
  );
  it.each(["pending", "draft"])(
    "retains an old owner command while waiting for %s",
    async (gate) => {
      const f = fixture();
      f.pr().labels = [];
      f.state.comments.push(comment("/codex-review-now", 1000, 12 * HOUR));
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
  it("coalesces commands and counts an override against following normal admissions", async () => {
    const f = fixture(2);
    f.state.statuses.push(...Array.from({ length: 12 }, () => reservation()));
    f.state.comments.push(comment("/codex-review-now", 1000), comment("/codex-review-now", 1001));
    await f.run();
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.state.statuses.at(-1)?.description).toContain('"override":1001');
  });
  it.each(["edit", "delete"])("a receipt %s cannot replay a consumed override", async (change) => {
    const f = fixture();
    f.state.statuses.push(...Array.from({ length: 12 }, () => reservation()));
    f.state.comments.push(comment("/codex-review-now", 1000));
    await f.run();
    const c = f.starts()[0];
    if (!c) throw new Error("Missing fixture dispatch");
    if (change === "edit") {
      c.body = '@codex review\n\n<!-- rehearsal-codex-dispatch:v1 {"override":0} -->';
      c.updated_at = new Date(NOW + 1000).toISOString();
    } else f.state.comments.splice(f.state.comments.indexOf(c), 1);
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("deleting trigger and queue comments cannot free a budget slot", async () => {
    const f = fixture(2);
    f.state.statuses.push(...Array.from({ length: 11 }, () => reservation()));
    await f.run();
    expect(f.starts()).toHaveLength(1);
    f.state.comments.splice(0);
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("ignores forged/huge/malformed comment metadata on any PR", async () => {
    const f = fixture(2);
    f.state.comments.push(
      comment("@codex review\n\n<!-- rehearsal-codex-dispatch:v1 {bad json} -->", 9),
      comment("<!-- rehearsal-codex-queue:v1 {bad json} -->"),
      comment('<!-- rehearsal-codex-queue:v2 --> {"request":"9999999999999999"}'),
    );
    await f.run();
    // The visible manual trigger conservatively cools down PR1; malformed metadata cannot
    // prevent the other eligible PR from being dispatched.
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]?.issue_url).toMatch(/\/2$/);
  });

  it("another writer's newer status cannot erase the owner's earlier spending", async () => {
    const f = fixture();
    f.state.statuses.push(...Array.from({ length: 12 }, () => reservation()));
    f.state.statuses.push(reservation(1, OTHER, "1", 0, 0, 123));
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });
  it("ignores another account's forged immutable records", async () => {
    const f = fixture();
    f.state.statuses.push({
      ...reservation(1, f.pr().head.sha, "100", 9999, 0, 123),
      description: "malformed",
    });
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("does not blindly re-post after a lost trigger response and a head change", async () => {
    const f = fixture();
    f.state.lostCommentResponse = true;
    await f.run();
    f.pr().head.sha = OTHER;
    await f.run();
    expect(f.starts()).toHaveLength(1);
    expect(f.state.statuses).toHaveLength(1);
  });
  it("a crash after reservation but before posting holds until an explicit new command", async () => {
    const f = fixture();
    f.state.failCommentBeforeSend = true;
    await f.run();
    f.state.failCommentBeforeSend = false;
    await f.run();
    expect(f.starts()).toHaveLength(0);
    f.state.comments.push(comment("/codex-review-now", 1000));
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("a lost reservation response stops the sweep and cannot reserve/post again on retry", async () => {
    const f = fixture();
    f.state.lostReservationResponse = true;
    await expect(f.run()).rejects.toThrow("Reservation");
    await f.run();
    expect(f.starts()).toHaveLength(0);
    expect(f.state.statuses).toHaveLength(1);
  });
  it("a missing status-write permission cannot post any triggers", async () => {
    const f = fixture(2);
    f.state.denyReservation = true;
    await expect(f.run()).rejects.toThrow("Commit statuses: write");
    expect(f.starts()).toHaveLength(0);
  });
  it.each(["timeline", "CI"])("a PR-local %s error does not strand the next PR", async (kind) => {
    const f = fixture(2);
    if (kind === "timeline") f.state.badTimeline.add(1);
    else f.state.failCi.add(1);
    const results = await f.run();
    expect(results.some((r) => r.startsWith("#1: not reviewed"))).toBe(true);
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]?.issue_url).toMatch(/\/2$/);
  });
  it("accepts null IDs on unrelated timeline events", async () => {
    const f = fixture();
    f.state.events.get(1)?.unshift({ id: null, event: "committed" });
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it("never fetches timelines of PRs without readiness or a valid override", async () => {
    const f = fixture(2);
    f.pr().labels = [];
    f.state.badTimeline.add(1);
    await f.run();
    expect(
      f.state.calls.some((c) => c.route.endsWith("/timeline") && c.parameters.issue_number === 1),
    ).toBe(false);
    expect(f.starts()).toHaveLength(1);
  });
  it("accepts a fork's unassociated CI only for its exact repository, branch and head", async () => {
    const f = fixture();
    f.pr().head.repo.full_name = "contributor/Rehearsal";
    f.state.forkAssociationMissing = true;
    await f.run();
    expect(f.starts()).toHaveLength(1);
  });
  it.each(["repository", "branch", "head"])(
    "does not use fork CI from another %s",
    async (wrong) => {
      const f = fixture();
      f.state.forkAssociationMissing = true;
      if (wrong === "repository") f.state.wrongCiRepository = true;
      if (wrong === "branch") f.state.wrongCiBranch = true;
      if (wrong === "head") f.state.staleCiHead = true;
      await f.run();
      expect(f.starts()).toHaveLength(0);
    },
  );
  it("still counts visible manual triggers on closed PRs conservatively", async () => {
    const f = fixture();
    f.state.comments.push(
      ...Array.from({ length: 12 }, (_, i) => comment("@codex review", i, 0, OWNER, 99)),
    );
    await f.run();
    expect(f.starts()).toHaveLength(0);
  });
  it("fails closed on corrupt shared authoritative state or a wrong token owner", async () => {
    const f = fixture();
    f.state.owner = 123;
    await expect(f.run()).rejects.toThrow("must belong");
    f.state.owner = OWNER;
    f.state.statuses.push({ ...reservation(), description: "malformed" });
    await expect(f.run()).rejects.toThrow();
    expect(f.starts()).toHaveLength(0);
  });
});
