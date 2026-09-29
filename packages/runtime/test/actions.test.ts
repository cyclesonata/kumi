import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { atLeast, FIXED_BRIDGE } from "../src/integrations/ableton/bridge-version.js";
import { ACTIONS } from "../src/integrations/ableton/actions.js";
import { CHANGES } from "../src/integrations/ableton/changes.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

test("bridge versions compare by their numbers, and an unknown one isn't held against the bridge", () => {
  assert.equal(atLeast("1.0.34", "1.0.34"), true);
  assert.equal(atLeast("1.0.35", "1.0.34"), true);
  assert.equal(atLeast("1.1.0", "1.0.34"), true);
  assert.equal(atLeast("1.0.33", "1.0.34"), false);
  assert.equal(atLeast("1.0.9", "1.0.34"), false, "numbers, not text");
  assert.equal(atLeast("1.0.34-beta.1", "1.0.34"), true);
  assert.equal(atLeast(undefined, "1.0.34"), true);
});

test("tools that need a newer bridge aren't offered by an older one, and a plan that names one says what to do", async () => {
  const old = await opened({ transport: true, version: "1.0.33" });
  try {
    const names = old.tools.map((item) => item.name);
    for (const name of ["play", "record"]) assert(!names.includes(name), `${name} needs ${FIXED_BRIDGE}`);
    const plan = await tool(old.tools, "make_changes").execute({ steps: [{ tool: "play", input: { action: "start" } }] }, signal());
    assert.equal(plan.isError, true);
    assert.match(plan.text, /1\.0\.34 or later; this one is 1\.0\.33/);
    assert(!old.requests.some((request) => request.name === "live_transport_action_preview"), "nothing reached Live");
  } finally { await old.integration.close(); }
  const fixed = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const names = fixed.tools.map((item) => item.name);
    for (const name of ["play", "record"]) assert(names.includes(name), `${name} is offered by ${FIXED_BRIDGE}`);
    const schema = tool(fixed.tools, "make_changes").inputSchema as { properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } };
    assert(schema.properties.steps.items.properties.tool.enum.includes("play"), "and a plan may use it");
  } finally { await fixed.integration.close(); }
  // Every gated tool names a release the gate understands.
  for (const kind of [...CHANGES, ...ACTIONS]) if (kind.since) assert.match(kind.since, /^\d+\.\d+\.\d+$/, kind.tool);
});

test("playing and stopping are actions: no HISTORY entry, and NOW hears of them", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const started = await tool(b.tools, "play").execute({ action: "start" }, signal());
    assert.equal(started.isError, false, started.text);
    assert.equal(JSON.parse(started.text).done, "Playing from the start marker");
    assert.equal(b.transport.playing, true);
    const stopped = await tool(b.tools, "play").execute({ action: "stop" }, signal());
    assert.equal(JSON.parse(stopped.text).done, "Stopped");
    assert.equal(b.transport.playing, false);
    assert.equal(b.records.length, 0, "nothing to undo, so nothing in HISTORY");
    assert.equal(b.transport.emergencyStops, 0, "the ordinary stop did it");
  } finally { await b.integration.close(); }
});

test("stopping always works: when Live refuses the ordinary stop, Kumi stops clips, the transport and recording together", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    await tool(b.tools, "play").execute({ action: "start" }, signal());
    b.transport.refuseStop = true;
    const stopped = await tool(b.tools, "play").execute({ action: "stop" }, signal());
    assert.equal(stopped.isError, false, stopped.text);
    const reply = JSON.parse(stopped.text) as JsonObject;
    assert.equal(reply.done, "Stopped");
    assert.match(String(reply.note), /stopped clips, the transport and recording/);
    assert.equal(b.transport.playing, false);
    const emergency = b.requests.find((request) => request.name === "live_session_emergency_stop")!;
    assert.equal(emergency.args.confirmation, "emergency-stop");
    assert.equal(emergency.args.expectedRecording, "stopped");
    assert.deepEqual(emergency.args.expectedTargets, ["7:track:0|7:clip_slot:0:0|7:scene:0"], "the bridge is told exactly what's playing");
  } finally { await b.integration.close(); }
});

test("a plan that recorded and then failed doesn't leave Live recording or playing", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "record", input: { action: "start", lane: "arrangement" } },
      { tool: "play", input: { action: "continue" } },
      { tool: "wait", input: { seconds: 0.01 } },
      { tool: "set_mixer", input: { trackRef: "3:track:9", volume: 0.5 } },
      { tool: "play", input: { action: "stop" } },
    ] }, signal());
    assert.equal(plan.isError, true);
    const reply = JSON.parse(plan.text) as { done: JsonObject[]; stopped: JsonObject; skipped: number };
    assert.equal(reply.done.length, 3, "recording, playing and the wait happened");
    assert.equal(reply.stopped.step, 4);
    assert.match(String(reply.stopped.error), /Kumi stopped the recording and playback, since the plan didn't finish/);
    assert.equal(reply.skipped, 1);
    assert.deepEqual([b.transport.playing, b.transport.arrangementRecord], [false, false]);
    assert.equal(b.transport.emergencyStops, 1);
    assert.equal(b.requests.find((request) => request.name === "live_session_emergency_stop")!.args.expectedRecording, "arrangement");
  } finally { await b.integration.close(); }
});

test("a plan that finishes with Live playing leaves it playing, and one that never started anything stops nothing", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 128 } }, { tool: "play", input: { action: "start" } }] }, signal());
    assert.equal(plan.isError, false, plan.text);
    assert.equal(b.transport.playing, true, "the producer asked to hear it");
    await tool(b.tools, "play").execute({ action: "stop" }, signal());
    const failing = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 126 } }, { tool: "set_mixer", input: { trackRef: "3:track:9", volume: 0.5 } }] }, signal());
    assert.equal(failing.isError, true);
    assert.doesNotMatch(failing.text, /Kumi stopped/);
    assert.equal(b.transport.emergencyStops, 0);
  } finally { await b.integration.close(); }
});

test("listen can name an audio clip in the Set by its clipRef: Kumi finds the file it plays", async () => {
  const b = await opened({ audioClip: "/Music/Bounces/Reese 0001.aif" });
  try {
    const slots = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "clip-slot", parent: "track:1" }, signal())).text) as { live?: { items: JsonObject[] }; items?: JsonObject[] };
    const clipRef = String((slots.live?.items ?? slots.items ?? []).find((slot) => slot.clipRef)?.clipRef);
    assert.match(clipRef, /^clip:\d+$/, "the model sees a short ref");
    assert.equal(await b.integration.audioFile!(clipRef, signal()), "/Music/Bounces/Reese 0001.aif");
    const read = b.requests.filter((request) => request.name === "live_discover").at(-1)!;
    assert.deepEqual([read.args.kind, read.args.parent], ["session-clip", "7:clip_slot:0:0"], "a Session clip is found under its slot");
    assert.equal(await b.integration.audioFile!("~/Music/reference.wav", signal()), undefined, "a path is left to the listen tool");
    await assert.rejects(b.integration.audioFile!("clip:99", signal()), /this turn's discovery/);
    const arrangement = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "arrangement-clip", parent: "track:2" }, signal())).text) as { live?: { items: JsonObject[] }; items?: JsonObject[] };
    const midi = String((arrangement.live?.items ?? arrangement.items ?? [])[0]?.ref);
    await assert.rejects(b.integration.audioFile!(midi, signal()), /MIDI clip, which has no sound of its own/);
  } finally { await b.integration.close(); }
});
