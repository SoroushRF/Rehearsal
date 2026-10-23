import { PlanManifest, RunEvent, Sha256Hex, Timestamp } from "@rehearsal/contracts";
import { z } from "zod";
import { RunView } from "./runs";

/**
 * A saved run: the plan, the run and its events, as a static file. Anyone can open one without
 * signing in, so it holds no tenant data and the page never offers to change or apply it.
 * `scripts/replay` writes them (apps/web/public/replays).
 */
export const SavedReplay = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  savedAt: Timestamp,
  /** "fixture" until the run happened against real Era images. */
  evidence: z.enum(["fixture", "era_integration"]),
  /** How the run was produced, shown on the page. */
  source: z.string(),
  planHash: Sha256Hex,
  manifest: PlanManifest,
  run: RunView.omit({ createdAt: true, updatedAt: true }).extend({
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
  events: z.array(RunEvent),
});
export type SavedReplay = z.infer<typeof SavedReplay>;

export const ReplayIndex = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    evidence: z.enum(["fixture", "era_integration"]),
  }),
);
export type ReplayIndex = z.infer<typeof ReplayIndex>;

/** The replay ID in the address, if the page was opened as `?replay=…`; "" lists them all. */
export function replayParam(search: string): string | null {
  return new URLSearchParams(search).get("replay");
}

/** Replay IDs are file names, so only plain ones are ever fetched. */
export const validReplayId = (id: string) => /^[a-z0-9-]+$/.test(id);

export async function loadReplay(
  id: string,
  fetchFile: (path: string) => Promise<Response> = (p) => fetch(p),
): Promise<SavedReplay> {
  if (!validReplayId(id)) throw new Error("not a replay");
  const res = await fetchFile(`/replays/${id}.json`);
  if (!res.ok) throw new Error(`no saved replay named ${id}`);
  const replay = SavedReplay.parse(await res.json());
  if (replay.id !== id) throw new Error("replay file doesn't match its name");
  return replay;
}

export async function loadReplayIndex(
  fetchFile: (path: string) => Promise<Response> = (p) => fetch(p),
): Promise<ReplayIndex> {
  const res = await fetchFile("/replays/index.json");
  if (!res.ok) throw new Error("no saved replays");
  return ReplayIndex.parse(await res.json());
}
