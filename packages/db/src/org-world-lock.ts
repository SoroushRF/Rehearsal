import { sql } from "drizzle-orm";
import type { Db } from "./index";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class OrgWorldBusy extends Error {
  constructor() {
    super("work_in_progress");
  }
}

/** Reset and job admission share a database lock, including across API processes. */
export async function lockOrgWorlds(tx: Pick<Db, "execute">, orgId: string): Promise<void> {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`rehearsal:org-worlds:${orgId}`}, 0)) as ok`,
  );
  if (!rows[0]?.ok) throw new OrgWorldBusy();
}

export function withOrgWorlds<T>(db: Db, orgId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockOrgWorlds(tx, orgId);
    return work(tx);
  });
}
