import { ApprovalGrant } from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import {
  type ApiFetch,
  ApplyAccepted,
  call,
  explain,
  Grant,
  NewRevision,
  PlanSummary,
  RefusedError,
  StoredPlan,
} from "../api";
import { roleLabel, shortHash } from "../format";
import { droppedBy, requiredRoles } from "../plan";
import { PlanReview } from "./PlanReview";

const PlanList = z.object({ plans: z.array(PlanSummary) });
const GrantList = z.object({ grants: z.array(Grant) });
const Approved = z.object({ grant: ApprovalGrant, existing: z.boolean() });
const planPath = (planId: string) => `/api/plans/${encodeURIComponent(planId)}`;

/** Plans stored for the reviewer's organization, reviewed and approved through the API. */
export function LivePlans({ apiFetch }: { apiFetch: ApiFetch }) {
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => call(apiFetch, PlanList, "/api/plans"),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const planId = chosen ?? plans.data?.plans[0]?.planId ?? null;

  if (plans.isPending) return <p className="mt-6 text-sm text-slate-500">Loading plans…</p>;
  if (plans.isError) return <Problem>{explain(plans.error)}</Problem>;
  if (!planId) return <p className="mt-6 text-slate-600">No plans for this organization yet.</p>;

  return (
    <div className="mt-6">
      <nav aria-label="Plans" className="flex flex-wrap gap-2">
        {plans.data.plans.map((p) => (
          <button
            key={p.planId}
            type="button"
            aria-current={p.planId === planId ? "page" : undefined}
            onClick={() => setChosen(p.planId)}
            className="rounded-full border border-slate-300 px-3 py-1 text-sm aria-[current=page]:border-slate-900 aria-[current=page]:bg-slate-900 aria-[current=page]:text-white"
          >
            {p.planId} <span className="opacity-70">r{p.revision}</span>
          </button>
        ))}
      </nav>
      <LivePlan key={planId} apiFetch={apiFetch} planId={planId} />
    </div>
  );
}

function LivePlan({ apiFetch, planId }: { apiFetch: ApiFetch; planId: string }) {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => call(apiFetch, StoredPlan, planPath(planId)),
  });
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [lastRevision, setLastRevision] = useState<NewRevision | null>(null);

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
      queryClient.invalidateQueries({ queryKey: ["plan", planId] });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  if (plan.isPending) return <p className="mt-6 text-sm text-slate-500">Loading plan…</p>;
  if (plan.isError) return <Problem>{explain(plan.error)}</Problem>;
  const { manifest, planHash } = plan.data;
  const dropped = [...droppedBy(manifest.actions, unchecked)];

  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mt-4">
      {lastRevision && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          Revision {lastRevision.revision} created from {lastRevision.parentRevision}. Dropped{" "}
          {lastRevision.dropped
            .map((d) => `${d.actionId} (${d.reason === "reviewer" ? "unchecked" : "dependent"})`)
            .join(", ")}
          . New hash <code className="font-mono">{shortHash(lastRevision.planHash)}</code>; it needs
          its own approval.
        </p>
      )}

      <PlanReview
        manifest={manifest}
        planHash={planHash}
        evidence={manifest.versions.planner.model === "fixture" ? "fixture" : null}
        review={{ unchecked, onToggle: toggle }}
      />

      {unchecked.size > 0 && (
        <div
          data-testid="exclusion-bar"
          className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white p-3 shadow"
        >
          <p className="text-sm">
            Excluding {dropped.length} action{dropped.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono text-xs">{dropped.join(", ")}</span>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setUnchecked(new Set())}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={revise.isPending}
              onClick={() => revise.mutate(plan.data)}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Create revision {plan.data.revision + 1}
            </button>
          </div>
          {revise.isError && <Problem>{explain(revise.error)}</Problem>}
        </div>
      )}

      <ApprovalPanel
        apiFetch={apiFetch}
        plan={plan.data}
        editing={unchecked.size > 0}
        onStale={() => queryClient.invalidateQueries({ queryKey: ["plan", planId] })}
      />
    </div>
  );
}

function ApprovalPanel({
  apiFetch,
  plan,
  editing,
  onStale,
}: {
  apiFetch: ApiFetch;
  plan: StoredPlan;
  editing: boolean;
  onStale: () => void;
}) {
  const queryClient = useQueryClient();
  const body = { revision: plan.revision, planHash: plan.planHash };
  const grants = useQuery({
    queryKey: ["grants", plan.planId],
    queryFn: () => call(apiFetch, GrantList, `${planPath(plan.planId)}/approvals`),
  });
  const approve = useMutation({
    mutationFn: () => call(apiFetch, Approved, `${planPath(plan.planId)}/approvals`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants", plan.planId] }),
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
  });
  const live = grants.data?.grants.find((g) => g.live && g.planHash === plan.planHash);

  return (
    <section aria-label="Approval" className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-medium">Approval</h3>
      <p className="mt-1 text-sm text-slate-600">
        Needs{" "}
        {requiredRoles(plan.manifest)
          .map((r) => roleLabel[r])
          .join(" + ")}
        . Approving binds to revision {plan.revision}, hash{" "}
        <code className="font-mono">{shortHash(plan.planHash)}</code>.
      </p>

      {live ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p data-testid="live-grant" className="text-sm text-emerald-800">
            Approved by {live.actorUserId} as {live.roles.map((r) => roleLabel[r]).join(", ")} until{" "}
            {new Date(live.expiresAt).toLocaleTimeString()}.
          </p>
          <button
            type="button"
            disabled={apply.isPending || editing}
            onClick={() => apply.mutate()}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Apply to production
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={approve.isPending || editing}
          title={editing ? "Create the revision first, then approve it" : undefined}
          onClick={() => approve.mutate()}
          className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Approve revision {plan.revision}
        </button>
      )}

      {approve.isError && <Problem>{explain(approve.error)}</Problem>}
      {apply.isError && <Problem>{explain(apply.error)}</Problem>}
      {apply.data && (
        <p role="status" data-testid="run-started" className="mt-3 text-sm">
          Run <code className="font-mono">{apply.data.runId}</code>{" "}
          {apply.data.existing ? "already exists" : "started"} ({apply.data.state}).
        </p>
      )}
    </section>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="mt-3 rounded bg-rose-50 p-2 text-sm text-rose-800">
      {children}
    </p>
  );
}
