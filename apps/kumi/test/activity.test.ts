import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGlyph, activityOf, activityScene, shimmer, type Activity } from "../src/tui/activity.js";
import { FOLD_AFTER_MS, Transcript, type Entry, type Step } from "../src/tui/transcript.js";
import { textWidth } from "../src/tui/width.js";

const text = (spans: { text: string }[]) => spans.map((span) => span.text).join("");
const KINDS: Activity[] = ["think", "search", "read", "look", "build", "change", "listen", "watch", "play", "record", "code"];

test("each kind of task has its own animation: a glyph a cell wide, and a scene as wide as asked, that moves", () => {
  assert.equal(activityOf("search_web"), "search");
  assert.equal(activityOf("read_web"), "read");
  assert.equal(activityOf("make_device"), "build");
  assert.equal(activityOf("live_discover"), "look");
  assert.equal(activityOf("set_mixer"), "change");
  assert.equal(activityOf("audition"), "listen");
  assert.equal(activityOf(undefined), "think");
  const scenes = new Set<string>();
  for (const kind of KINDS) {
    for (const ms of [0, 130, 777, 2_400, 9_999]) {
      assert.equal(textWidth(activityGlyph(kind, ms).text), 1, `${kind} glyph at ${ms}`);
      assert.match(activityGlyph(kind, ms, true).text, /^[\x20-\x7e]$/, `${kind}'s plain glyph is ASCII`);
    }
    const scene = (ms: number) => activityScene(kind, ms, 20);
    for (const ms of [0, 250, 500, 900, 1_300]) assert.equal(textWidth(text(scene(ms))), 20, `${kind} scene is 20 cells: “${text(scene(ms))}”`);
    // What moves may be the light on it rather than its characters (a page's words, read one by one).
    const frames = [0, 250, 500, 900, 1_300].map((ms) => scene(ms).map((span) => `${span.text}:${span.style.fg?.join()}`).join(""));
    assert.ok(new Set(frames).size > 1, `${kind}'s scene moves`);
    scenes.add(frames.join("|"));
  }
  assert.equal(scenes.size, KINDS.length, "no two kinds look the same");
});

test("a shimmer keeps the words and passes over them", () => {
  const early = shimmer("reading a page", 100); const later = shimmer("reading a page", 900);
  assert.equal(text(early), "reading a page");
  assert.notDeepEqual(early.map((span) => span.style.fg), later.map((span) => span.style.fg));
});

const step = (label: string, endedAt: number | undefined, extra: Partial<Step> = {}): Step =>
  ({ id: `${label}:${endedAt}`, label, state: "done", ms: 300, ...(endedAt !== undefined ? { endedAt } : {}), ...extra });
const lines = (transcript: Transcript, now: number) => transcript.rows(60, now).map((row) => text(row.spans).trimEnd());

test("the same step done several times in a row folds into one line a few seconds after the last, with how many and their time together", () => {
  const transcript = new Transcript();
  const steps = [step("searched the web", 900), step("read a page", 1_000), step("read a page", 1_100), step("read a page", 1_200), step("made a device", 1_300, { state: "error" }), step("made a device", 1_400)];
  transcript.add({ kind: "assistant", text: "", steps, status: "running", startedAt: 0 } satisfies Entry);
  const before = lines(transcript, 1_200 + FOLD_AFTER_MS - 1);
  assert.equal(before.filter((line) => line.includes("read a page")).length, 3, "listed each time at first");
  assert.equal(transcript.changeAt(1_300), 1_200 + FOLD_AFTER_MS, "a frame is asked for when the fold is due");
  // Under way: the extra lines fade, then go.
  const folding = 1_200 + FOLD_AFTER_MS + 100;
  assert.equal(transcript.changeAt(folding), folding, "each frame while it folds");
  const after = lines(transcript, folding + 1_000);
  assert.deepEqual(after.filter((line) => line.includes("read a page")), ["│ ✓ read a page ×3"]);
  assert.ok(transcript.rows(60, folding + 1_000).some((row) => row.trailing?.text === "0.9s"), "their time together");
  assert.equal(after.filter((line) => line.includes("made a device")).length, 2, "a failed one and the one that worked aren't the same step");
  assert.equal(transcript.changeAt(folding + 1_000), undefined, "nothing more to come");
  // One more, later: it folds into the same line in turn.
  steps.splice(4, 0, step("read a page", 10_000));
  transcript.touch(transcript.entries[0]!);
  assert.equal(lines(transcript, 10_500).filter((line) => line.includes("read a page")).length, 2);
  assert.deepEqual(lines(transcript, 10_000 + FOLD_AFTER_MS + 1_000).filter((line) => line.includes("read a page")), ["│ ✓ read a page ×4"]);
});

test("a step at work isn't folded, and steps brought back with a conversation fold at once", () => {
  const transcript = new Transcript();
  transcript.add({ kind: "assistant", text: "", status: "running", startedAt: 0,
    steps: [step("read a page", 100), step("read a page", undefined, { state: "running", tool: "read_web", startedAt: 200 })] });
  const rows = transcript.rows(60, 10_000);
  assert.equal(rows.filter((row) => row.live?.kind === "step").length, 1, "the page being read is its own line, moving");
  const resumed = new Transcript();
  resumed.add({ kind: "assistant", text: "Done.", status: "done", steps: [step("looked at your Set", undefined), step("looked at your Set", undefined), step("made changes", undefined)] });
  const shown = lines(resumed, 5);
  assert.ok(shown.includes("│ ✓ looked at your Set ×2") && shown.includes("│ ✓ made changes"), shown.join("\n"));
});
