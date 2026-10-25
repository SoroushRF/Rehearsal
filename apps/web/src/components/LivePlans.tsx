import { ApprovalGrant } from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  type ApiFetch,
  ApplyAccepted,
  ApprovalStatus,
  call,
  explain,
  Grant,
  NewRevision,
  PlanSummary,
  RefusedError,
  StoredPlan,
} from "../api";
import { usePermissions } from "../auth";
import { roleLabel, shortHash } from "../format";
import { useTenantKey } from "../identity";
import { APPROVAL_SEATS, actionAllowed } from "../permissions";
import { droppedBy, requiredRoles } from "../plan";
import { explainPrecedentHold, PrecedentCheck } from "../precedent-holds";
import { RunView } from "../runs";
import { Segmented } from "./AppShell";
import { AuditPanel } from "./AuditPanel";
import { ExecutionRehearsalPanel } from "./ExecutionRehearsalPanel";
import { MembersPanel } from "./MembersPanel";
import { PlanReview } from "./PlanReview";
import { PrecedentPanel } from "./PrecedentPanel";
import { RehearseBar } from "./Rehearse";
import { RunTimeline } from "./RunTimeline";
import { Alert, Button, Card, Chip, Icon, Skeleton, Spinner } from "./ui";

const PlanList = z.object({ plans: z.array(PlanSummary) });
const GrantList = z.object({
  grants: z.array(Grant),
  approval: ApprovalStatus.nullish(),
  /** Do the precedents the newest revision cites still hold? Absent from older servers. */
  precedents: PrecedentCheck.nullish(),
});
const Approved = z.object({ grant: ApprovalGrant, existing: z.boolean() });
const RunList = z.object({ runs: z.array(RunView) });
const planPath = (planId: string) => `/api/plans/${encodeURIComponent(planId)}`;

/** Plans stored for the reviewer's organization, reviewed and approved through the API. */
export function LivePlans({ apiFetch }: { apiFetch: ApiFetch }) {
  const key = useTenantKey();
  const access = usePermissions(apiFetch);
  const plans = useQuery({
    queryKey: key("plans"),
    queryFn: () => call(apiFetch, PlanList, "/api/plans"),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const planId = chosen ?? plans.data?.plans[0]?.planId ?? null;
  // A freshly stored plan is the one to look at next.
  const showStored = useCallback((id: string) => setChosen(id), []);

  if (plans.isPending) return <PageSkeleton what="plans" />;
  if (plans.isError) return <Alert className="mt-2">{explain(plans.error)}</Alert>;

  return (
    <div
      data-testid="access"
      data-ready={access.ready ? "true" : "false"}
      className="flex flex-col gap-6"
    >
      <MembersPanel apiFetch={apiFetch} permissions={access.permissions} />
      <RehearseBar
        apiFetch={apiFetch}
        onStored={showStored}
        allowed={actionAllowed(access.permissions, "rehearse")}
      />

      {!planId ? (
        <Card className="flex flex-col items-center gap-3 border-dashed bg-transparent px-6 py-14 text-center shadow-none">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sunken text-subtle">
            <Icon name="flask" className="h-6 w-6" />
          </span>
          <p className="text-base font-semibold text-ink">No plans for this organization yet.</p>
          <p className="max-w-sm text-sm text-muted">
            Rehearse the incident above. The agent plans in a copy of the company, and the plan
            appears here for review.
          </p>
        </Card>
      ) : (
        <>
          {plans.data.plans.length > 1 && (
            <Segmented
              label="Plans"
              value={planId}
              onChange={setChosen}
              options={plans.data.plans.map((p) => ({
                id: p.planId,
                text: `${p.planId} · r${p.revision}`,
              }))}
            />
          )}
          {plans.data.plans.length === 1 && <h2 className="sr-only">Plans</h2>}
          <LivePlan
            key={planId}
            apiFetch={apiFetch}
            planId={planId}
            permissions={access.permissions}
          />
        </>
      )}
    </div>
  );
}

function PageSkeleton({ what }: { what: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-5">
      <p className="flex items-center gap-2 text-sm text-subtle">
        <Spinner />
        Loading {what}…
      </p>
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21.5rem]">
        <div className="space-y-5">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

/** Approvals and their checks for a plan. Shared by the plan page and its approval panel. */
function useApprovals(apiFetch: ApiFetch, planId: string) {
  const key = useTenantKey();
  return useQuery({
    queryKey: key("grants", planId),
    queryFn: () => call(apiFetch, GrantList, `${planPath(planId)}/approvals`),
  });
}

function LivePlan({
  apiFetch,
  planId,
  permissions,
}: {
  apiFetch: ApiFetch;
  planId: string;
  permissions: readonly string[] | null;
}) {
  const queryClient = useQueryClient();
  const key = useTenantKey();
  const approvals = useApprovals(apiFetch, planId);
  const plan = useQuery({
    queryKey: key("plan", planId),
    queryFn: () => call(apiFetch, StoredPlan, planPath(planId)),
  });
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [lastRevision, setLastRevision] = useState<NewRevision | null>(null);
  const [shownRun, setShownRun] = useState<string | null>(null);

  const revise = useMutation({
    mutationFn: (base: StoredPlan) =>
      call(apiFetch, NewRevision, `${planPath(planId)}/revisions`, {
        baseRevision: base.revision,
        basePlanHash: base.planHash,
        excludeActionIds: [...unchecked],
      }),
    onSuccess: (rev) => {
      setLastRevision(rev);
      setUnchecked(new Set());
      queryClient.invalidateQueries({ queryKey: key("plan", planId) });
      queryClient.invalidateQueries({ queryKey: key("plans") });
    },
  });

  if (plan.isPending) return <PageSkeleton what="plan" />;
  if (plan.isError) return <Alert>{explain(plan.error)}</Alert>;
  const { manifest, planHash } = plan.data;
  const dropped = [...droppedBy(manifest.actions, unchecked)];

  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="enter flex flex-col gap-6">
      {lastRevision && (
        <Alert tone="good">
          Revision {lastRevision.revision} created from {lastRevision.parentRevision}. Dropped{" "}
          {lastRevision.dropped
            .map((d) => `${d.actionId} (${d.reason === "reviewer" ? "unchecked" : "dependent"})`)
            .join(", ")}
          . New hash <code className="font-mono">{shortHash(lastRevision.planHash)}</code>; it needs
          its own approval.
        </Alert>
      )}

      <PlanReview
        manifest={manifest}
        planHash={planHash}
        evidence={manifest.versions.planner.model === "fixture" ? "fixture" : null}
        review={{ unchecked, onToggle: toggle }}
        precedents={approvals.data?.precedents ?? null}
        actions={
          <ApprovalPanel
            apiFetch={apiFetch}
            plan={plan.data}
            editing={unchecked.size > 0}
            permissions={permissions}
            onStale={() => queryClient.invalidateQueries({ queryKey: key("plan", planId) })}
            onRunStarted={setShownRun}
          />
        }
      />

      <ExecutionRehearsalPanel
        apiFetch={apiFetch}
        plan={{ planId, revision: plan.data.revision, planHash }}
        editing={unchecked.size > 0}
        manifest={manifest}
      />

      <RunSection
        apiFetch={apiFetch}
        planId={planId}
        shownRun={shownRun}
        onShow={setShownRun}
        canCancel={actionAllowed(permissions, "cancel")}
      />

      {unchecked.size > 0 && (
        // Floats over the page, lined up under the steps (not the approval panel) on wide screens.
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 px-3 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <div
              data-testid="exclusion-bar"
              className="enter pointer-events-auto flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-surface p-3 pl-4 shadow-raised lg:w-[calc(100%-23.5rem)]"
            >
              <p className="min-w-0 text-sm text-ink">
                <span className="font-semibold">
                  Excluding {dropped.length} step{dropped.length === 1 ? "" : "s"}
                </span>
                <span className="ml-2 font-mono text-xs break-all text-subtle">
                  {dropped.join(", ")}
                </span>
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={() => setUnchecked(new Set())}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={revise.isPending}
                  onClick={() => revise.mutate(plan.data)}
                >
                  Create revision {plan.data.revision + 1}
                </Button>
              </div>
              {revise.isError && <Alert className="w-full">{explain(revise.error)}</Alert>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalPanel({
  apiFetch,
  plan,
  editing,
  permissions,
  onStale,
  onRunStarted,
}: {
  apiFetch: ApiFetch;
  plan: StoredPlan;
  editing: boolean;
  permissions: readonly string[] | null;
  onStale: () => void;
  onRunStarted: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const key = useTenantKey();
  const body = { revision: plan.revision, planHash: plan.planHash };
  const grants = useApprovals(apiFetch, plan.planId);
  const heldPrecedents =
    grants.data?.precedents && !grants.data.precedents.ok ? grants.data.precedents.holds : [];
  const approve = useMutation({
    mutationFn: () => call(apiFetch, Approved, `${planPath(plan.planId)}/approvals`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key("grants", plan.planId) }),
    onError: (err) => {
      // The plan moved on under the reviewer: show them the current revision.
      if (
        err instanceof RefusedError &&
        ["stale_revision", "hash_mismatch"].includes(err.refusal.error)
      )
        onStale();
    },
  });
  const apply = useMutation({
    mutationFn: () => call(apiFetch, ApplyAccepted, `${planPath(plan.planId)}/apply`, body),
    onSuccess: (accepted) => {
      onRunStarted(accepted.runId);
      queryClient.invalidateQueries({ queryKey: key("runs", plan.planId) });
    },
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      call(
        apiFetch,
        z.object({ grant: ApprovalGrant, existing: z.boolean() }),
        `${planPath(plan.planId)}/approvals/${encodeURIComponent(grantId)}/revoke`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key("grants", plan.planId) }),
  });
  const canApprove = actionAllowed(permissions, "approve");
  const canApply = actionAllowed(permissions, "apply");
  const canRevoke = actionAllowed(permissions, "revoke");
  // Where two different approvers are needed, one person's grant isn't "approved" yet.
  const seats = grants.data?.approval?.dualRequired ? grants.data.approval : null;
  const live = grants.data?.grants.find(
    (g) => g.live && g.planHash === plan.planHash && (!seats || seats.satisfied),
  );
  const needs = requiredRoles(plan.manifest)
    .map((r) => roleLabel[r])
    .join(" + ");

  return (
    <Card aria-label="Approval" className="p-5">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${live ? "bg-ok-bg text-ok" : "bg-accent-soft text-accent"}`}
        >
          <Icon name="shield" className="h-[18px] w-[18px]" />
        </span>
        <h3 className="text-[15px] font-semibold text-ink">Approval</h3>
        {live && (
          <Chip tone="good" icon="check">
            Approved
          </Chip>
        )}
      </div>

      {seats && <Seats status={seats} />}

      {live ? (
        <>
          <p data-testid="live-grant" className="mt-3 text-sm leading-5 text-muted">
            {seats ? (
              <>Approved by {seats.signed.map((s) => s.actorUserId).join(" and ")}, until </>
            ) : (
              <>
                Approved by <span className="font-medium text-ink">{live.actorUserId}</span> as{" "}
                {live.roles.map((r) => roleLabel[r]).join(", ")} until{" "}
              </>
            )}
            {new Date(live.expiresAt).toLocaleTimeString()}.
          </p>
          <Button
            variant="success"
            size="md"
            icon="play"
            className="mt-4 w-full"
            loading={apply.isPending}
            disabled={editing || !canApply}
            title={canApply ? undefined : "You don't have permission to apply this plan"}
            onClick={() => apply.mutate()}
          >
            Apply to production
          </Button>
          {!canApply && (
            <p className="mt-2 text-xs leading-4 text-subtle">
              You don't have permission to apply this plan.
            </p>
          )}
          {canRevoke && (
            <Button
              variant="secondary"
              className="mt-2 w-full"
              loading={revoke.isPending}
              onClick={() => revoke.mutate(live.id)}
            >
              Revoke approval
            </Button>
          )}
          <p className="mt-2 text-xs leading-4 text-subtle">
            Applies exactly this plan. Before each step the executor re-checks what it relied on and
            holds anything that changed.
          </p>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm leading-5 text-muted">
            {seats ? (
              <>
                Needs <span className="font-medium text-ink">two different people</span>, one
                holding rehearsal:approve:support_step and one holding
                rehearsal:approve:finance_step. One person can't fill both seats.
              </>
            ) : (
              <>
                Needs <span className="font-medium text-ink">{needs}</span> to approve revision{" "}
                {plan.revision}.
              </>
            )}
          </p>
          <Button
            variant="primary"
            icon="check"
            className="mt-4 w-full"
            loading={approve.isPending}
            disabled={editing || heldPrecedents.length > 0 || !canApprove}
            title={
              !canApprove
                ? "You don't have permission to approve"
                : editing
                  ? "Create the revision first, then approve it"
                  : undefined
            }
            onClick={() => approve.mutate()}
          >
            {seats && seats.signed.length > 0 ? "Add my approval" : "Approve"} revision{" "}
            {plan.revision}
          </Button>
          {!canApprove && (
            <p className="mt-2 text-xs leading-4 text-subtle">
              You don't have permission to approve.
            </p>
          )}
          {editing && (
            <p className="mt-2 text-xs leading-4 text-subtle">
              Create the revision first, then approve it.
            </p>
          )}
        </>
      )}

      {heldPrecedents.length > 0 && (
        <Alert tone="warn" className="mt-3" title="Can't approve yet" data-testid="precedent-hold">
          A precedent this plan rests on has changed.{" "}
          {heldPrecedents.map(explainPrecedentHold).join(" ")} Rehearse again to plan against what
          is in force now.
        </Alert>
      )}
      {approve.isError && <Alert className="mt-3">{explain(approve.error)}</Alert>}
      {apply.isError && <Alert className="mt-3">{explain(apply.error)}</Alert>}
      {revoke.isError && <Alert className="mt-3">{explain(revoke.error)}</Alert>}
      {apply.data && (
        <Alert tone="info" className="mt-3" data-testid="run-started">
          Run <code className="font-mono">{apply.data.runId}</code>{" "}
          {apply.data.existing ? "already exists" : "started"} ({apply.data.state}).
        </Alert>
      )}
    </Card>
  );
}

/** The two seats a large refund needs filled by different people, and who holds each. */
export function Seats({ status }: { status: ApprovalStatus }) {
  return (
    <ul
      aria-label="Approvers"
      className="mt-3 space-y-2 rounded-lg border border-line bg-sunken/60 p-3"
    >
      {APPROVAL_SEATS.map((seat) => {
        const signer = status.signed.find((s) => s.permission === seat.permission);
        return (
          <li
            key={seat.permission}
            data-testid="approval-seat"
            data-seat={seat.seat}
            data-permission={seat.permission}
            data-signed={signer ? "true" : "false"}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="text-muted">
              {seat.label}
              <span className="mt-0.5 block font-mono text-[11px] text-subtle">
                {seat.permission}
              </span>
            </span>
            {signer ? (
              <Chip tone="good" icon="check">
                {signer.actorUserId}
              </Chip>
            ) : (
              <Chip tone="warn" icon="clock">
                Waiting
              </Chip>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The plan's runs, newest first, with the chosen one followed live. */
function RunSection({
  apiFetch,
  planId,
  shownRun,
  onShow,
  canCancel,
}: {
  apiFetch: ApiFetch;
  planId: string;
  shownRun: string | null;
  onShow: (id: string) => void;
  canCancel: boolean;
}) {
  const key = useTenantKey();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) =>
      call(
        apiFetch,
        z.object({ runId: z.string(), state: z.string() }),
        `/api/runs/${encodeURIComponent(id)}/cancel`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key("runs", planId) }),
  });
  const runs = useQuery({
    queryKey: key("runs", planId),
    queryFn: () => call(apiFetch, RunList, `${planPath(planId)}/runs`),
  });
  const runId = shownRun ?? runs.data?.runs[0]?.id ?? null;
  const top = useRef<HTMLElement>(null);
  // Starting a run brings its report into view: the outcome is what the reviewer came for.
  useEffect(() => {
    if (!shownRun) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  }, [shownRun]);
  if (!runId) return null;
  const all = runs.data?.runs ?? [];

  return (
    <section ref={top} aria-label="Runs" className="flex scroll-mt-20 flex-col gap-3">
      {canCancel && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            loading={cancel.isPending}
            onClick={() => cancel.mutate(runId)}
          >
            Cancel run
          </Button>
        </div>
      )}
      {cancel.isError && <Alert>{explain(cancel.error)}</Alert>}
      {all.length > 1 && (
        <nav aria-label="Runs" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {all.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-current={r.id === runId ? "true" : undefined}
              onClick={() => onShow(r.id)}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs whitespace-nowrap text-muted shadow-card aria-[current=true]:border-accent aria-[current=true]:text-ink"
            >
              r{r.revision} · {r.state} · {new Date(r.createdAt).toLocaleTimeString()}
            </button>
          ))}
        </nav>
      )}
      <RunTimeline key={runId} apiFetch={apiFetch} runId={runId} />
      <AuditPanel key={`audit-${runId}`} apiFetch={apiFetch} runId={runId} />
      <PrecedentPanel
        key={`precedent-${runId}`}
        apiFetch={apiFetch}
        runId={runId}
        completed={all.find((r) => r.id === runId)?.state === "completed"}
      />
    </section>
  );
}
