import { z } from "zod";

const OWNER_ID = 98989697;
const OWNER = "SoroushRF";
const LABEL = "ai-review-ready";
const COMMAND = "/codex-review-now";
const WINDOW = 5 * 60 * 60 * 1000;
const COOLDOWN = 60 * 60 * 1000;
const LIMIT = 12;
const QUEUE = "<!-- rehearsal-codex-queue:v2 -->";
const RECEIPT = "<!-- rehearsal-codex-reservation:";
// Root commit: reachable independently of PRs and branch deletion.
export const LEDGER_SHA = "a2ea79165a8fa43d45f092016a95ff0354cd5198";
export const LEDGER_CONTEXT = "rehearsal-codex-ledger/v2/";

export interface Api {
  request<T>(route: string, parameters: Record<string, unknown>): Promise<{ data: T }>;
}
const userSchema = z.object({ id: z.int() });
const commentSchema = z.object({
  id: z.int(),
  node_id: z.string(),
  issue_url: z.string(),
  user: userSchema.nullish(),
  body: z
    .string()
    .nullable()
    .transform((body) => body ?? ""),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
const pullSchema = z.object({
  number: z.int(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  labels: z.array(z.object({ name: z.string() })),
  requested_reviewers: z.array(userSchema),
});
const reservationSchema = z.object({
  pr: z.int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  request: z.string().regex(/^\d+$/),
  override: z.int().nonnegative(),
});
const statusSchema = z.object({
  id: z.int(),
  creator: userSchema.nullish(),
  context: z.string(),
  description: z.string().nullable(),
  created_at: z.iso.datetime(),
});
const eventSchema = z.object({
  id: z.int().nullish(),
  event: z.string(),
  requested_reviewer: userSchema.nullish(),
  label: z.object({ name: z.string() }).nullish(),
});
const ciSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.int(),
      run_started_at: z.iso.datetime(),
      head_sha: z.string(),
      head_branch: z.string(),
      head_repository: z.object({ full_name: z.string() }).nullable(),
      status: z.string(),
      conclusion: z.string().nullable(),
      pull_requests: z.array(z.object({ number: z.int() })),
    }),
  ),
});
type Comment = z.infer<typeof commentSchema>;
type Reservation = z.infer<typeof reservationSchema> & { id: number; at: number };

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
const isTrigger = (c: Comment) => c.user?.id === OWNER_ID && /^@codex review(?:\s|$)/.test(c.body);
const requested = (pr: z.infer<typeof pullSchema>) =>
  pr.requested_reviewers.some((r) => r.id === OWNER_ID);
const ready = (pr: z.infer<typeof pullSchema>) => pr.labels.some((l) => l.name === LABEL);

// Unknown reservation POSTs may have committed. Stop, reload next time, never blindly retry.
class LedgerWriteError extends Error {}

/** Only trusted default-branch code runs here. Commit statuses are append-only, unlike comments. */
export async function dispatch(
  read: Api,
  account: Api,
  context: { repo: { owner: string; repo: string } },
  now = Date.now(),
) {
  const repo = context.repo;
  if (repo.owner !== OWNER || repo.repo !== "Rehearsal") throw new Error("Unexpected repository");
  const user = await request(account, userSchema, "GET /user", {});
  if (user.id !== OWNER_ID) throw new Error("Review token must belong to SoroushRF");
  // Enumerate all historical statuses, not the combined/latest status for each context. Another
  // writer can append a status under their own identity but cannot edit/delete these owner rows.
  const statuses = await pages(
    account,
    statusSchema,
    "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
    { ...repo, ref: LEDGER_SHA },
  );
  const ledger: Reservation[] = statuses.flatMap((status) => {
    if (status.creator?.id !== OWNER_ID || !status.context.startsWith(LEDGER_CONTEXT)) return [];
    // Corrupt authoritative shared state fails closed. Comments are never parsed as ledger state.
    return [
      {
        ...reservationSchema.parse(JSON.parse(status.description ?? "")),
        id: status.id,
        at: Date.parse(status.created_at),
      },
    ];
  });
  const pulls = await pages(account, pullSchema, "GET /repos/{owner}/{repo}/pulls", {
    ...repo,
    state: "open",
    sort: "created",
    direction: "asc",
  });
  // One global enumeration discovers old deferred owner commands. No per-PR reads for irrelevant
  // PRs; queue/receipt comment metadata is display only. Commands remain live authorizations.
  const comments = await pages(
    account,
    commentSchema,
    "GET /repos/{owner}/{repo}/issues/comments",
    repo,
  );
  const manual = comments.filter((c) => isTrigger(c) && !c.body.includes(RECEIPT));
  const results: string[] = [];
  for (const pull of pulls) {
    const target = { ...repo, issue_number: pull.number };
    const ownComments = comments.filter(
      (c) =>
        c.issue_url === `https://api.github.com/repos/${OWNER}/Rehearsal/issues/${pull.number}`,
    );
    const history = ledger.filter((item) => item.pr === pull.number);
    const consumedOverride = Math.max(0, ...history.map((item) => item.override));
    const commands = ownComments
      .filter(
        (c) =>
          c.user?.id === OWNER_ID &&
          c.body === COMMAND &&
          c.created_at === c.updated_at &&
          c.id > consumedOverride,
      )
      .sort((a, b) => b.id - a.id);
    if ((!ready(pull) || !requested(pull)) && commands.length === 0) continue;
    try {
      let override: Comment | undefined;
      for (const command of commands) {
        // REST timestamps have second precision. GraphQL also detects same-second edits.
        const edited = await request(
          account,
          z.object({ data: z.object({ node: z.object({ lastEditedAt: z.string().nullable() }) }) }),
          "POST /graphql",
          {
            query: "query($id: ID!) { node(id: $id) { ... on IssueComment { lastEditedAt } } }",
            variables: { id: command.node_id },
          },
        );
        if (edited.data.node.lastEditedAt === null) {
          override = command;
          break;
        }
      }
      if (!override && (!ready(pull) || !requested(pull))) continue;
      const events = await pages(
        account,
        eventSchema,
        "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
        target,
      );
      const latest = events
        .filter(
          (event) =>
            event.id &&
            ((event.event === "review_requested" && event.requested_reviewer?.id === OWNER_ID) ||
              (event.event === "labeled" && event.label?.name === LABEL)),
        )
        .at(-1);
      const queuedRequest = String(latest?.id ?? 0);
      if (!latest && !override) continue;
      const save = async (message: string) => {
        const body = `${QUEUE}\n${message}`;
        const status = ownComments.findLast(
          (c) => c.user?.id === OWNER_ID && c.body.startsWith(QUEUE),
        );
        if (status?.body !== body)
          await request(
            account,
            commentSchema,
            status
              ? "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"
              : "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
            { ...target, comment_id: status?.id, body },
          );
        results.push(`#${pull.number}: ${message}`);
      };
      if (
        !override &&
        history.some((item) => item.request === queuedRequest || item.head === pull.head.sha)
      ) {
        await save(
          "Already reserved for this request or commit; never re-posted. A reservation is not a completed review. Check the trigger/Codex activity; if absent or uncertain, use a fresh owner command.",
        );
        continue;
      }
      if (pull.draft) {
        await save("Queued — not reviewed: waiting for non-draft.");
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
            (item.pull_requests.some((pr) => pr.number === pull.number) ||
              // GitHub may omit fork associations. Require its head repository and branch instead.
              (item.pull_requests.length === 0 &&
                pull.head.repo &&
                item.head_repository?.full_name === pull.head.repo.full_name &&
                item.head_branch === pull.head.ref)),
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
        ledger.filter((item) => item.at > now - WINDOW).length +
          manual.filter((c) => Date.parse(c.created_at) > now - WINDOW).length >=
          LIMIT
      ) {
        await save("Queued — not reviewed: 12-review rolling 5-hour limit reached.");
        continue;
      }
      if (
        !override &&
        (history.some((item) => item.at > now - COOLDOWN) ||
          manual.some(
            (c) =>
              c.issue_url.endsWith(`/issues/${pull.number}`) &&
              Date.parse(c.created_at) > now - COOLDOWN,
          ))
      ) {
        await save("Queued — not reviewed: 60-minute per-PR cooldown.");
        continue;
      }
      const current = await request(
        account,
        pullSchema,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { ...repo, pull_number: pull.number },
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
      const entry = {
        pr: pull.number,
        head: pull.head.sha,
        request: queuedRequest,
        override: override?.id ?? 0,
      };
      const description = JSON.stringify(entry);
      if (description.length > 140) throw new Error("Ledger entry exceeds GitHub's status limit");
      let reservation: z.infer<typeof statusSchema>;
      const statusContext = `${LEDGER_CONTEXT}${new Date(now).toISOString().slice(0, 10)}`;
      try {
        reservation = await request(
          account,
          statusSchema,
          "POST /repos/{owner}/{repo}/statuses/{sha}",
          {
            ...repo,
            sha: LEDGER_SHA,
            state: "success",
            context: statusContext,
            description,
            target_url: `https://github.com/${OWNER}/Rehearsal/pull/${pull.number}`,
          },
        );
        if (
          reservation.creator?.id !== OWNER_ID ||
          reservation.context !== statusContext ||
          reservation.description !== description
        ) {
          throw new Error("Reservation acknowledgement does not match the requested entry");
        }
      } catch {
        throw new LedgerWriteError(
          "Reservation was not acknowledged; no trigger sent. Check Commit statuses: write permission and reload the ledger before retrying.",
        );
      }
      ledger.push({ ...entry, id: reservation.id, at: Date.parse(reservation.created_at) });
      // A crash or lost response after reservation never permits an automatic second POST.
      await request(
        account,
        commentSchema,
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          ...target,
          body: `@codex review\n\n${RECEIPT}${reservation.id} -->\nRequested head: ${pull.head.sha}. Check Codex's reported reviewed commit if the branch moves.`,
        },
      );
      await save(
        `Dispatched for ${pull.head.sha}${override ? " by owner override" : ""}; awaiting Codex, not a review approval.`,
      );
    } catch (error) {
      if (error instanceof LedgerWriteError) throw error;
      // PR-local read/parsing/display failures do not strand other PRs. Reservations remain spent.
      results.push(
        `#${pull.number}: not reviewed or dispatch uncertain — ${error instanceof Error ? error.message : "request failed"}. Any existing reservation remains consumed; inspect before a fresh owner command.`,
      );
    }
  }
  return results.length ? results : ["No pending review requests."];
}
