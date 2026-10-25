import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { challengeCatalogDocument, planHash } from "@rehearsal/core";
import { allBundles } from "@rehearsal/testkit";

/** Writes the shared fixture bundles to scenarios/billing/cases as JSON (for D's checker, ML, UI mocks). */
const dir = fileURLToPath(new URL("../../scenarios/billing/cases/", import.meta.url));
mkdirSync(dir, { recursive: true });

for (const bundle of allBundles()) {
  const file = `${dir}${bundle.id}.bundle.json`;
  writeFileSync(
    file,
    `${JSON.stringify({ planHash: planHash(bundle.manifest), bundle }, null, 2)}\n`,
  );
  console.log(`wrote ${file}`);
}

const challenges = fileURLToPath(
  new URL("../../scenarios/billing/challenges.v1.json", import.meta.url),
);
writeFileSync(challenges, `${JSON.stringify(challengeCatalogDocument(), null, 2)}\n`);
console.log(`wrote ${challenges}`);
