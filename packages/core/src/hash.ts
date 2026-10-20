import { createHash } from "node:crypto";
import { PlanManifest, type Sha256Hex } from "@rehearsal/contracts";
import { canonicalize } from "./canonical";

export function sha256Hex(input: string): Sha256Hex {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function fingerprint(value: unknown): Sha256Hex {
  return sha256Hex(canonicalize(value));
}

/**
 * Hash of the validated manifest. Parsing first strips unknown keys, so only contract fields
 * (the approved content) can affect the hash.
 */
export function planHash(manifest: unknown): Sha256Hex {
  return fingerprint(PlanManifest.parse(manifest));
}
