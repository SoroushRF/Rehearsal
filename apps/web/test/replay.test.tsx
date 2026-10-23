import { readdirSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildReplays, replayIndex } from "../../../scripts/replay/build";
import { ReplayView } from "../src/components/ReplayPage";
import {
  loadReplay,
  loadReplayIndex,
  ReplayIndex,
  replayParam,
  SavedReplay,
  validReplayId,
} from "../src/replay";

const dir = new URL("../public/replays/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");

describe("checked-in saved replays", () => {
  it("are all valid saved replays, named after their ID", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const replay = SavedReplay.parse(read(f));
      expect(`${replay.id}.json`).toBe(f);
    }
  });

  it("are listed exactly in the index", () => {
    const index = ReplayIndex.parse(read("index.json"));
    expect(index.map((r) => r.id).sort()).toEqual(files.map((f) => f.replace(".json", "")).sort());
  });

  it("match what the executor engine produces now (run `pnpm replay:build` if this fails)", async () => {
    const built = await buildReplays();
    for (const b of built) expect(read(`${b.id}.json`)).toEqual(JSON.parse(JSON.stringify(b)));
    expect(read("index.json")).toEqual(replayIndex(built));
  });

  it("are labelled as fixture runs until they ran against real Era images", () => {
    for (const f of files) expect(SavedReplay.parse(read(f)).evidence).toBe("fixture");
  });
});

describe("saved replay page", () => {
  const phantom = SavedReplay.parse(read("phantom.json"));
  const html = text(renderToStaticMarkup(<ReplayView replay={phantom} />));

  it("says it is a saved recording, not live, and how it was made", () => {
    expect(html).toContain("Saved replay, not live");
    expect(html).toContain("Fixture");
    expect(html).toContain("Nothing here can be changed or applied.");
    expect(html).toContain("in-memory fake provider");
  });

  it("shows the plan and what happened, including the phantom hold", () => {
    expect(html).toContain("New matching record appeared after approval (ch_fixture_001_dup)");
    expect(html).toContain("Waits for refund_001, which didn't complete.");
    expect(html).toContain("1 held");
  });

  it("offers nothing to change: no checkboxes, no approve, no apply", () => {
    const raw = renderToStaticMarkup(<ReplayView replay={phantom} />);
    expect(raw).not.toContain('type="checkbox"');
    expect(raw).not.toMatch(/>\s*(Approve|Apply to production|Create revision)/);
  });
});

describe("loading a replay", () => {
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("only fetches plain replay IDs", async () => {
    let called = false;
    const fetchFile = async () => {
      called = true;
      return new Response("{}");
    };
    for (const bad of ["../secret", "a/b", "A", "x.json", "", "a b"]) {
      expect(validReplayId(bad)).toBe(false);
      await expect(loadReplay(bad, fetchFile)).rejects.toThrow();
    }
    expect(called).toBe(false);
  });

  it("refuses a file that isn't the replay it was asked for", async () => {
    await expect(loadReplay("happy-path", ok(read("phantom.json")))).rejects.toThrow(
      "doesn't match its name",
    );
  });

  it("explains a missing replay", async () => {
    const missing = async () => new Response("nope", { status: 404 });
    await expect(loadReplay("nothing", missing)).rejects.toThrow("no saved replay named nothing");
    await expect(loadReplayIndex(missing)).rejects.toThrow("no saved replays");
  });

  it("reads the replay ID from the address", () => {
    expect(replayParam("?replay=phantom")).toBe("phantom");
    expect(replayParam("?replay=")).toBe("");
    expect(replayParam("?bundle=phantom")).toBeNull();
    expect(replayParam("")).toBeNull();
  });
});
