import type { Action, Observation, QueryObservation, Receipt } from "@rehearsal/contracts";
import { advanceOverlay, emptyOverlay, guardAction } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import { happyPathBundle, phantomBundle } from "../src/bundles";

const NOW = "2026-10-21T16:00:00.000Z";

function operational(observation: Observation): Observation {
  return { ...observation, id: `${observation.id}_now`, world: "operational", capturedAt: NOW };
}

function requery(query: QueryObservation, matchingIds = query.matchingIds): QueryObservation {
  return {
    ...query,
    id: `${query.id}_now`,
    world: "operational",
    cutoff: NOW,
    capturedAt: NOW,
    matchingIds,
  };
}

function actionById(actions: readonly Action[], id: string): Action {
  const action = actions.find((item) => item.id === id);
  if (!action) throw new Error(`fixture action ${id} is missing`);
  return action;
}

describe("guards on the fixture bundles", () => {
  it("admits every happy-path action when nothing changed", () => {
    const { manifest } = happyPathBundle();
    const input = {
      plannedObservations: manifest.observations,
      currentObservations: manifest.observations.map(operational),
      plannedQueries: manifest.queryObservations,
      currentQueries: manifest.queryObservations.map((query) => requery(query)),
    };
    for (const action of manifest.actions) {
      expect(guardAction({ ...input, action })).toEqual({ decision: "admit" });
    }
  });

  it("phantom: holds customer 001's refund on the new charge and admits customer 002", () => {
    const { manifest } = phantomBundle();
    const input = {
      plannedObservations: manifest.observations,
      currentObservations: manifest.observations.map(operational),
      plannedQueries: manifest.queryObservations,
      currentQueries: manifest.queryObservations.map((query) =>
        query.id === "q_charges_001"
          ? requery(query, ["ch_fixture_001", "ch_fixture_001_dup"])
          : requery(query),
      ),
    };

    expect(guardAction({ ...input, action: actionById(manifest.actions, "refund_001") })).toEqual({
      decision: "hold",
      reason: {
        kind: "query_membership_changed",
        queryObservationId: "q_charges_001",
        added: ["ch_fixture_001_dup"],
        removed: [],
      },
    });
    expect(guardAction({ ...input, action: actionById(manifest.actions, "refund_002") })).toEqual({
      decision: "admit",
    });
  });

  it("does not false-hold the note after the case's own confirmed patch", () => {
    const { manifest } = happyPathBundle();
    const patch = actionById(manifest.actions, "patch_001");
    const receipt: Receipt = {
      id: "rcpt_patch_001",
      actionId: patch.id,
      planHash: "cd".repeat(32),
      approvalId: "appr_1",
      outcome: "confirmed",
      providerRef: null,
      observedEffect: { priority: "high" },
      protection: patch.protection,
      holdReason: null,
      limitations: [],
      recordedAt: NOW,
    };
    const overlay = advanceOverlay(emptyOverlay(), patch, receipt, manifest.observations);
    const currentObservations = manifest.observations.map((observation) =>
      observation.id === "obs_ticket_001"
        ? {
            ...operational(observation),
            projection: { ...observation.projection, priority: "high" },
          }
        : operational(observation),
    );

    expect(
      guardAction({
        action: actionById(manifest.actions, "note_001"),
        plannedObservations: manifest.observations,
        currentObservations,
        plannedQueries: manifest.queryObservations,
        currentQueries: manifest.queryObservations.map((query) => requery(query)),
        overlay,
      }),
    ).toEqual({ decision: "admit" });
  });
});
