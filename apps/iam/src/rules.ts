import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthzRuleFile } from "@rehearsal/contracts";

/** `id@version`, the only name a caller may use. The caller never sends the file. */
export function ruleKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/**
 * Every `*.json` file under `dir`, parsed as a rule file. A duplicate `id@version` or a file that
 * does not parse refuses startup: IAM will not serve a set of rules it is not sure of.
 */
export function loadRuleFiles(dir: string): Map<string, AuthzRuleFile> {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) throw new Error(`no rule files in ${dir}`);
  const files = new Map<string, AuthzRuleFile>();
  for (const name of names) {
    const parsed = AuthzRuleFile.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    const key = ruleKey(parsed.id, parsed.version);
    if (files.has(key)) throw new Error(`duplicate rule file ${key} (${name})`);
    files.set(key, parsed);
  }
  return files;
}
