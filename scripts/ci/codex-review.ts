import { z } from "zod";

const OWNER_ID = 98989697;
const OWNER = "SoroushRF";
const LABEL = "ai-review-ready";
const COMMAND = "/codex-review-now";
const WINDOW = 5 * 60 * 60 * 1000;
const COOLDOWN = 60 * 60 * 1000;
const LIMIT = 12;
const QUEUE = "<!-- rehearsal-codex-queue:v1 ";
const RECEIPT = "@codex review\n\n<!-- rehearsal-codex-dispatch:v1 ";

export interface Api {
  request<T>(route: string, parameters: Record<string, unknown>): Promise<{ data: T }>;
}
const userSchema = z.object({ id: z.number().int() });
const commentSchema = z.object({
  id: z.number().int(),
  user: userSchema.nullable().transform((user) => user ?? { id: 0 }),
  body: z
    .string()
    .nullable()
    .transform((body) => body ?? ""),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
const pullSchema = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  labels: z.array(z.object({ name: z.string() })),
  requested_reviewers: z.array(userSchema),
});
const queueSchema = z.object({ pending: z.boolean(), request: z.string().regex(/^\d+$/) });
const receiptSchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/),
  queue: z.string().regex(/^\d+$/),
  override: z.number().int().nonnegative(),
});
const eventSchema = z.object({
  id: z.number().int().optional(),
  event: z.string(),
  requested_reviewer: userSchema.nullish(),
  label: z.object({ name: z.string() }).nullish(),
});
const ciSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      run_started_at: z.iso.datetime(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      pull_requests: z.array(z.object({ number: z.number().int() })),
    }),
  ),
});
type Comment = z.infer<typeof commentSchema>;
type Pull = z.infer<typeof pullSchema>;

function metadata<T>(comment: Comment, prefix: string, schema: z.ZodType<T>): T | undefined {
  if (comment.user.id !== OWNER_ID || !comment.body.startsWith(prefix)) return;
  const end = comment.body.indexOf(" -->", prefix.length);
  if (end === -1) throw new Error("Incomplete trusted Codex ledger marker");
  return schema.parse(JSON.parse(comment.body.slice(prefix.length, end)));
}

function isTrigger(comment: Comment) {
  return comment.user.id === OWNER_ID && /^@codex review(?:\s|$)/.test(comment.body);
}

async function request<T>(
  api: Api,
  schema: z.ZodType<T>,
  route: string,
  parameters: Record<string, unknown>,
) {
  const { data } = await api.request<unknown>(route, parameters);
  return schema.parse(data);
}

async function pages<T>(
  api: Api,
  schema: z.ZodType<T>,
  route: string,
  parameters: Record<string, unknown>,
) {
  const results: T[] = [];
  for (let page = 1; ; page++) {
    const data = await request(api, z.array(schema), route, { ...parameters, per_page: 100, page });
    results.push(...data);
    if (data.length < 100) return results;
  }
}

/** Only trusted default-branch code runs here. Comments are the durable queue/dispatch ledger. */
export async function dispatch(
  read: Api,
  account: Api,
  context: {
    repo: { owner: string; repo: string };
  },
  now = Date.now(),
) {
  const repo = context.repo;
  if (repo.owner !== OWNER || repo.repo !== "Rehearsal") throw new Error("Unexpected repository");
  const user = await request(account, userSchema, "GET /user", {});
  if (user.id !== OWNER_ID) throw new Error("Review token must belong to SoroushRF");
  const ledger = await pages(account, commentSchema, "GET /repos/{owner}/{repo}/issues/comments", {
    ...repo,
    since: new Date(now - WINDOW).toISOString(),
  });
  const pulls = await pages(account, pullSchema, "GET /repos/{owner}/{repo}/pulls", {
    ...repo,
    state: "open",
    sort: "created",
    direction: "asc",
  });
  const results: string[] = [];
  for (const pull of pulls) {
    const target = { ...repo, issue_number: pull.number };
    const comments = await pages(
      account,
      commentSchema,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      target,
    );
    const history = comments.flatMap((comment) => {
      const data = metadata(comment, RECEIPT, receiptSchema);
      return data ? [data] : [];
    });
    let status = comments.findLast((comment) => metadata(comment, QUEUE, queueSchema));
    let queue = status && metadata(status, QUEUE, queueSchema);
    // Reconstruct requests from the timeline: Actions concurrency can replace pending runs.
    const events = await pages(
      account,
      eventSchema,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
      target,
    );
    const latest = events
      .filter(
        (event) =>
          (event.event === "review_requested" && event.requested_reviewer?.id === OWNER_ID) ||
          (event.event === "labeled" && event.label?.name === LABEL),
      )
      .at(-1);
    if (latest?.id && (!queue || Number(queue.request) < latest.id)) {
      queue = { pending: true, request: String(latest.id) };
    }
    const override = comments.findLast(
      (comment) =>
        comment.user.id === OWNER_ID &&
        comment.body === COMMAND &&
        comment.created_at === comment.updated_at &&
        comment.id > Math.max(0, ...history.map((item) => item.override)),
    );
    if (!queue?.pending && !override) continue;
    queue ??= { pending: true, request: "0" };
    const queuedRequest = queue.request;
    const save = async (message: string, pending = true) => {
      queue = { request: queuedRequest, pending };
      const body = `${QUEUE}${JSON.stringify(queue)} -->\n${message}`;
      if (status?.body !== body) {
        const data = await request(
          account,
          commentSchema,
          status
            ? "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"
            : "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            ...target,
            comment_id: status?.id,
            body,
          },
        );
        status = data;
      }
      results.push(`#${pull.number}: ${message}`);
    };
    if (
      !override &&
      history.some((item) => item.queue === queuedRequest || item.head === pull.head.sha)
    ) {
      await save(
        `Already dispatched for this request or commit ${pull.head.sha}; no repeat review.`,
        false,
      );
      continue;
    }
    const requested = (pr: Pull) =>
      pr.requested_reviewers.some((reviewer) => reviewer.id === OWNER_ID);
    if (!override && !requested(pull)) {
      await save("Cancelled — not reviewed: SoroushRF is no longer requested.", false);
      continue;
    }
    const ready = (pr: Pull) => pr.labels.some((label) => label.name === LABEL);
    if (pull.draft || (!override && !ready(pull))) {
      await save("Queued — not reviewed: waiting for non-draft and ai-review-ready.");
      continue;
    }
    const ci = await request(
      read,
      ciSchema,
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      {
        ...repo,
        workflow_id: "ci.yml",
        event: "pull_request",
        head_sha: pull.head.sha,
        per_page: 100,
      },
    );
    const run = ci.workflow_runs
      .filter(
        (item) =>
          item.head_sha === pull.head.sha &&
          item.pull_requests.some((pr) => pr.number === pull.number),
      )
      .sort(
        (a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at) || b.id - a.id,
      )[0];
    if (run?.status !== "completed" || run.conclusion !== "success") {
      await save(`Queued — not reviewed: waiting for green CI on ${pull.head.sha}.`);
      continue;
    }
    if (
      !override &&
      ledger.filter(
        (comment) => isTrigger(comment) && Date.parse(comment.created_at) > now - WINDOW,
      ).length >= LIMIT
    ) {
      await save("Queued — not reviewed: 12-review rolling 5-hour limit reached.");
      continue;
    }
    if (
      !override &&
      comments.some(
        (comment) => isTrigger(comment) && Date.parse(comment.created_at) > now - COOLDOWN,
      )
    ) {
      await save("Queued — not reviewed: 60-minute per-PR cooldown.");
      continue;
    }
    const current = await request(
      account,
      pullSchema,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        ...repo,
        pull_number: pull.number,
      },
    );
    if (
      current.state !== "open" ||
      current.draft ||
      current.head.sha !== pull.head.sha ||
      (!override && (!requested(current) || !ready(current)))
    ) {
      await save("Queued — not reviewed: PR changed during admission; recheck next sweep.");
      continue;
    }
    // One comment both starts the hosted review and records spend. Never blindly retry it.
    const posted = await request(
      account,
      commentSchema,
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...target,
        body: `${RECEIPT}${JSON.stringify({ head: pull.head.sha, queue: queuedRequest, override: override?.id ?? 0 })} -->`,
      },
    );
    ledger.push(posted);
    await save(
      `Dispatched for ${pull.head.sha}${override ? " by owner override" : ""}; awaiting Codex, not a review approval.`,
      false,
    );
  }
  return results.length ? results : ["No pending review requests."];
}
