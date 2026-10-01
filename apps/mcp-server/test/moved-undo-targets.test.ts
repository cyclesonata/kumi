import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { READ_ONLY_INVOKES } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type AsyncLiveAdapter, type LiveInvocation } from "../src/live.js";

// An undo goes to the object its change was made on, or nowhere. A reference is a place: a track
// inserted above (or a device, clip, chain or groove added or removed before it) puts another object
// there, one that may even hold the values the change wrote. That undo is refused before anything is
// sent, the change stays applied, and once the object is back at its place the same undo goes.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
type Body = Record<string, any>;
type Row = Record<string, any>;

/** The simulator, counting every change sent to it (reads aside). */
function watched(simulator: DeterministicLiveSimulator) {
  const writes: string[] = [];
  const adapter = new Proxy(simulator, { get(target, property) {
    if (property === "invokeAsync") return async (invocation: LiveInvocation) => { if (!READ_ONLY_INVOKES.has(invocation.operation)) writes.push(invocation.operation); return target.invokeAsync(invocation); };
    const member = Reflect.get(target, property, target) as unknown;
    return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(target) : member;
  } }) as unknown as AsyncLiveAdapter;
  return { adapter, writes };
}

function hosted(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100; let keys = 0;
  const call = async (name: string, args: unknown): Promise<Body> => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any; assert.ok(answer.result, JSON.stringify(answer.error)); return { ...JSON.parse(answer.result.content[0].text), ...(answer.result.isError ? { isError: true } : {}) }; };
  const apply = (tool: string, previewed: Body) => call(tool, { transactionId: previewed.transactionId, confirmation: previewed.confirmation ?? "apply", idempotencyKey: `moved-target-apply-${++keys}` });
  const undo = (transactionId: string) => call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: `moved-target-undo-${++keys}` });
  return { call, apply, undo };
}

const state = (simulator: DeterministicLiveSimulator) => (simulator as unknown as { state: Row }).state;
const drums = (simulator: DeterministicLiveSimulator): Row => state(simulator).tracks[0];

/** Another object at the row's place: new identities for the given fields, the values left as they are. Gives back the way to put the first one back. */
function another(row: Row, fields: string[] = ["objectIdentity"]): () => void {
  const saved = fields.map((field) => row[field]);
  for (const field of fields) row[field] = Array.isArray(row[field]) ? (row[field] as string[]).map((identity) => `${identity}:another`) : `${String(row[field])}:another`;
  return () => fields.forEach((field, index) => { row[field] = saved[index]; });
}
const both = (...back: Array<() => void>) => () => back.forEach((put) => put());

function rack(simulator: DeterministicLiveSimulator): void {
  const device = drums(simulator).devices[0];
  device.kind = "rack"; device.canHaveChains = true; device.canHaveDrumPads = true;
  device.chains = [{ ref: "chain:rack-1:0", parentRef: "device:utility-1", objectIdentity: "simulator:chain:rack-1:0", index: 0, name: "Chain 1", mute: false, solo: false, devices: [], colorIndex: 5, autoColor: false, hasAudioInput: true, hasMidiOutput: false, mutedViaSolo: false, inNote: 36, outNote: 51, chokeGroup: 1, mixer: { volume: 1, pan: 0, sends: [0.5], volumeRef: "parameter:chain:0:volume", panningRef: "parameter:chain:0:panning", sendRefs: ["parameter:chain:0:sends:0"], chainActivatorRef: "parameter:chain:0:activator", mixerIdentity: "simulator:chain-mixer:0" } }];
  device.drumPads = [{ ref: "drum-pad:rack-1:0", parentRef: "device:utility-1", index: 0, name: "Pad 1", mute: false, chains: [], note: 36, solo: false, objectIdentity: "simulator:drum-pad:rack-1:0" }];
  device.deviceIo = { routingType: "Ext. In", routingChannel: "1" };
  device.macros = [{ ref: "parameter:macro-1", objectIdentity: "simulator:parameter:macro-1", name: "Macro 1", value: 0 }];
  device.macroMapped = [true]; device.visibleMacroCount = 8; device.variationCount = 2; device.selectedVariationIndex = 0;
  device.rackView = { padScrollPosition: 0, showChainDevices: true, selectedChainRef: null, selectedPadIndex: null };
}
const chain = (simulator: DeterministicLiveSimulator): Row => drums(simulator).devices[0].chains[0];

function devices(simulator: DeterministicLiveSimulator): void {
  drums(simulator).devices.push(
    { ref: "device:drift-1", parentRef: "track:track-1", name: "Drift", kind: "instrument", className: "DriftDevice", parameters: [], objectIdentity: "simulator:device:drift-1", enabled: true, drift: { pitchBendRange: 12, voiceCount: 2, voiceMode: 0, voiceCountList: ["1", "4", "8", "16"], voiceModeList: ["Poly", "Mono"] } },
    { ref: "device:looper-1", parentRef: "track:track-1", name: "Looper", kind: "audio-effect", className: "LooperDevice", parameters: [], objectIdentity: "simulator:device:looper-1", enabled: true, looper: { overdubAfterRecord: false, recordLengthIndex: 0, loopLength: 4, tempo: 120, state: 0 } },
    { ref: "device:simpler-1", parentRef: "track:track-1", name: "Simpler", kind: "instrument", className: "SimplerDevice", parameters: [], objectIdentity: "simulator:device:simpler-1", enabled: true, samplePath: "/old/a.wav" },
    { ref: "device:roar-1", parentRef: "track:track-1", name: "Roar", kind: "audio-effect", className: "Roar", parameters: [], objectIdentity: "simulator:device:roar-1", enabled: true, roar: { routingModeIndex: 0, routingModeList: ["Single", "Serial", "Parallel"], envListen: false } },
  );
}
const device = (simulator: DeterministicLiveSimulator, reference: string): Row => drums(simulator).devices.find((row: Row) => row.ref === reference);

function audio(simulator: DeterministicLiveSimulator): void {
  drums(simulator).clips.push({ ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", isAudio: true, start: 0, length: 4, notes: [], warp: true, takes: [], automation: [], muted: false, gain: 0.8, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }, { beatTime: 3, sampleTime: 132300 }] });
  drums(simulator).clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: "clip:audio-1", empty: false });
  state(simulator).scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
}
const clip = (simulator: DeterministicLiveSimulator, reference = "clip:clip-1"): Row => drums(simulator).clips.find((row: Row) => row.ref === reference);

function sample(): { filePath: string; allowedRoot: string } {
  const allowedRoot = mkdtempSync(join(tmpdir(), "moved-undo-")); const filePath = join(allowedRoot, "sample.wav");
  writeFileSync(filePath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("moved-bytes")]));
  return { filePath, allowedRoot };
}

test("a mixer undo after a track is inserted above is refused: the track now at that place is untouched, and the change stays applied", async () => {
  // The reviewer's case: Kumi unmutes Bass; a track inserted above puts Drums (unmuted, as the change
  // left Bass) at Bass's place. The undo must not mute Drums.
  const simulator = new DeterministicLiveSimulator(); const bass = drums(simulator); bass.name = "Bass"; bass.mute = true; bass.mixer.mute = true;
  const { adapter, writes } = watched(simulator); const { call, apply, undo } = hosted(adapter);
  const previewed = await call("live_mixer_preview", { trackRef: "track:track-1", mute: false }); assert.ok(previewed.transactionId, JSON.stringify(previewed));
  assert.equal((await apply("live_mixer_apply", previewed)).state, "applied"); assert.equal(bass.mixer.mute, false);
  const back = another(bass); const mixerBack = another(bass.mixer, ["volumeIdentity", "panIdentity", "cueIdentity", "sendIdentities", "mixerIdentity"]); bass.name = "Drums";
  writes.length = 0;
  const refused = await undo(previewed.transactionId);
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.match(refused.reason, /Undo stopped before it changed anything in Live: the track at track:track-1 isn't the one this change was made on any more/);
  assert.match(refused.remediation, /the change is still in place/);
  assert.deepEqual(writes, [], "nothing was sent to Live"); assert.equal(bass.mixer.mute, false, "the track now at that place keeps its mute");
  // The track inserted above goes again: Bass is back at its place, and the same change undoes.
  back(); mixerBack(); bass.name = "Bass";
  assert.equal((await undo(previewed.transactionId)).state, "undone"); assert.equal(bass.mixer.mute, true);
});

test("an undo its own check refuses leaves the change applied, and the next undo, with any key, starts over", async () => {
  const simulator = new DeterministicLiveSimulator(); const { adapter, writes } = watched(simulator); const { call, apply, undo } = hosted(adapter);
  const previewed = await call("live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 });
  assert.equal((await apply("live_mixer_apply", previewed)).state, "applied");
  drums(simulator).mixer.volume = 0.6; drums(simulator).volume = 0.6; writes.length = 0;
  const refused = await undo(previewed.transactionId);
  assert.equal(refused.isError, true); assert.match(refused.reason, /mixer changed after apply/); assert.deepEqual(writes, []);
  // The producer puts the fader back: the change is Kumi's again, and a new undo (another key) goes, not refused for its key.
  drums(simulator).mixer.volume = 0.5; drums(simulator).volume = 0.5;
  const undone = await undo(previewed.transactionId);
  assert.equal(undone.state, "undone", JSON.stringify(undone)); assert.equal(drums(simulator).mixer.volume, 0.85);
});

test("every single-object undo goes only to the object its change was made on", async () => {
  const cases: Array<{ label: string; preview: string; args: (simulator: DeterministicLiveSimulator) => Record<string, unknown>; setup?: (simulator: DeterministicLiveSimulator) => void; place: (simulator: DeterministicLiveSimulator) => () => void }> = [
    { label: "track view", preview: "live_track_view_preview", args: () => ({ ref: "track:track-1", collapsed: true }), place: (simulator) => another(drums(simulator)) },
    { label: "extended mixer", preview: "live_mixer_extended_preview", args: () => ({ trackRef: "track:track-1", trackActivator: false }), place: (simulator) => both(another(drums(simulator)), another(drums(simulator).mixer, ["mixerIdentity"])) },
    { label: "text saved on a track", preview: "live_data_preview", args: () => ({ key: "kumi.role", value: "lead", trackRef: "track:track-1" }), place: (simulator) => another(drums(simulator)) },
    { label: "clip view", preview: "live_clip_view_preview", args: () => ({ clipRef: "clip:clip-1", gridQuantization: 4 }), place: (simulator) => another(clip(simulator)) },
    { label: "clip properties", preview: "live_clip_properties_preview", args: () => ({ clipRef: "clip:clip-1", muted: true }), place: (simulator) => another(clip(simulator)) },
    { label: "note duplication", preview: "live_note_edit_preview", args: () => ({ clipRef: "clip:clip-1", action: "duplicate", noteIds: [1] }), place: (simulator) => another(clip(simulator)) },
    { label: "MIDI transform", preview: "live_midi_transform_preview", args: () => ({ clipRef: "clip:clip-1", transform: "transpose", params: { semitones: -4 } }), place: (simulator) => another(clip(simulator)) },
    { label: "audio clip", preview: "live_audio_clip_preview", args: () => ({ clipRef: "clip:audio-1", gain: 0.5 }), setup: audio, place: (simulator) => another(clip(simulator, "clip:audio-1")) },
    { label: "warp marker", preview: "live_warp_marker_preview", args: () => ({ clipRef: "clip:audio-1", action: "add", beatTime: 2 }), setup: audio, place: (simulator) => another(clip(simulator, "clip:audio-1")) },
    { label: "device on/off", preview: "live_device_preview", args: () => ({ action: "enable", deviceRef: "device:utility-1", enabled: false }), place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "device view", preview: "live_device_view_preview", args: () => ({ ref: "device:utility-1", collapsed: true }), place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "device IO", preview: "live_device_io_preview", args: () => ({ action: "routing", deviceRef: "device:utility-1", routingType: "Main", routingChannel: "1/2" }), setup: rack, place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "rack variation", preview: "live_rack_preview", args: () => ({ action: "set", rackRef: "device:utility-1", selectedVariationIndex: 1 }), setup: rack, place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "rack macro", preview: "live_rack_preview", args: () => ({ action: "add-macro", rackRef: "device:utility-1" }), setup: rack, place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "rack view", preview: "live_rack_view_preview", args: () => ({ rackRef: "device:utility-1", padScrollPosition: 4 }), setup: rack, place: (simulator) => another(device(simulator, "device:utility-1")) },
    { label: "chain mixer", preview: "live_chain_mixer_preview", args: () => ({ chainRef: "chain:rack-1:0", volume: 0.5 }), setup: rack, place: (simulator) => both(another(chain(simulator)), another(chain(simulator).mixer, ["mixerIdentity"])) },
    { label: "chain", preview: "live_chain_preview", args: () => ({ chainRef: "chain:rack-1:0", colorIndex: 9 }), setup: rack, place: (simulator) => another(chain(simulator)) },
    { label: "drum pad", preview: "live_drum_pad_preview", args: () => ({ action: "set", padRef: "drum-pad:rack-1:0", solo: true }), setup: rack, place: (simulator) => another(drums(simulator).devices[0].drumPads[0]) },
    { label: "specialized device", preview: "live_device_specialized_preview", args: () => ({ family: "drift", deviceRef: "device:drift-1", pitchBendRange: 24 }), setup: devices, place: (simulator) => another(device(simulator, "device:drift-1")) },
    { label: "looper", preview: "live_looper_preview", args: () => ({ action: "set", deviceRef: "device:looper-1", overdubAfterRecord: true }), setup: devices, place: (simulator) => another(device(simulator, "device:looper-1")) },
    { label: "simpler sample", preview: "live_simpler_preview", args: () => ({ deviceRef: "device:simpler-1", ...sample() }), setup: devices, place: (simulator) => another(device(simulator, "device:simpler-1")) },
    { label: "device setting", preview: "live_device_edit_preview", args: () => ({ deviceRef: "device:roar-1", action: "set", setting: "roar.routing_mode_index", value: 2 }), setup: devices, place: (simulator) => another(device(simulator, "device:roar-1")) },
    { label: "groove", preview: "live_groove_preview", args: () => ({ action: "edit", grooveRef: "groove:groove-1", name: "MPC 57", timingAmount: 0.57 }), place: (simulator) => another(state(simulator).groovePool.grooves[0]) },
  ];
  const failures: string[] = [];
  for (const entry of cases) {
    const simulator = new DeterministicLiveSimulator(); entry.setup?.(simulator);
    const { adapter, writes } = watched(simulator); const { call, apply, undo } = hosted(adapter);
    const previewed = await call(entry.preview, entry.args(simulator)); assert.ok(previewed.transactionId, `${entry.label}: ${JSON.stringify(previewed)}`);
    const applied = await apply(entry.preview.replace(/_preview$/, "_apply"), previewed); assert.equal(applied.state, "applied", `${entry.label}: ${JSON.stringify(applied)}`);
    const back = entry.place(simulator); writes.length = 0;
    const refused = await undo(previewed.transactionId);
    if (refused.isError !== true || !/isn't the one this change was made on any more/.test(String(refused.reason)) || writes.length > 0) { failures.push(`${entry.label}: ${JSON.stringify(refused).slice(0, 240)}; sent ${JSON.stringify(writes)}`); continue; }
    back();
    const undone = await undo(previewed.transactionId);
    if (undone.state !== "undone") failures.push(`${entry.label} once back at its place: ${JSON.stringify(undone).slice(0, 240)}`);
  }
  assert.deepEqual(failures, []);
});
