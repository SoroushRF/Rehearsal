import type { ResultRef } from "@rehearsal/contracts";

export type { ResolvedBindings } from "./ports";

/** Map key for a ResultRef's resolved value. */
export const bindingKey = (ref: Pick<ResultRef, "stepId" | "path">) => `${ref.stepId}:${ref.path}`;
