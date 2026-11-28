# Blockers

**The live board is [`BLOCKERS.md` on the `status` branch](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md).** It has:
- The top blockers: open tasks that hold up the most other work.
- A list per track showing each task's status, what blocks it (with that task's track and status) and what it blocks.
- A task graph coloured by status.

## How it stays current

A GitHub Action ([`blocker-board`](../.github/workflows/blockers.yml)) regenerates the board when an issue is opened, closed, reopened, edited, deleted or given a milestone, and on every push to `main`, which includes every merge. It also runs every 10 minutes, and that run picks up newly opened PRs and pushed branches. It deliberately doesn't run on PR events, so it never adds a check to anyone's PR. It publishes to the `status` branch because `main` only accepts PRs with green CI, which the Actions bot can't open for itself.

Status comes from GitHub:

| Status | Rule |
|---|---|
| ✅ done | The task's issue is closed |
| 👀 in review | An open PR's branch or title names the task (`t3/T3.2-…`), or its body says `Closes #N` / `Refs #N` |
| 🔨 in progress | A pushed branch names the task |
| 🟨 ready | Every task in its **Blocked by** is done |
| 🟥 blocked | Something in its **Blocked by** isn't done |

**What you maintain:** the **Blocked by** column in the task tables in [`docs/tracks/`](tracks/). When a dependency changes, or you add a task, edit that column in a PR. Everything else is automatic.

## Beyond, killer and benchmark work

The [Oct 24 scope and handoff map](beyond.md) records 15 beyond, 8 optional killer and 2 additional benchmark tasks. Their rows live in the same track tables, so this generator includes cross-track blockers and reverse/transitive links without a second board. ML work is excluded from the new graph.

The **Blocked by** column in the track tables is the single source of truth for dependency edges. GitHub's native blocked-by relationships are not maintained (a few old issues still carry them; ignore them), and an issue body's "Blocked by" section is a copy for readers. When a dependency changes, change the table row; update the issue body in the same pass if it lists blockers. New rows appear on the live board after their documentation PR merges to main; issue creation alone cannot make unmerged rows appear.

A blocker is a completion/acceptance prerequisite. Teams can build against agreed contracts and fixtures earlier. Conditional killer results and external recruitment/account gates are described in beyond.md, not encoded as fake mandatory task dependencies. The milestone column follows the issue's GitHub milestone (M6–M9, or `Deferred` when it has none); M1–M5 are historical.

To preview the board locally:

```bash
pnpm blockers
```
