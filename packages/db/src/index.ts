import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema";

export * from "./apply";
export * from "./apply-store";
export * from "./incidents";
export * from "./journal";
export * from "./precedents";
export * from "./queue";
export * from "./rehearsal-lifecycle";
export * from "./rehearsal-runner";
export * from "./rehearsal-sets";
export * from "./rehearsals";
export * from "./runs";
export { schema };

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(url, { schema });
}

export type Db = ReturnType<typeof createDb>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies the checked-in migrations. Used by tests and by local setup. */
export async function migrateDb(db: Db) {
  // Serialize concurrent migrators (parallel test files, two processes starting at once): drizzle's
  // migrator takes no lock of its own. The session lock lives on one dedicated connection.
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('rehearsal:migrate', 0))");
    await migrate(db, { migrationsFolder });
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtextextended('rehearsal:migrate', 0))")
      .catch(() => {});
    client.release();
  }
}
