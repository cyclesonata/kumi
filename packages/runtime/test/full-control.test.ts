import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

const FULL = "1.0.58";

test("a plan is one Cmd-Z in Live: an undo step opens before its first change and closes after its last", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "set_tempo", input: { tempo: 126 } },
      { tool: "set_mixer", input: { trackRef: "track:1", volume: 0.6 } },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    const order = b.requests.map((request) => request.name).filter((name) => /^live_(undo_step_|tempo_|mixer_)/.test(name));
    assert.deepEqual(order, ["live_undo_step_begin", "live_tempo_preview", "live_tempo_apply", "live_mixer_preview", "live_mixer_apply", "live_undo_step_end"]);
    assert.equal(b.requests.find((request) => request.name === "live_undo_step_end")!.args.stepId, "undo-step-0", "it closes the step it opened");
    // HISTORY still undoes each change on its own.
    assert.deepEqual(b.records.map((record) => record.state), ["applied", "applied"]);
  } finally { await b.integration.close(); }
});

test("a plan that stops on a refused step still closes its undo step; an older bridge opens none", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "set_tempo", input: { tempo: 126 } },
      { tool: "set_mixer", input: { trackRef: "6:track:0", volume: 0.6 } },
    ] }, signal());
    assert.equal(result.isError, true);
    assert.equal(b.requests.filter((request) => request.name === "live_undo_step_end").length, 1);
  } finally { await b.integration.close(); }
  const old = await opened({ version: "1.0.57" });
  try {
    await tool(old.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 126 } }] }, signal());
    assert.equal(old.requests.some((request) => /^live_undo_step_/.test(request.name)), false);
  } finally { await old.integration.close(); }
});

test("deleting a track is asked for explicitly, and HISTORY keeps it: Live's own undo is the way back", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    const names = b.tools.map((item) => item.name);
    assert.ok(["delete_clip", "delete_track", "write_arrangement_clip", "clear_range", "render"].every((name) => names.includes(name)), names.join(", "));
    const result = await tool(b.tools, "delete_track").execute({ trackRef: "track:2" }, signal());
    assert.equal(result.isError, false, result.text);
    const record = b.records.at(-1)!;
    assert.equal(record.state, "kept"); assert.match(record.title, /^Deleted track “Fixture Drums”/);
    assert.match(record.note ?? "", /Live's own undo can/);
  } finally { await b.integration.close(); }
  const older = await opened({ fullControl: true, version: "1.0.57" });
  try {
    assert.equal(older.tools.some((item) => ["delete_track", "render"].includes(item.name)), false, "an older bridge doesn't get them");
  } finally { await older.integration.close(); }
});

test("render gives an audio track's own clips as a file for listen, without touching Live", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    const result = await tool(b.tools, "render").execute({ track: "track:1", from_beat: 8, beats: 16 }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as JsonObject;
    assert.match(String(reply.file), /kumi-fixture-render\.wav$/); assert.equal(reply.seconds, 8);
    const call = b.requests.find((request) => request.name === "live_render_offline")!;
    assert.deepEqual([call.args.trackRef, call.args.fromBeat, call.args.toBeat, call.args.expectedName], ["7:track:0", 8, 24, "Fixture Bass"]);
    assert.equal((await tool(b.tools, "render").execute({ track: "6:track:0", from_beat: 0, beats: 4 }, signal())).isError, true, "a reference from an old turn is refused");
  } finally { await b.integration.close(); }
});

test("right-click in Live pins what was pointed at: a track, a clip, a stretch of the Arrangement; 'this' then means it", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    b.liveEvent({ epoch: 1, sequence: 1, type: "pointed", channel: "extension", payload: { kind: "track", path: [1], name: "Fixture Drums", trail: ["Fixture Drums"], ref: "7:track:1" } });
    b.liveEvent({ epoch: 1, sequence: 2, type: "pointed", channel: "extension", payload: { kind: "arrangement_selection", lanes: [{ kind: "track", path: [0], name: "Fixture Bass", ref: "7:track:0" }], timeSelection: { fromBeat: 32, toBeat: 100 } } });
    b.liveEvent({ epoch: 1, sequence: 3, type: "pointed", channel: "extension", payload: { kind: "scene", path: [1], name: "", trail: [""], ref: "7:scene:1" } });
    assert.deepEqual(b.pins.map((pin) => pin.trail), [[], [], []], "a pin's trail is what holds it, not the thing itself");
    assert.deepEqual(b.pins.map((pin) => [pin.node, pin.ref, pin.name, pin.live, pin.time ?? null]), [
      ["track", "7:track:1", "Fixture Drums", true, null], ["selection", "7:track:0", "Fixture Bass", true, { fromBeat: 32, toBeat: 100 }], ["scene", "7:scene:1", "Scene 2", true, null]]);
    // The next message with that pin: the model gets it, usable as a reference in this turn.
    const next = await b.integration.observe(signal(), { pinned: b.pins[1]! });
    const pinned = (JSON.parse(next.context) as { pinned: JsonObject }).pinned;
    assert.equal(pinned.kind, "selection"); assert.equal(pinned.spans, "bar 9 to bar 26"); assert.match(String(pinned.note), /pointed at this in Live/);
    const stale = await b.integration.observe(signal(), { pinned: { ...b.pins[0]!, ref: "6:track:1", trackRef: "6:track:1" } });
    assert.match(String((JSON.parse(stale.context) as { pinned: JsonObject }).pinned.gone), /references changed since/);
    // Subscribed once, to the selection and the structure.
    assert.deepEqual(b.requests.filter((request) => request.name === "live_subscribe").map((request) => request.args.types), [["selection", "structure"]]);
  } finally { await b.integration.close(); }
});

test("a selection change in Live is read at once, not at the next poll", async () => {
  const focuses: unknown[] = [];
  const b = await opened({ fullControl: true, version: FULL, onFocus: (focus) => focuses.push(focus) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reads = () => b.requests.filter((request) => request.name === "live_discover" && request.args.kind === "selection").length;
    const before = reads();
    b.liveEvent({ epoch: 7, sequence: 1, type: "selection", channel: "remote-script", payload: { track: "7:track:1" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(reads() > before, "the selection was read again straight away (the poll here is a minute)");
  } finally { await b.integration.close(); }
});

test("an Esc while the plan's undo step is opening still closes it", async () => {
  const b = await opened({ fullControl: true, version: FULL });
  try {
    const controller = new AbortController();
    const held = b.hold("live_undo_step_begin");
    const plan = tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 126 } }] }, controller.signal);
    await held.sent; controller.abort(); held.release();
    await plan.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(b.requests.filter((request) => /^live_undo_step_/.test(request.name)).map((request) => request.name), ["live_undo_step_begin", "live_undo_step_end"]);
    assert.equal(b.requests.some((request) => request.name === "live_tempo_apply"), false, "the plan itself stopped");
  } finally { await b.integration.close(); }
});

test("a device's settings beyond its parameters, Live's own undo as a last resort, and a plug-in's every parameter name", async () => {
  const b = await opened({ fullControl: true, version: FULL, parameters: true });
  try {
    const set = await tool(b.tools, "edit_device").execute({ deviceRef: "device:1", action: "set", setting: "simpler.playback_mode", value: 2 }, signal());
    assert.equal(set.isError, false, set.text); assert.equal(b.records.at(-1)!.state, "applied");
    await tool(b.tools, "edit_device").execute({ deviceRef: "device:1", action: "warp-double" }, signal());
    assert.equal(b.records.at(-1)!.state, "kept", "doubling the warping has only Live's undo"); assert.match(b.records.at(-1)!.title, /warp double/);
    const undone = await tool(b.tools, "undo_in_live").execute({}, signal());
    assert.deepEqual(JSON.parse(undone.text), { done: true, canUndo: false, canRedo: true });
    assert.deepEqual(b.requests.find((request) => request.name === "live_song_undo")!.args.confirmation, "undo-in-live");
    assert.ok(b.tools.some((item) => item.name === "live_device_read"), "the model reads a plug-in's every parameter name itself");
  } finally { await b.integration.close(); }
});
