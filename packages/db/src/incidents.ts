import { randomInt } from "node:crypto";
import { type IncidentDraft, type IncidentKind, StoredIncident } from "@rehearsal/contracts";
import { and, desc, eq } from "drizzle-orm";
import builtIn from "../../../scenarios/billing/incident.v1.json" with { type: "json" };
import type { Db } from "./index";
import { incidents } from "./schema";

/** The middle part of an incident ID, so a reviewer can tell the kind from the ID alone. */
export const INCIDENT_ID_KIND: Record<IncidentKind, string> = {
  duplicate_charge: "BILL",
  service_outage: "OUTAGE",
  support_backlog: "BACKLOG",
};

type IncidentRow = typeof incidents.$inferSelect;

function toStored(row: IncidentRow): StoredIncident {
  return StoredIncident.parse({
    incidentId: row.incidentId,
    orgId: row.orgId,
    kind: row.kind,
    title: row.title,
    description: row.description,
    window: { createdGte: row.windowGte.toISOString(), createdLt: row.windowLt.toISOString() },
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Files an incident. IDs are random within the kind and unique across orgs; a collision retries
 * with a fresh number, and the insert never overwrites a row.
 */
export async function insertIncident(
  db: Db,
  orgId: string,
  createdBy: string,
  draft: IncidentDraft,
  pick: () => number = () => randomInt(10_000),
): Promise<StoredIncident> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const incidentId = `INC-${INCIDENT_ID_KIND[draft.kind]}-${String(pick()).padStart(4, "0")}`;
    if (incidentId === builtIn.incident) continue;
    const [row] = await db
      .insert(incidents)
      .values({
        incidentId,
        orgId,
        kind: draft.kind,
        title: draft.title,
        description: draft.description,
        windowGte: new Date(draft.window.createdGte),
        windowLt: new Date(draft.window.createdLt),
        createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toStored(row);
  }
  throw new Error("no free incident ID");
}

/** The org's incidents, newest first. */
export async function listIncidents(db: Db, orgId: string, limit = 50): Promise<StoredIncident[]> {
  const rows = await db
    .select()
    .from(incidents)
    .where(eq(incidents.orgId, orgId))
    .orderBy(desc(incidents.createdAt))
    .limit(limit);
  return rows.map(toStored);
}

/** One of the org's incidents. Another org's ID reads as missing. */
export async function loadIncident(
  db: Db,
  orgId: string,
  incidentId: string,
): Promise<StoredIncident | undefined> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.orgId, orgId), eq(incidents.incidentId, incidentId)));
  return row && toStored(row);
}
