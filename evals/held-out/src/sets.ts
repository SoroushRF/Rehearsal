import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { BillingPolicy } from "@rehearsal/core";
import { type IncidentRecords, incidentCustomers, incidentRecords } from "@rehearsal/testkit";
import { Incident, Tasks } from "./schema";

/**
 * T4.14: the held-out sets, without their gold. A planner or baseline gets a set's brief and its
 * worlds, nothing else from here. Scoring code reads the answers through the separate gold entry.
 */

const ROOT = new URL("../", import.meta.url);
export const POLICIES = new URL("../../scenarios/billing/", ROOT);

/** Hand-authored held-out sets, or the generated scenario catalog (T1.40). Same shapes. */
export type Split = "held-out" | "catalog";

/** Where a split keeps its sets, gold and manifest. */
export function splitRoot(split: Split): URL {
  return split === "held-out" ? ROOT : new URL("catalog/", ROOT);
}

const setsDir = (split: Split) => new URL("sets/", splitRoot(split));

export interface HeldOutSet {
  id: string;
  split: Split;
  incident: Incident;
  tasks: Tasks;
  policy: BillingPolicy;
  records: IncidentRecords;
  customers: Record<string, unknown>[];
}

/**
 * Digest of a JSON file's parsed value, so line endings and formatting don't change it but any
 * change to the data does.
 */
export function jsonDigest(url: URL): string {
  const value = JSON.parse(readFileSync(url, "utf8"));
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function setIds(split: Split = "held-out"): string[] {
  return readdirSync(setsDir(split), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function inputFiles(
  id: string,
  split: Split = "held-out",
): { incident: URL; tasks: URL; policy: URL } {
  const sets = setsDir(split);
  const tasks = Tasks.parse(JSON.parse(readFileSync(new URL(`${id}/tasks.json`, sets), "utf8")));
  return {
    incident: new URL(`${id}/incident.json`, sets),
    tasks: new URL(`${id}/tasks.json`, sets),
    policy: new URL(`policy.v${tasks.policy.version}.json`, POLICIES),
  };
}

export function loadSet(id: string, split: Split = "held-out"): HeldOutSet {
  const files = inputFiles(id, split);
  const incident = Incident.parse(JSON.parse(readFileSync(files.incident, "utf8")));
  const tasks = Tasks.parse(JSON.parse(readFileSync(files.tasks, "utf8")));
  if (tasks.set !== id) throw new Error(`${id}/tasks.json names set ${tasks.set}`);
  const policy = JSON.parse(readFileSync(files.policy, "utf8")) as BillingPolicy;
  return {
    id,
    split,
    incident,
    tasks,
    policy,
    records: incidentRecords(incident),
    customers: incidentCustomers(incident),
  };
}

export function loadSets(split: Split = "held-out"): HeldOutSet[] {
  return setIds(split).map((id) => loadSet(id, split));
}

/** The cases a task asks about. */
export function scopeOf(set: HeldOutSet, taskId: string): string[] {
  const task = set.tasks.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`${set.id} has no task ${taskId}`);
  return task.scope === "all" ? set.incident.cases.map((c) => c.key) : task.scope;
}
