import type {
  ExecutionRehearsalReport,
  PlanManifest,
  RehearsalStepReport,
} from "@rehearsal/contracts";
import { ExecutionRehearsalReportView } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiFetch, call, explain, RefusedError } from "../api";
import type { CurrentPlan } from "../execution-rehearsal";
import { shortHash } from "../format";
import { useTenantKey } from "../identity";
import { groupByCase } from "../plan";
import {
  evidenceLabel,
  expectedLabel,
  explainStale,
  headline,
  observedLabel,
  rehearsalReportPath,
  staleReasons,
  tally,
  verificationLabel,
} from "../rehearsal-report";
import { explainHold } from "../runs";
import { Alert, Button, Chip } from "./ui";

/**
 * What a finished rehearsal found, next to the plan being reviewed: expected against observed per
 * step, with the evidence level, the exact revision and versions it ran on, and every reason it may
 * no longer apply. Read-only: it never approves, and "as expected" is not an approval.
 */
export function RehearsalReportToggle({
  apiFetch,
  rehearsalId,
  current,
  manifest,
}: {
  apiFetch: ApiFetch;
  rehearsalId: string;
  current: CurrentPlan;
  manifest: PlanManifest | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <Button
        size="sm"
        icon="eye"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="exec-report-toggle"
      >
        {open ? "Hide report" : "Compare with what was expected"}
      </Button>
      {open && (
        <RehearsalReportLoader
          apiFetch={apiFetch}
          rehearsalId={rehearsalId}
          current={current}
          manifest={manifest}
        />
      )}
    </div>
  );
}

function RehearsalReportLoader({
  apiFetch,
  rehearsalId,
  current,
  manifest,
}: {
  apiFetch: ApiFetch;
  rehearsalId: string;
  current: CurrentPlan;
  manifest: PlanManifest | null;
}) {
  const key = useTenantKey();
  const q = useQuery({
    queryKey: key("execution-rehearsal-report", rehearsalId),
    queryFn: () => call(apiFetch, ExecutionRehearsalReportView, rehearsalReportPath(rehearsalId)),
    retry: false,
  });
  if (q.isPending) return <p className="mt-3 text-sm text-subtle">Loading the report…</p>;
  if (q.isError) {
    const none = q.error instanceof RefusedError && q.error.status === 404;
    return (
      <Alert tone={none ? "info" : "danger"} className="mt-3" data-testid="exec-report-error">
        {none ? "No report was stored for this rehearsal." : explain(q.error)}
      </Alert>
    );
  }
  return <RehearsalReportView view={q.data} current={current} manifest={manifest} />;
}

export function RehearsalReportView({
  view,
  current,
  manifest,
}: {
  view: ExecutionRehearsalReportView;
  current: CurrentPlan;
  manifest: PlanManifest | null;
}) {
  const { report } = view;
  const stale = staleReasons(view, current);
  const head = headline(report, stale.length > 0);
  const t = tally(report.steps);
  // Labels come from the plan only when it is the plan the report ran on.
  const known = manifest && report.plan.planHash === current.planHash ? manifest : null;

  return (
    <div
      data-testid="exec-report"
      data-verdict={report.verdict}
      data-state={report.state}
      data-stale={stale.length > 0 ? "true" : "false"}
      className="mt-3 flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
    >
      {stale.length > 0 && (
        <Alert tone="warn" title="This report may not apply" data-testid="exec-report-stale">
          <ul className="list-disc pl-4">
            {stale.map((r) => (
              <li key={r}>{explainStale(r)}</li>
            ))}
          </ul>
          <p className="mt-1">Rehearse again to get a report for what you are reviewing.</p>
        </Alert>
      )}

      <Alert tone={head.tone === "good" ? "good" : head.tone === "danger" ? "danger" : "warn"}>
        <p className="font-semibold">{head.title}</p>
        <p className="mt-0.5">{head.body}</p>
      </Alert>

      <ul className="flex flex-wrap gap-2 text-xs" aria-label="Results">
        <li>
          <Chip tone="good">{t.matched} as expected</Chip>
        </li>
        <li>
          <Chip tone={t.mismatched ? "danger" : "neutral"}>{t.mismatched} not as expected</Chip>
        </li>
        <li>
          <Chip tone={t.unverified ? "warn" : "neutral"}>{t.unverified} not established</Chip>
        </li>
      </ul>

      <Steps report={report} manifest={known} />

      <Provenance report={report} />

      {report.notFromEvidence.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold tracking-wide text-subtle uppercase">
            Filled in by the simulator, not taken from the plan's evidence
          </h4>
          <p className="mt-1 text-xs text-muted">
            {report.notFromEvidence.map((f) => (
              <code key={f} className="mr-2 font-mono">
                {f}
              </code>
            ))}
          </p>
        </div>
      )}
      {report.limitations.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-muted" aria-label="Limitations">
          {report.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        A finished rehearsal doesn't approve this plan. It still needs its ordinary approval, and it
        says nothing about what changes after the day it ran.
      </p>
    </div>
  );
}

const KIND_LABEL = {
  "stripe.refund.create": "Refund",
  "zendesk.ticket.patchFields": "Ticket fields",
  "zendesk.ticket.appendPrivateNote": "Private note",
  "zendesk.ticket.appendPublicReply": "Reply to customer",
  "slack.message.postSummary": "Slack summary",
  "stripe.customer.balanceCredit": "Invoice credit",
} as const;

type Group = { title: string | null; steps: { step: RehearsalStepReport; label: string }[] };

function Steps({
  report,
  manifest,
}: {
  report: ExecutionRehearsalReport;
  manifest: PlanManifest | null;
}) {
  const byId = new Map(report.steps.map((s) => [s.actionId, s]));
  // With the plan in hand, group by customer; otherwise list the steps as the report has them.
  const groups: Group[] = manifest
    ? groupByCase(manifest).map((g) => ({
        title: g.customerId ?? g.caseId,
        steps: g.actions.flatMap((a) => {
          const step = byId.get(a.id);
          return step ? [{ step, label: KIND_LABEL[a.kind] }] : [];
        }),
      }))
    : [{ title: null, steps: report.steps.map((s) => ({ step: s, label: s.actionId })) }];
  const listed = new Set(groups.flatMap((g) => g.steps.map((x) => x.step.actionId)));
  const extra = report.steps.filter((s) => !listed.has(s.actionId));
  if (extra.length > 0) {
    groups.push({
      title: manifest ? "Other steps" : null,
      steps: extra.map((s) => ({ step: s, label: s.actionId })),
    });
  }
  return (
    <div className="flex flex-col gap-3">
      {groups
        .filter((g) => g.steps.length > 0)
        .map((g) => (
          <section key={g.title ?? "all"} aria-label={g.title ?? "Steps"}>
            {g.title && <h4 className="text-sm font-semibold text-ink">{g.title}</h4>}
            <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
              {g.steps.map(({ step, label }) => (
                <StepRow key={step.actionId} step={step} label={label} />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function StepRow({ step, label }: { step: RehearsalStepReport; label: string }) {
  const v = verificationLabel[step.verification.status];
  const r = step.result;
  return (
    <li
      data-testid="exec-report-step"
      data-action={step.actionId}
      data-verification={step.verification.status}
      className={`px-3 py-2.5 ${
        step.verification.status === "mismatched"
          ? "bg-danger-bg/40"
          : step.verification.status === "unverified"
            ? "bg-warn-bg/40"
            : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-ink">{label}</span>
        <code className="font-mono text-xs text-subtle">{step.actionId}</code>
        <Chip
          tone={v.tone}
          icon={v.tone === "good" ? "check" : v.tone === "danger" ? "x" : "alert"}
        >
          {v.text}
        </Chip>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-subtle">Expected</dt>
        <dd className="text-ink">{expectedLabel(step.expected)}</dd>
        <dt className="text-subtle">Observed</dt>
        <dd className="text-ink">{observedLabel(step)}</dd>
      </dl>
      <p className="mt-1 text-xs text-muted">{step.verification.detail}</p>
      {r?.holdReason && <p className="mt-0.5 text-xs text-muted">{explainHold(r.holdReason)}</p>}
      {r && r.limitations.length > 0 && (
        <p className="mt-0.5 text-xs text-subtle">{r.limitations.join("; ")}</p>
      )}
    </li>
  );
}

function Provenance({ report }: { report: ExecutionRehearsalReport }) {
  const v = report.versions;
  const ev = evidenceLabel[report.evidence];
  return (
    <details className="text-xs text-muted" data-testid="exec-report-provenance" open>
      <summary className="cursor-pointer font-semibold tracking-wide text-subtle uppercase">
        Where this came from
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-subtle">Evidence</dt>
        <dd>
          <Chip tone={report.evidence === "fixture" ? "warn" : "info"} hint={ev.hint}>
            {ev.text}
          </Chip>
        </dd>
        <dt className="text-subtle">Plan</dt>
        <dd>
          revision {report.plan.revision} ·{" "}
          <code className="font-mono">{shortHash(report.plan.planHash)}</code>
        </dd>
        <dt className="text-subtle">Scenario</dt>
        <dd>
          <code className="font-mono">
            {report.scenario.id}@{report.scenario.version}
          </code>{" "}
          · challenges <code className="font-mono">{shortHash(report.challengesDigest)}</code>
        </dd>
        <dt className="text-subtle">Snapshot</dt>
        <dd>
          the plan's own evidence ·{" "}
          <code className="font-mono">{shortHash(report.snapshot.digest)}</code>
        </dd>
        <dt className="text-subtle">Policy</dt>
        <dd>
          <code className="font-mono">
            {report.policy.id} v{report.policy.version}
          </code>
        </dd>
        <dt className="text-subtle">Run by</dt>
        <dd>
          <code className="font-mono">
            {v.engine} · {v.worker} · {v.verifier} · {v.commit}
          </code>
        </dd>
        <dt className="text-subtle">Finished</dt>
        <dd>{new Date(report.finishedAt).toLocaleString()}</dd>
      </dl>
    </details>
  );
}
