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
const SETS = new URL("sets/", ROOT);
const POLICIES = new URL("../../scenarios/billing/", ROOT);

export interface HeldOutSet {
  id: string;
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

export function setIds(): string[] {
  return readdirSync(SETS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function inputFiles(id: string): { incident: URL; tasks: URL; policy: URL } {
  const tasks = Tasks.parse(JSON.parse(readFileSync(new URL(`${id}/tasks.json`, SETS), "utf8")));
  return {
    incident: new URL(`${id}/incident.json`, SETS),
    tasks: new URL(`${id}/tasks.json`, SETS),
    policy: new URL(`policy.v${tasks.policy.version}.json`, POLICIES),
  };
}

export function loadSet(id: string): HeldOutSet {
  const files = inputFiles(id);
  const incident = Incident.parse(JSON.parse(readFileSync(files.incident, "utf8")));
  const tasks = Tasks.parse(JSON.parse(readFileSync(files.tasks, "utf8")));
  if (tasks.set !== id) throw new Error(`${id}/tasks.json names set ${tasks.set}`);
  const policy = JSON.parse(readFileSync(files.policy, "utf8")) as BillingPolicy;
  return {
    id,
    incident,
    tasks,
    policy,
    records: incidentRecords(incident),
    customers: incidentCustomers(incident),
  };
}

export function loadSets(): HeldOutSet[] {
  return setIds().map(loadSet);
}

/** The cases a task asks about. */
export function scopeOf(set: HeldOutSet, taskId: string): string[] {
  const task = set.tasks.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`${set.id} has no task ${taskId}`);
  return task.scope === "all" ? set.incident.cases.map((c) => c.key) : task.scope;
}
