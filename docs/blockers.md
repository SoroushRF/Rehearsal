# Blockers

**The live board is [`BLOCKERS.md` on the `status` branch](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md).** It has:
- The top blockers: open tasks that hold up the most other work.
- A list per track showing each task's status, what blocks it (with that task's track and status) and what it blocks.
- A task graph coloured by status.

## How it stays current

A GitHub Action ([`blocker-board`](../.github/workflows/blockers.yml)) regenerates the board when an issue is opened, closed, reopened or edited, and on every push to `main`, which includes every merge. It also runs every 10 minutes, and that run picks up newly opened PRs and pushed branches. It deliberately doesn't run on PR events, so it never adds a check to anyone's PR. It publishes to the `status` branch because `main` only accepts PRs with green CI, which the Actions bot can't open for itself.

Status comes from GitHub:

| Status | Rule |
|---|---|
| ✅ done | The task's issue is closed |
| 👀 in review | An open PR's branch or title names the task (`t3/T3.2-…`), or its body says `Closes #N` / `Refs #N` |
| 🔨 in progress | A pushed branch names the task |
| 🟨 ready | Every task in its **Blocked by** is done |
| 🟥 blocked | Something in its **Blocked by** isn't done |

**What you maintain:** the **Blocked by** column in the task tables in [`docs/tracks/`](tracks/). When a dependency changes, or you add a task, edit that column in a PR. Everything else is automatic.

To preview the board locally:

```bash
pnpm blockers
```
