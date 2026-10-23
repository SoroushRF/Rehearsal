import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReplays, replayIndex } from "./build";

/** Writes the saved replays the review page ships with (apps/web/public/replays). */
const dir = fileURLToPath(new URL("../../apps/web/public/replays/", import.meta.url));
mkdirSync(dir, { recursive: true });

const replays = await buildReplays();
for (const r of replays) {
  writeFileSync(`${dir}${r.id}.json`, `${JSON.stringify(r, null, 2)}\n`);
  console.log(`wrote ${r.id}.json (${r.run.state}, ${r.events.length} events)`);
}
writeFileSync(`${dir}index.json`, `${JSON.stringify(replayIndex(replays), null, 2)}\n`);
console.log("wrote index.json");
