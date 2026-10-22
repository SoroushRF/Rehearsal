import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema";

export * from "./apply";
export * from "./apply-store";
export * from "./journal";
export * from "./queue";
export * from "./runs";
export { schema };

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(url, { schema });
}

export type Db = ReturnType<typeof createDb>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies the checked-in migrations. Used by tests and by local setup. */
export function migrateDb(db: Db) {
  return migrate(db, { migrationsFolder });
}
