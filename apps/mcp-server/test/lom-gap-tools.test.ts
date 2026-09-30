import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, SAMPLE_FIELDS } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

// The Remote Script's LOM-gap operations (batch 2) as tools: text saved in the Set, note selection and
// range deletion, automation steps and values, launch buttons, jumps, device settings and edits
// (Roar and friends, Simpler's sample and slices, Wavetable), and reads only some devices answer.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const safety = { safe: true, provenance: "operator-confirmed-headphones", scope: "master" };

type Body = Record<string, any>;
function hosted(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const raw = async (name: string, args: unknown) => await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number; message: string } };
  const call = async (name: string, args: unknown): Promise<Body & { isError?: boolean }> => { const answer = await raw(name, args); assert.ok(answer.result, JSON.stringify(answer.error)); return { ...JSON.parse(answer.result.content[0]!.text), ...(answer.result.isError ? { isError: true } : {}) }; };
  let keys = 0;
  const apply = async (tool: string, transactionId: string) => await call(tool, { transactionId, confirmation: "apply", idempotencyKey: `lom-gap-${++keys}` });
  const change = async (preview: string, args: unknown): Promise<{ previewed: Body; applied: Body }> => {
    const previewed = await call(preview, args); assert.ok(previewed.transactionId, JSON.stringify(previewed));
    const applied = await apply(preview.replace(/_preview$/, "_apply"), previewed.transactionId); assert.equal(applied.state, "applied", JSON.stringify(applied));
    return { previewed, applied };
  };
  const undo = async (transactionId: string) => await call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: `lom-gap-undo-${++keys}` });
  const tools = () => (host.handle({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  return { host, raw, call, apply, change, undo, tools };
}
function state(simulator: DeterministicLiveSimulator) { return (simulator as unknown as { state: { tracks: Array<Record<string, any>>; scenes: Array<Record<string, any>> } }).state; }
function device(simulator: DeterministicLiveSimulator, row: Record<string, unknown>) { const made = { parentRef: "track:track-1", kind: "audio-effect", parameters: [], enabled: true, objectIdentity: `simulator:${String(row.ref)}`, ...row }; state(simulator).tracks[0]!.devices.push(made); return made as Record<string, any>; }

test("every batch-2 tool is listed while Live answers its operations", () => {
  const listed = hosted(new DeterministicLiveSimulator()).tools();
  for (const name of ["live_data_read", "live_data_preview", "live_data_apply", "live_automation_read", "live_device_read", "live_clip_time_convert", "live_message", "live_browser_preview", "live_browser_preview_stop", "live_fire_button_preview", "live_fire_button_apply", "live_device_edit_preview", "live_device_edit_apply"]) assert.ok(listed.includes(name), name);
});

test("text saved in the Set: read, saved under a kumi. key, fenced on what was there, and put back by undo", async () => {
  const simulator = new DeterministicLiveSimulator(); const { raw, call, change, apply, undo } = hosted(simulator);
  assert.deepEqual(await call("live_data_read", { key: "kumi.notes" }), { ref: "set:set-1", key: "kumi.notes", value: null });
  assert.equal((await raw("live_data_preview", { key: "other.surface", value: "x" })).error?.code, -32602);
  const { previewed, applied } = await change("live_data_preview", { key: "kumi.notes", value: "Drop at bar 33" });
  assert.equal(previewed.prior, null); assert.equal(applied.value, "Drop at bar 33");
  assert.equal((await call("live_data_read", { key: "kumi.notes" })).value, "Drop at bar 33");
  const onTrack = await change("live_data_preview", { key: "kumi.role", value: "lead", trackRef: "track:track-1" });
  assert.equal((await call("live_data_read", { key: "kumi.role", trackRef: "track:track-1" })).value, "lead");
  // Changed between the preview and the apply: the Remote Script refuses, nothing is saved.
  const stale = await call("live_data_preview", { key: "kumi.notes", value: "Breakdown" });
  await change("live_data_preview", { key: "kumi.notes", value: "Intro" });
  const refused = await apply("live_data_apply", stale.transactionId);
  assert.equal(refused.isError, true); assert.match(refused.reason, /changed since it was read/);
  assert.equal((await undo(onTrack.previewed.transactionId)).state, "undone");
  assert.equal((await call("live_data_read", { key: "kumi.role", trackRef: "track:track-1" })).value, null);
  // Undo refuses once the key holds something else than the change saved.
  assert.equal((await undo(previewed.transactionId)).isError, true);
});

test("notes are selected as a click selects them (nothing to undo), and a region's notes deleted and put back", async () => {
  const simulator = new DeterministicLiveSimulator(); const { raw, call, change, undo } = hosted(simulator);
  const clip = state(simulator).tracks[0]!.clips[0]!;
  clip.notes.push({ pitch: 38, start: 1, duration: 0.25, velocity: 100, channel: 1, id: 2, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 }, { pitch: 60, start: 1.5, duration: 0.5, velocity: 90, channel: 1, id: 3, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 });
  clip.notesRevision = "a".repeat(64);
  assert.equal((await raw("live_note_edit_preview", { clipRef: "clip:clip-1", action: "select", all: true, none: true })).error?.code, -32602);
  const selected = await change("live_note_edit_preview", { clipRef: "clip:clip-1", action: "select", noteIds: [1, 3] });
  assert.equal(selected.previewed.notes, 2); assert.deepEqual(simulator.selectedNotes.get("clip:clip-1"), [1, 3]);
  assert.equal((await change("live_note_edit_preview", { clipRef: "clip:clip-1", action: "select", all: true })).previewed.notes, 3);
  const nothing = await undo(selected.previewed.transactionId); assert.equal(nothing.isError, true); assert.match(nothing.reason, /nothing to undo/);
  const before = structuredClone(clip.notes);
  const deleted = await change("live_note_edit_preview", { clipRef: "clip:clip-1", action: "delete-range", fromPitch: 36, pitchSpan: 3, fromTime: 0, timeSpan: 2 });
  assert.equal(deleted.previewed.notes, 2); assert.equal(deleted.applied.result.deleted, 2);
  assert.deepEqual(clip.notes.map((note: { pitch: number }) => note.pitch), [60]);
  assert.equal((await undo(deleted.previewed.transactionId)).state, "undone");
  const content = (notes: Array<Record<string, unknown>>) => notes.map(({ id: _id, ...note }) => note).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(content(clip.notes), content(before));
  assert.equal((await raw("live_note_edit_preview", { clipRef: "clip:clip-1", action: "delete-range", fromPitch: 36, pitchSpan: 0, fromTime: 0, timeSpan: 1 })).error?.code, -32602);
});

test("an automation step is drawn and taken away, on an envelope that was there and on one it made; the envelope's value is read at a time", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, change, undo } = hosted(simulator);
  const volume = "parameter:mixer:0:volume"; const clip = state(simulator).tracks[0]!.clips[0]!;
  const made = await change("live_automation_preview", { action: "insert-step", clipRef: "clip:clip-1", parameterRef: volume, start: 0.5, length: 1, value: 0.25 });
  assert.equal(made.applied.result.inserted, 1);
  const read = await call("live_automation_read", { clipRef: "clip:clip-1", parameterRef: volume, time: 1 });
  assert.equal(read.exists, true); assert.equal(read.value, 0.25); assert.equal(read.points.length, 2);
  assert.equal((await undo(made.previewed.transactionId)).state, "undone");
  assert.equal(clip.envelopes?.[volume], undefined);
  const gone = await call("live_automation_read", { clipRef: "clip:clip-1", parameterRef: volume, time: 1 });
  assert.deepEqual([gone.exists, gone.points, gone.value], [false, [], null]);
  clip.envelopes = { [volume]: [{ time: 0, value: 0.9 }, { time: 3, value: 0.7 }] };
  const step = await change("live_automation_preview", { action: "insert-step", clipRef: "clip:clip-1", parameterRef: volume, start: 1, length: 1, value: 0.1 });
  assert.equal(step.applied.state, "applied");
  assert.equal((await undo(step.previewed.transactionId)).state, "undone");
  assert.deepEqual(clip.envelopes[volume], [{ time: 0, value: 0.9 }, { time: 3, value: 0.7 }]);
});

test("the song jumps by beats, and a track jumps in the clip playing there (Live refuses when nothing plays)", async () => {
  const simulator = new DeterministicLiveSimulator(); const { raw, call, change, apply } = hosted(simulator);
  assert.equal((await raw("live_transport_action_preview", { action: "jump-by" })).error?.code, -32602);
  assert.equal((await raw("live_transport_action_preview", { action: "start", beats: 4 })).error?.code, -32602);
  const jumped = await change("live_transport_action_preview", { action: "jump-by", beats: -4 });
  assert.equal(jumped.previewed.impact, "audible-transport-action-no-undo");
  const idle = await call("live_transport_action_preview", { action: "jump-in-running-clip", trackRef: "track:track-1", beats: 2 });
  assert.equal(idle.playing, false);
  const refused = await apply("live_transport_action_apply", idle.transactionId);
  assert.equal(refused.isError, true); assert.match(refused.reason, /no Session clip is playing/);
  state(simulator).tracks[0]!.playingSlotIndex = 0;
  assert.equal((await change("live_transport_action_preview", { action: "jump-in-running-clip", trackRef: "track:track-1", beats: 2 })).previewed.playing, true);
});

test("a launch button is pressed and let go with output-safety evidence; live_change won't fuse it and there's nothing to undo", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, change, undo } = hosted(simulator);
  const unsafe = await call("live_fire_button_preview", { ref: "clip-slot:track-1:0", pressed: true, outputSafety: { safe: true, provenance: "unknown" } });
  assert.equal(unsafe.isError, true);
  const pressed = await change("live_fire_button_preview", { ref: "clip-slot:track-1:0", pressed: true, outputSafety: safety });
  assert.equal(pressed.previewed.target.kind, "clip-slot"); assert.match(pressed.applied.held, /30 s/);
  assert.ok(simulator.heldFireButtons.has("clip-slot:track-1:0"));
  await change("live_fire_button_preview", { ref: "clip-slot:track-1:0", pressed: false, outputSafety: safety });
  assert.equal(simulator.heldFireButtons.size, 0);
  assert.equal((await change("live_fire_button_preview", { ref: "scene:scene-1", pressed: true, outputSafety: safety })).previewed.target.kind, "scene");
  assert.equal((await call("live_fire_button_preview", { ref: "track:track-1", pressed: true, outputSafety: safety })).isError, true);
  const fused = await call("live_change", { tool: "live_fire_button_preview", args: { ref: "scene:scene-1", pressed: false, outputSafety: safety } });
  assert.equal(fused.isError, true); assert.match(fused.reason, /out loud/);
  assert.match((await undo(pressed.previewed.transactionId)).reason, /nothing to undo/);
});

test("a Simpler's sample settings and Wavetable's are changed and undone, each fenced on all its family's settings", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, change, undo } = hosted(simulator);
  const sample: Record<string, any> = { filePath: "/samples/break.wav", length: 88200, sampleRate: 44100, warping: true, warpMode: 0, ...Object.fromEntries(SAMPLE_FIELDS.map((field, index) => [field, index])), slices: [0, 22050] };
  device(simulator, { ref: "device:simpler-1", name: "Simpler", kind: "instrument", className: "OriginalSimpler", simpler: { playbackMode: 0, voices: 4 }, sample });
  device(simulator, { ref: "device:wavetable-1", name: "Wavetable", kind: "instrument", className: "InstrumentVector", wavetable: { oscillator1WavetableCategory: 0, oscillator1WavetableIndex: 3, oscillator2WavetableCategory: 1, oscillator2WavetableIndex: 0, oscillator1EffectMode: 0, oscillator2EffectMode: 0, filterRouting: 0, unisonMode: 0, unisonVoiceCount: 2, visibleModulationTargetNames: ["Osc 1 Pos"] } });
  const warped = await change("live_device_specialized_preview", { family: "sample", deviceRef: "device:simpler-1", complexProFormants: 80, slicingRegionCount: 16 });
  assert.deepEqual(warped.previewed.prior, { complexProFormants: 4, slicingRegionCount: 10 });
  assert.deepEqual([sample.complexProFormants, sample.slicingRegionCount], [80, 16]);
  assert.equal((await undo(warped.previewed.transactionId)).state, "undone");
  assert.deepEqual([sample.complexProFormants, sample.slicingRegionCount], [4, 10]);
  const table = await change("live_device_specialized_preview", { family: "wavetable", deviceRef: "device:wavetable-1", oscillator1WavetableCategory: 2, oscillator1WavetableIndex: 5, unisonMode: 3 });
  assert.equal((await undo(table.previewed.transactionId)).state, "undone");
  assert.equal((await call("live_device_specialized_preview", { family: "wavetable", deviceRef: "device:simpler-1", unisonMode: 1 })).isError, true);
  assert.equal((await call("live_device_specialized_preview", { family: "sample", deviceRef: "device:utility-1", textureFlux: 1 })).isError, true);
});

test("a device's settings by name, Wavetable's modulation, a Simpler's slices and warping, and CC Control's resend, with undo where Kumi can", async () => {
  const simulator = new DeterministicLiveSimulator(); const { raw, call, change, undo } = hosted(simulator);
  const roar = device(simulator, { ref: "device:roar-1", name: "Roar", className: "Roar", roar: { routingModeIndex: 0, routingModeList: ["Single", "Serial", "Parallel"], envListen: false } });
  const sample = { filePath: "/samples/break.wav", warping: false, slices: [0, 22050], detectedSlices: [0, 11025, 22050] };
  device(simulator, { ref: "device:simpler-1", name: "Simpler", kind: "instrument", className: "OriginalSimpler", simpler: { playbackMode: 2 }, sample });
  const wavetable = device(simulator, { ref: "device:wavetable-1", name: "Wavetable", kind: "instrument", className: "InstrumentVector", parameters: [{ ref: "parameter:wt-osc2-gain", objectIdentity: "simulator:parameter:wt-osc2-gain", name: "Osc 2 Gain", value: 0.5, min: 0, max: 1, automatable: true }], wavetable: { visibleModulationTargetNames: ["Osc 1 Pos", "Filter 1 Freq"] } });
  device(simulator, { ref: "device:cc-1", name: "CC Control", kind: "midi-effect", className: "CcControl", ccControl: { customBoolTarget: 0, customBoolTargetList: ["None", "CC 64"] } });
  // A setting by its name; a choice is an index, and the preview lists them.
  assert.equal((await raw("live_device_edit_preview", { deviceRef: "device:roar-1", action: "set", setting: "roar.routing_mode_index", value: 3 })).error?.code, -32602);
  assert.equal((await raw("live_device_edit_preview", { deviceRef: "device:roar-1", action: "set", setting: "roar.routing_mode_index", value: 1, source: 2 })).error?.code, -32602);
  const routed = await change("live_device_edit_preview", { deviceRef: "device:roar-1", action: "set", setting: "roar.routing_mode_index", value: 2 });
  assert.deepEqual(routed.previewed.prior, { setting: "roar.routing_mode_index", value: 0, choices: ["Single", "Serial", "Parallel"] }); assert.equal(roar.roar.routingModeIndex, 2);
  await change("live_device_edit_preview", { deviceRef: "device:roar-1", action: "set", setting: "roar.env_listen", value: true });
  assert.equal((await undo(routed.previewed.transactionId)).state, "undone"); assert.equal(roar.roar.routingModeIndex, 0);
  assert.equal((await call("live_device_edit_preview", { deviceRef: "device:roar-1", action: "set", setting: "shifter.pitch_mode_index", value: 1 })).isError, true);
  // Wavetable's matrix: by index, and by a parameter it adds; undo puts the amount back.
  const amount = await change("live_device_edit_preview", { deviceRef: "device:wavetable-1", action: "modulate", targetIndex: 1, source: 2, value: 0.5 });
  assert.deepEqual([amount.applied.result.prior, amount.applied.result.value], [0, 0.5]);
  const added = await change("live_device_edit_preview", { deviceRef: "device:wavetable-1", action: "modulate", parameterRef: "parameter:wt-osc2-gain", source: 1, value: -0.25 });
  assert.equal(added.applied.result.targetIndex, 2); assert.deepEqual(wavetable.wavetable.visibleModulationTargetNames, ["Osc 1 Pos", "Filter 1 Freq", "Osc 2 Gain"]);
  assert.equal((await undo(amount.previewed.transactionId)).state, "undone");
  // Slices: one at a time comes back; clearing is Live's undo's.
  const inserted = await change("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "slice-insert", time: 11025 });
  assert.deepEqual(sample.slices, [0, 11025, 22050]);
  const moved = await change("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "slice-move", time: 11025, toTime: 15000 });
  assert.equal((await undo(moved.previewed.transactionId)).state, "undone"); assert.deepEqual(sample.slices, [0, 11025, 22050]);
  assert.equal((await undo(inserted.previewed.transactionId)).state, "undone"); assert.deepEqual(sample.slices, [0, 22050]);
  assert.equal((await call("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "slice-remove", time: 5 })).isError, true);
  const removed = await change("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "slice-remove", time: 22050 });
  assert.equal((await undo(removed.previewed.transactionId)).state, "undone"); assert.deepEqual(sample.slices, [0, 22050]);
  const reset = await change("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "slice-reset" });
  assert.match(reset.previewed.undo, /Live's undo can/); assert.deepEqual(sample.slices, [0, 11025, 22050]);
  assert.match((await undo(reset.previewed.transactionId)).reason, /Live's undo can/);
  // Warping and resending: kept.
  assert.equal((await raw("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "warp-as" })).error?.code, -32602);
  await change("live_device_edit_preview", { deviceRef: "device:simpler-1", action: "warp-as", beats: 8 }); assert.equal(sample.warping, true);
  assert.equal((await call("live_device_edit_preview", { deviceRef: "device:roar-1", action: "warp-double" })).isError, true);
  const resent = await change("live_device_edit_preview", { deviceRef: "device:cc-1", action: "resend" });
  assert.match((await undo(resent.previewed.transactionId)).reason, /nothing to undo/);
});

test("reads only some devices answer, a clip's time in its sample, a message in Live, and a browser preview started and stopped", async () => {
  const simulator = new DeterministicLiveSimulator(); const { raw, call } = hosted(simulator);
  device(simulator, { ref: "device:plugin-1", name: "Serum", kind: "plugin", parameterNames: ["Cutoff", "Res", "Drive", "Mix"] });
  device(simulator, { ref: "device:m4l-1", name: "LFO", kind: "audio-effect", banks: [{ name: "Main", parameters: [0, 1, -1] }] });
  assert.deepEqual(await call("live_device_read", { deviceRef: "device:plugin-1", what: "parameter-names" }), { deviceRef: "device:plugin-1", names: ["Cutoff", "Res", "Drive", "Mix"], total: 4 });
  assert.deepEqual(await call("live_device_read", { deviceRef: "device:plugin-1", what: "parameter-names", begin: 1, end: 3 }), { deviceRef: "device:plugin-1", names: ["Res", "Drive"], total: null });
  assert.deepEqual((await call("live_device_read", { deviceRef: "device:m4l-1", what: "banks" })).banks, [{ name: "Main", parameters: [0, 1, -1] }]);
  assert.match((await call("live_device_read", { deviceRef: "device:utility-1", what: "banks" })).reason, /Max for Live/);
  assert.equal((await raw("live_device_read", { deviceRef: "device:m4l-1", what: "banks", begin: 1 })).error?.code, -32602);
  state(simulator).tracks[0]!.clips.push({ ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Loop", kind: "audio", start: 0, length: 4, notes: [], warp: true, takes: [], automation: [] });
  const converted = await call("live_clip_time_convert", { clipRef: "clip:audio-1", from: "beats", value: 2 });
  assert.deepEqual(converted, { clipRef: "clip:audio-1", beats: 2, samples: 44100, seconds: 1 });
  assert.match((await call("live_clip_time_convert", { clipRef: "clip:clip-1", from: "beats", value: 1 })).reason, /audio clip/);
  assert.deepEqual(await call("live_message", { text: "Bounced the drums to audio" }), { shown: true, modal: false });
  assert.deepEqual(simulator.shownMessages, [{ text: "Bounced the drums to audio", modal: false }]);
  const started = await call("live_browser_preview", { itemId: "drums/Kick Core" });
  assert.equal(started.item.name, "Kick Core"); assert.ok(started.previewId.length >= 32);
  const later = await call("live_browser_preview", { itemId: "drums/Kick Core" });
  assert.equal((await call("live_browser_preview_stop", { previewId: started.previewId })).isError, true);
  assert.deepEqual(await call("live_browser_preview_stop", { previewId: later.previewId }), { stopped: true });
});

test("over the Remote Script's wire, saved text is one mutate carrying the preview's state digest", async () => {
  const live = await serveSimulator();
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { change, call } = hosted(adapter);
    await change("live_data_preview", { key: "kumi.plan", value: "verse, chorus" });
    const mutations = live.requests.filter((request) => request.method === "mutate");
    assert.deepEqual(mutations.map((request) => request.operation), ["data.set"]);
    assert.match(mutations[0]!.stateDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal((await call("live_data_read", { key: "kumi.plan" })).value, "verse, chorus");
  } finally { await adapter.close(); await live.close(); }
});
