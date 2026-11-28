import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "../src";

/** A database owned by this suite: queues and advisory locks cannot affect another file. */
export function isolatedTestDatabase() {
  const parentUrl =
    process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const name = `rehearsal_test_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(parentUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  const db = createDb(url);
  let created = false;
  const admin = async (command: string) => {
    const connection = createDb(parentUrl);
    try {
      await connection.execute(sql.raw(command));
    } finally {
      await connection.$client.end();
    }
  };
  return {
    db,
    url,
    async create() {
      await admin(`CREATE DATABASE ${name}`);
      created = true;
    },
    async drop() {
      await db.$client.end();
      if (created) await admin(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}
