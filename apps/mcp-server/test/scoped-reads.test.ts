import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveSnapshot, type LiveSnapshotRequest } from "../src/live.js";
import { discoverSessionAsync } from "../src/transactions/session-midi.js";

// A change reads what it touches, not the Set: its preview, apply, verification and undo read the tracks
// it names whole and every other track light (or no tracks at all), so what one change costs doesn't grow
// with the Set. A counting adapter tells the reads apart by what they answered.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

/** How much of the Set one snapshot read built: every track whole, some, none (all light), or no tracks at all. */
type Read = "full" | "focused" | "light" | "none";
type Tally = Record<Read, number>;

function readKind(answer: LiveSnapshot): Read {
  if (!Array.isArray(answer.tracks)) return "none";
  const whole = answer.tracks.filter((track) => track.light !== true).length;
  if (whole > 0 && whole === (answer.trackCount ?? answer.tracks.length)) return "full";
  return whole === 0 ? "light" : "focused";
}

/** Snapshot requests without arguments: the whole Set in one request, unbudgeted on Live's thread. */
const bareRequests: string[] = [];

/** Counts every snapshot read of the simulator by what it answered; `legacy` answers every request with
 * the whole Set, as a Remote Script from before snapshot arguments does. A request without arguments is
 * noted, with where it came from: no host path sends one. */
function counting(simulator: DeterministicLiveSimulator, legacy = false): Read[] {
  const reads: Read[] = [];
  const snapshotAsync = simulator.snapshotAsync.bind(simulator);
  simulator.snapshotAsync = async (context?: Parameters<DeterministicLiveSimulator["snapshotAsync"]>[0], request?: LiveSnapshotRequest) => {
    if (request === undefined || Object.keys(request).length === 0) bareRequests.push(new Error().stack?.split("\n").slice(2, 5).join(" | ") ?? "?");
    const answer = legacy ? simulator.snapshot() : await snapshotAsync(context, request);
    reads.push(readKind(answer));
    return answer;
  };
  return reads;
}

/** A plain audio track at the end of the Set, so that one track read whole is not every track. */
function plainTrack(index: number): Record<string, unknown> {
  return { ref: `track:extra-${index}`, objectIdentity: `simulator:track:extra-${index}`, name: `Extra ${index}`, kind: "audio", volume: 0.85, pan: 0, mute: false, solo: false, armed: false, clips: [], clipSlots: [{ ref: `clip-slot:extra-${index}:0`, parentRef: `track:extra-${index}`, objectIdentity: `simulator:clip-slot:extra-${index}:0`, sceneIndex: 0, clipRef: null, empty: true }], devices: [], sends: [0, 0] };
}

/** Previews, applies and undoes one change of each representative family on a four-track Set, tallying
 * the snapshot reads of each step. */
async function tallyFamilies(legacy: boolean): Promise<Array<[string, Tally]>> {
  const simulator = new DeterministicLiveSimulator(); const state = (simulator as any).state;
  state.tracks[0].devices[0].parameters.push({ ref: "parameter:width-1", objectIdentity: "simulator:parameter:width-1", name: "Width", value: 1, min: 0, max: 4, automatable: true, quantization: 0, enabled: true, revision: 1 });
  state.tracks[0].devices.push({ ref: "device:drift-1", parentRef: "track:track-1", name: "Drift", kind: "instrument", className: "DriftDevice", parameters: [], objectIdentity: "simulator:device:drift-1", enabled: true, drift: { pitchBendRange: 12, voiceCount: 2, voiceMode: 0 } });
  for (let index = 2; index <= 4; index += 1) state.tracks.push(plainTrack(index));
  const reads = counting(simulator, legacy);
  const host = new McpHost(simulator); host.handle(initialize); host.handle(initialized);
  let id = 10;
  const call = async (name: string, args: unknown): Promise<any> => {
    const response = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any;
    assert.equal(response.result?.isError, false, `${name}: ${JSON.stringify(response.result ?? response.error)}`);
    return JSON.parse(response.result.content[0].text);
  };
  // What a client reads first: the whole Set, which also shows where the simulator's references sit
  // (the Remote Script's positional references carry their track and need no such look).
  await call("live_snapshot", {});
  const table: Array<[string, Tally]> = [];
  const step = async (label: string, run: () => Promise<any>): Promise<any> => {
    reads.length = 0;
    const body = await run();
    table.push([label, { full: reads.filter((read) => read === "full").length, focused: reads.filter((read) => read === "focused").length, light: reads.filter((read) => read === "light").length, none: reads.filter((read) => read === "none").length }]);
    return body;
  };
  const family = async (label: string, previewTool: string, previewArgs: unknown, applyTool: string, token = false): Promise<void> => {
    const preview = await step(`${label} preview`, () => call(previewTool, previewArgs));
    const applied = await step(`${label} apply`, () => call(applyTool, { transactionId: preview.transactionId, confirmation: token ? preview.confirmation : "apply", idempotencyKey: `${label}-apply` }));
    assert.equal(applied.state, "applied", `${label}: ${JSON.stringify(applied)}`);
    const undone = await step(`${label} undo`, () => call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: `${label}-undo` }));
    assert.equal(undone.state, "undone", `${label}: ${JSON.stringify(undone)}`);
  };
  await family("tempo", "live_tempo_preview", { tempo: 128 }, "live_tempo_apply");
  await family("mixer", "live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 }, "live_mixer_apply");
  await family("device parameter", "live_device_parameter_preview", { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.25 }, "live_device_parameter_apply", true);
  await family("parameters", "live_device_parameter_preview", { deviceRef: "device:utility-1", values: [{ parameterRef: "parameter:gain-1", value: 0.3 }, { parameterRef: "parameter:width-1", value: 2 }] }, "live_device_parameter_apply", true);
  await family("rename", "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "Beats" }, "live_object_rename_apply");
  await family("clip set", "live_clip_properties_preview", { clipRef: "clip:clip-1", muted: true }, "live_clip_properties_apply");
  await family("note update", "live_note_update_preview", { clipRef: "clip:clip-1", notes: [{ id: 1, velocity: 90 }] }, "live_note_update_apply");
  await family("device insert", "live_device_preview", { action: "insert", trackRef: "track:track-1", deviceName: "Echo" }, "live_device_apply");
  await family("specialized device", "live_device_specialized_preview", { family: "drift", deviceRef: "device:drift-1", pitchBendRange: 24 }, "live_device_specialized_apply");
  await family("track create", "live_session_structure_preview", { tracks: [{ name: "Made", kind: "midi", index: 1 }], scenes: [] }, "live_session_structure_apply");
  return table;
}

const tally = (focused: number, light = 0, none = 0): Tally => ({ full: 0, focused, light, none });

test("changes read only the tracks they name: no whole-Set snapshot in any preview, apply or undo", async () => {
  bareRequests.length = 0;
  const table = await tallyFamilies(false);
  // Not one read without arguments (the whole Set in one request) on the way, the client's whole-Set read included.
  assert.deepEqual(bareRequests, []);
  assert.deepEqual(Object.fromEntries(table), {
    // The Set's tempo is the Set's own: its preview reads the Set part alone; apply and undo read the Set object.
    "tempo preview": tally(0, 0, 1), "tempo apply": tally(0), "tempo undo": tally(0),
    // A mixer change, a parameter change and a rename read what they touch, by its ref (a track's mixer; the
    // parameter, its device and its track; the track's name): no snapshot at all.
    "mixer preview": tally(0), "mixer apply": tally(0), "mixer undo": tally(0),
    "device parameter preview": tally(0), "device parameter apply": tally(0), "device parameter undo": tally(0),
    "parameters preview": tally(0), "parameters apply": tally(0), "parameters undo": tally(0),
    "rename preview": tally(0), "rename apply": tally(0), "rename undo": tally(0),
    "clip set preview": tally(1), "clip set apply": tally(2), "clip set undo": tally(2),
    "note update preview": tally(1), "note update apply": tally(2), "note update undo": tally(2),
    "device insert preview": tally(1), "device insert apply": tally(2), "device insert undo": tally(2),
    "specialized device preview": tally(1), "specialized device apply": tally(2), "specialized device undo": tally(1),
    // Structure: every track light for names, order and the structure revision; the made track whole to check it.
    "track create preview": tally(0, 1), "track create apply": tally(2, 2), "track create undo": tally(2, 1),
  });
});

test("the same changes work against a Remote Script that answers every read with the whole Set", async () => {
  const table = await tallyFamilies(true);
  for (const [label, counts] of table) assert.equal(counts.focused + counts.light, 0, `${label} got a partial answer from a whole-Set adapter`);
  assert.ok(table.some(([, counts]) => counts.full > 0));
});

test("a session discovery over an asynchronous adapter reads the Set through track windows, never in one request", async () => {
  const simulator = new DeterministicLiveSimulator(); const state = (simulator as any).state;
  for (let index = 2; index <= 20; index += 1) state.tracks.push(plainTrack(index));
  bareRequests.length = 0; const reads = counting(simulator);
  const tracks = await discoverSessionAsync(simulator, "track", 100);
  assert.equal(tracks.items.length, 20); assert.deepEqual(bareRequests, []); assert.equal(reads.length, 2);
});
