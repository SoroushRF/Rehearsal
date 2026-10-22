import { createDb, startQueue } from "@rehearsal/db";
import { buildApp } from "./app";
import { noAuth } from "./apply";

const apply = process.env.DATABASE_URL
  ? { db: createDb(), boss: await startQueue(), auth: noAuth }
  : undefined;
const app = buildApp({ apply });
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
