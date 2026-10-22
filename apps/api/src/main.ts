import { createDb, type PgBoss, startQueue } from "@rehearsal/db";
import { buildApp } from "./app";
import { type ApplyDeps, noAuth } from "./apply";
import { tenantTokenDepsFromEnv } from "./tenant-tokens";

/** Command routes need Postgres. Without it the API still starts in core mode and serves health. */
async function applyDeps(): Promise<ApplyDeps | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    return { db: createDb(), boss: await startQueue(), auth: noAuth };
  } catch (err) {
    console.error("database unavailable; starting without command routes", err);
    return undefined;
  }
}

const apply = await applyDeps();
const boss: PgBoss | undefined = apply?.boss;
const app = buildApp({ apply, tenantTokens: tenantTokenDepsFromEnv() });
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await boss?.stop();
    process.exit(0);
  });
}

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
