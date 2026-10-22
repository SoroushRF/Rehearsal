import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export * from "./journal";
export { schema };

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(url, { schema });
}

export type Db = ReturnType<typeof createDb>;
