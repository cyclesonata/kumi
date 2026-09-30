import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { auditionRequest, renderSpan, restoreStore } from "../src/integrations/ableton/audition.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";
import { folder, noise, saw, silence, wav } from "./fixtures/synthetic-audio.js";

// What each source's Post FX renders: the bass a saw like the reference, the drums noise.
const reference = wav("reference.wav", saw(3, 110));
const renders = { "Fixture Bass": wav("bass-render.wav", saw(4, 110)), "Fixture Drums": wav("drums-render.wav", noise(4)) } as Record<string, string>;
const quiet = wav("silent-render.wav", silence(4));
const RENDER = "1.0.49";
let files = 0;
const restoreFile = () => join(folder, `restore-${++files}.json`);

async function rig(options: { renders?: (source: string) => string | undefined; version?: string; restoreFile?: string } = {}) {
  const file = options.restoreFile ?? restoreFile();
  const b = await opened({ transport: true, version: options.version ?? RENDER, renders: options.renders ?? ((source) => renders[source]), restoreFile: file });
  return Object.assign(b, { restoreFile: file });
}
const both = { candidates: [{ track: "track:1", label: "Saw" }, { track: "track:2", label: "Noise" }], from_beat: 8, beats: 2, reference, focus: "sound" };

test("an audition renders every candidate in one pass, quietly, scores each against the reference, and leaves the Set as it was", async () => {
  const b = await rig();
  try {
    // The producer left the drums armed: disarmed for the render (Live records exactly the armed tracks), armed again after.
    b.arm(1);
    const result = await tool(b.tools, "audition").execute(both, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as { round: number; best: string; takes: { label: string; score: number; gaps: string[] }[] };
    assert.equal(reply.round, 1);
    assert.equal(reply.best, "Saw");
    const [saw_, noise_] = reply.takes;
    assert.ok(saw_!.score >= 90, `the saw is the reference's sound (${saw_!.score})`);
    assert.ok(noise_!.score < 50, `noise isn't (${noise_!.score})`);
    // One recording, both scratch tracks armed; Main silenced for it and put back exactly.
    const starts = b.requests.filter((request) => request.name === "live_recording_preview" && request.args.action === "start");
    assert.equal(starts.length, 1);
    assert.equal((starts[0]!.args.alsoTrackRefs as string[]).length, 1);
    const mains = b.requests.filter((request) => request.name === "live_mixer_preview" && request.args.trackRef === "7:main_track:0").map((request) => request.args.volume);
    assert.deepEqual(mains, [0, 0.85], "Main to -inf, then back where it was");
    assert.equal(b.main.volume, 0.85);
    // The scratch tracks are gone, though they recorded.
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"]);
    assert.deepEqual(b.armed(), [1], "the drums are armed again");
    assert.ok(b.requests.some((request) => request.name === "live_undo" && request.args.discard === true));
    // HISTORY has one quiet line for all of it; NOW said it once.
    assert.equal(b.records[0]!.score, saw_!.score);
    assert.deepEqual(b.records.map((record) => [record.state, record.title]), [["heard", "Auditioned 2 candidates · best Saw"]]);
    assert.match(b.actions[0]!.title, /^Listening to my version quietly \(about \d+ s a round\)$/);
    assert.equal(b.actions[0]!.playing, true, "a technique drafted meanwhile counts as heard");
    assert.equal(existsSync(b.restoreFile), false, "Main is back, so there's nothing to restore after a crash");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(b.released.length >= 2, "the render's own steps (Main down and back) gave up their undo in the bridge");
    assert.deepEqual(b.auditions.map((event) => [event.round, event.best?.label, event.takes.length]), [[1, "Saw", 2]]);
    // A second round says the score before it.
    const again = JSON.parse((await tool(b.tools, "audition").execute({ ...both, candidates: [both.candidates[1]!] }, signal())).text) as { round: number };
    assert.equal(again.round, 2);
    assert.equal(b.auditions[1]!.previous, saw_!.score);
    assert.match(b.actions.at(-2)?.title ?? "", /^Round 2: listening quietly/);
  } finally { await b.integration.close(); }
});

test("whatever stops an audition, Main comes back and the scratch tracks go: a step Live refuses, a cancel", async () => {
  const b = await rig();
  try {
    b.failNext("continue");
    const failed = await tool(b.tools, "audition").execute(both, signal());
    assert.equal(b.main.volume, 0.85, "Main back after the refusal");
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"]);
    assert.equal(existsSync(b.restoreFile), false);
    assert.match(failed.text, /play: /, "it says what failed");
    assert.equal(b.records.filter((record) => record.state !== "heard").length, 0, "no stray HISTORY lines");
    // Cancelled while it records.
    const controller = new AbortController();
    const running = tool(b.tools, "audition").execute(both, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 800));
    controller.abort();
    const cancelled = await running;
    assert.match(cancelled.text, /Stopped before it finished/);
    assert.equal(b.main.volume, 0.85, "Main back after a cancel");
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"]);
    assert.equal(b.transport.playing, false); assert.equal(b.transport.arrangementRecord, false);
  } finally { await b.integration.close(); }
});

test("a silent render is said as such, and never compared", async () => {
  const b = await rig({ renders: () => quiet });
  try {
    const result = await tool(b.tools, "audition").execute({ ...both, candidates: [both.candidates[0]!] }, signal());
    assert.equal(result.isError, true);
    const reply = JSON.parse(result.text) as { takes: JsonObject[]; notes: string[] };
    assert.equal(reply.takes[0]!.silent, true);
    assert.equal(reply.takes[0]!.score, undefined);
    assert.match(reply.notes.join(" "), /The render was silent: is the source playing in the Arrangement/);
    assert.equal(b.records[0]!.title, "Auditioned: the render was silent");
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"], "a single scratch track goes too");
  } finally { await b.integration.close(); }
});

test("after a crash mid-render, the next start with that Set open puts Main back and says so", async () => {
  const file = restoreFile();
  // What an audition wrote before silencing Main, and the Set as the crash left it.
  restoreStore(file).save({ set: JSON.stringify(["7:set:song", "song"]), volume: 0.85, at: Date.now(), scratch: ["Kumi · render 1 ab12"] });
  const b = await rig({ restoreFile: file });
  try {
    // opened() observed once; the fixture's Main started at 0.85, so silence it as the crash left it and look again.
    b.main.volume = 0;
    restoreStore(file).save({ set: JSON.stringify(["7:set:song", "song"]), volume: 0.85, at: Date.now(), scratch: ["Kumi · render 1 ab12"] });
    const observation = await b.integration.observe(signal());
    assert.equal(b.main.volume, 0.85);
    assert.match(String((JSON.parse(observation.context) as JsonObject).restoredAfterCrash), /put Main back to 0\.0 dB\. Delete its render tracks if they're still there: Kumi · render 1 ab12/);
    assert.equal(existsSync(file), false);
    assert.equal(b.records.length, 0, "putting it back isn't a change in HISTORY");
    assert.match(b.actions.at(-1)!.title, /last render was cut off/);
    // Another Set's leftover isn't this one's to touch.
    writeFileSync(file, JSON.stringify({ set: "another", volume: 0.5, at: 1 }));
    await b.integration.observe(signal());
    assert.equal(b.main.volume, 0.85); assert.ok(readFileSync(file, "utf8").includes("another"));
  } finally { await b.integration.close(); }
});

test("an older bridge doesn't offer auditions; the request is checked before anything happens", async () => {
  const old = await rig({ version: "1.0.48" });
  try { assert.ok(!old.tools.some((item) => item.name === "audition")); } finally { await old.integration.close(); }
  assert.equal(auditionRequest({ candidates: [] }), "Give 1 to 8 candidates.");
  assert.match(String(auditionRequest({ candidates: [{ track: "track:1" }] })), /Say where the part is/);
  assert.match(String(auditionRequest({ candidates: [{ track: "track:1" }, { track: "track:1" }], from_beat: 0 })), /track of its own/);
  assert.deepEqual(renderSpan(8, 4, 4), { position: 4, preroll: 4, wait: 10 });
  assert.deepEqual(renderSpan(2, 4, 4), { position: 0, preroll: 2, wait: 8 }, "no pre-roll before the start");
});

test("a rig that fails partway through setting up undoes what it made before saying so", async () => {
  const b = await rig();
  try {
    // A scratch track's routing is refused, after the scratch tracks were made.
    b.failNext("live_routing_apply");
    const result = await tool(b.tools, "audition").execute(both, signal());
    assert.equal(result.isError, true, result.text);
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"], "no scratch track left");
    assert.equal(b.main.volume, 0.85);
  } finally { await b.integration.close(); }
});
