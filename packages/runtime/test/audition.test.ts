import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MIX_CANDIDATE, type JsonObject } from "../src/core/contracts.js";
import { auditionRequest, renderSpan, restoreStore } from "../src/integrations/ableton/audition.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";
import { folder, noise, saw, silence, wav } from "./fixtures/synthetic-audio.js";

// What each source's Post FX renders: the bass a saw like the reference, the drums noise.
const reference = wav("reference.wav", saw(3, 110));
// As long as a real take: the lead-in (two bars), the part and its tail.
const renders = { "Fixture Bass": wav("bass-render.wav", saw(10, 110)), "Fixture Drums": wav("drums-render.wav", noise(10)), Resampling: wav("mix-render.wav", saw(10, 110)) } as Record<string, string>;
const quiet = wav("silent-render.wav", silence(10));
const RENDER = "1.0.49";
let files = 0;
const restoreFile = () => join(folder, `restore-${++files}.json`);

async function rig(options: { renders?: (source: string) => string | undefined; version?: string; restoreFile?: string; lateRecord?: number; noPlayOnRecord?: boolean } = {}) {
  const file = options.restoreFile ?? restoreFile();
  const b = await opened({ transport: true, version: options.version ?? RENDER, renders: options.renders ?? ((source) => renders[source]), restoreFile: file,
    ...(options.lateRecord ? { lateRecord: options.lateRecord } : {}), ...(options.noPlayOnRecord ? { noPlayOnRecord: true } : {}) });
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
    b.failNext("back-to-arrangement");
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
  // Whole bars of lead-in, at least 3 s of them: two at 120, three at 174 (a bar is 1.4 s), one at 60.
  assert.deepEqual(renderSpan(16, 4, 4, 120), { position: 8, preroll: 8, wait: 14 });
  assert.deepEqual(renderSpan(64, 4, 4, 174).position, 52);
  assert.deepEqual(renderSpan(64, 4, 4, 60).position, 60);
  assert.deepEqual(renderSpan(16, 4, 4, 120, true), { position: 4, preroll: 12, wait: 18 }, "twice the lead-in, after a late pass");
  assert.deepEqual(renderSpan(2, 4, 4, 120), { position: 0, preroll: 2, wait: 8 }, "a part near the start plays from the start");
});

/** The transport steps an audition took, in order: play actions, jumps, and recording on. */
const transportSteps = (b: { requests: { name: string; args: JsonObject }[] }) => b.requests.flatMap((request) =>
  request.name === "live_transport_action_preview" ? [String(request.args.action)] : request.name === "live_transport_preview" && typeof request.args.position === "number" ? [`jump ${request.args.position}`]
  : request.name === "live_recording_preview" && request.args.action === "start" ? ["record"] : []);

test("with room before the part, a pass plays, jumps to its lead-in while playing, then records (Live ignores a playhead moved while stopped)", async () => {
  const b = await rig();
  try {
    const result = await tool(b.tools, "audition").execute({ ...both, candidates: [both.candidates[0]!], from_beat: 32 }, signal());
    assert.equal(result.isError, false, result.text);
    assert.ok((JSON.parse(result.text) as { takes: { score: number }[] }).takes[0]!.score >= 90, result.text);
    const steps = transportSteps(b);
    assert.deepEqual(steps.slice(0, 4), ["back-to-arrangement", "continue", "jump 24", "record"], steps.join(" · "));
  } finally { await b.integration.close(); }
});

test("a part at the Set's start plays from there: stopped twice, recording on starts it (or start does, when Live doesn't)", async () => {
  for (const noPlayOnRecord of [false, true]) {
    const b = await rig({ noPlayOnRecord });
    try {
      const result = await tool(b.tools, "audition").execute({ ...both, candidates: [both.candidates[0]!], from_beat: 0 }, signal());
      assert.equal(result.isError, false, result.text);
      assert.ok((JSON.parse(result.text) as { takes: { score: number }[] }).takes[0]!.score >= 90, result.text);
      const steps = transportSteps(b);
      assert.deepEqual(steps.slice(0, 5), ["back-to-arrangement", "stop", "stop", "record", ...(noPlayOnRecord ? ["start"] : ["stop"])], steps.join(" · "));
      // The pass, to its stop (the playhead is put back after, while stopped).
      const pass = steps.slice(0, steps.indexOf("stop", steps.indexOf("record")) + 1);
      assert.ok(!pass.includes("continue") && !pass.some((item) => item.startsWith("jump")), `no jump: one while recording would end the take (${pass.join(" · ")})`);
    } finally { await b.integration.close(); }
  }
});

test("a pass whose recording started after the part goes again once, with twice the lead-in", async () => {
  const b = await rig({ lateRecord: 12 });
  try {
    const result = await tool(b.tools, "audition").execute({ ...both, candidates: [both.candidates[0]!], from_beat: 32 }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as { takes: { score: number }[]; notes?: string[] };
    assert.ok(reply.takes[0]!.score >= 90, result.text);
    assert.equal(reply.notes, undefined, "the second pass was in time");
    const steps = transportSteps(b);
    assert.deepEqual(steps.filter((item) => item === "record" || item.startsWith("jump")).slice(0, 4), ["jump 24", "record", "jump 20", "record"], steps.join(" · "));
  } finally { await b.integration.close(); }
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

test("the whole mix is a candidate: recorded quietly through Resampling, heard as a mix, and a goal points to audition rounds instead", async () => {
  assert.deepEqual(auditionRequest({ candidates: [{ mix: true }], from_beat: 16, beats: 8, reference: "~/ref.wav" }), { candidates: [{ track: MIX_CANDIDATE, mix: true }], fromBeat: 16, beats: 8, reference: "~/ref.wav", focus: "section" });
  assert.match(String(auditionRequest({ candidates: [{ mix: true, track: "track:1" }], from_beat: 0 })), /no track or clip/);
  assert.match(String(auditionRequest({ candidates: [{ mix: true }, { track: "track:1", clip: "clip:1" }], from_beat: 0 })), /renders from the Arrangement/);
  const b = await rig();
  try {
    const result = await tool(b.tools, "audition").execute({ candidates: [{ mix: true, label: "My mix" }], from_beat: 8, beats: 2, reference }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as { best: string; takes: { label: string; score: number }[] };
    assert.equal(reply.best, "My mix"); assert.ok(reply.takes[0]!.score >= 90, `the mix is the reference's sound (${reply.takes[0]!.score})`);
    // Its scratch track records Main's output (Resampling, before Main's fader), while Main stays silent.
    const routes = b.requests.filter((request) => request.name === "live_routing_preview" && request.args.inputType !== undefined);
    assert.deepEqual(routes.map((request) => [request.args.inputType, request.args.inputSubRouting ?? null]), [["Resampling", null]]);
    assert.deepEqual(b.requests.filter((request) => request.name === "live_mixer_preview" && request.args.trackRef === "7:main_track:0").map((request) => request.args.volume), [0, 0.85]);
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"], "the scratch track is gone");
    // A goal turns one track's knobs (with a safety limiter on its chain), never Main's.
    const goal = await b.integration.goal!({ candidates: [{ track: MIX_CANDIDATE, mix: true }], fromBeat: 8, beats: 2, reference }, signal());
    assert.match(String(goal), /For the whole mix, audition it against the reference/);
  } finally { await b.integration.close(); }
});
