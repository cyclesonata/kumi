import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LiveMutationNotDispatchedError, type LiveInvocation, type LiveSnapshot } from "../src/live.js";
import { validateLiveOperationRequest } from "../src/registry.js";

// Behaviours of real Live (12.4) and of the bridge adapter that the simulator alone doesn't show:
// writes Live applies on its next tick, 32-bit floats, -1 for "none", and arguments the adapter
// refuses before anything reaches Live.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
type Result = { error?: { code: number; message: string }; isError?: boolean; body: any };

function hostFor(simulator: DeterministicLiveSimulator) {
  const host = new McpHost(simulator); host.handle(initialize); host.handle(initialized);
  let id = 10;
  const call = async (name: string, args: unknown): Promise<Result> => {
    const response = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any;
    return response.error ? { error: response.error, body: undefined } : { isError: response.result.isError, body: JSON.parse(response.result.content[0].text) };
  };
  const apply = (preview: Result, key: string) => call(preview.body.transactionId.startsWith("transport_") ? "live_transport_apply" : applyToolFor(preview.body.transactionId), { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: key });
  const undo = (preview: Result, key: string) => call("live_undo", { transactionId: preview.body.transactionId, confirmation: "undo", idempotencyKey: key });
  return { host, call, apply, undo };
}

function applyToolFor(transactionId: string): string {
  const prefixes: Record<string, string> = { clipaction_: "live_clip_action_apply", routing_: "live_routing_apply", sceneset_: "live_scene_apply", songset_: "live_song_settings_apply", trackstruct_: "live_track_structure_apply", devadv_: "live_device_advanced_apply", devdel_: "live_device_delete_apply", scenecapture_: "live_scene_capture_apply", capturemidi_: "live_capture_midi_apply", arrangement_: "live_arrangement_section_apply", structure_: "live_session_structure_apply" };
  const prefix = Object.keys(prefixes).find((candidate) => transactionId.startsWith(candidate));
  if (!prefix) throw new Error(`no apply tool for ${transactionId}`);
  return prefixes[prefix]!;
}

/** Arguments as the bridge adapter checks them before sending anything: wire-serializable (no
 * undefined field) and within the registry; a refusal there is one before anything reached Live. */
function checkingArguments(simulator: DeterministicLiveSimulator, seen: LiveInvocation[] = []): DeterministicLiveSimulator {
  const invoke = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    const wire = (value: unknown): void => { if (value === undefined) throw new LiveMutationNotDispatchedError("unsupported wire value"); if (value && typeof value === "object") for (const item of Object.values(value)) wire(item); };
    wire(invocation.args);
    try { validateLiveOperationRequest(invocation.operation, invocation.args); } catch (error) { throw new LiveMutationNotDispatchedError((error as Error).message); }
    seen.push(structuredClone(invocation));
    return invoke(invocation);
  };
  return simulator;
}

/** Live 12.4 applies transport writes and a track's arm on its next tick: the change shows only from
 * the second fresh read after the write; the write's own answer can't confirm it. */
function applyingOnNextTick(simulator: DeterministicLiveSimulator, operations: readonly string[]): DeterministicLiveSimulator {
  const invoke = simulator.invokeAsync.bind(simulator); const snapshot = simulator.snapshotAsync.bind(simulator);
  const pending: Array<{ reads: number; apply: () => Promise<unknown> }> = [];
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    if (!operations.includes(invocation.operation)) return invoke(invocation);
    const before = await snapshot();
    pending.push({ reads: 0, apply: () => invoke(invocation) });
    return invocation.operation === "transport.set" ? { changed: true, revision: before.playback.revision } : invocation.operation === "scene.fire-selected" ? { fired: true } : { changed: true, revision: 1 };
  };
  simulator.snapshotAsync = async (): Promise<LiveSnapshot> => {
    for (const entry of [...pending]) if (entry.reads++ >= 1) { pending.splice(pending.indexOf(entry), 1); await entry.apply(); }
    return snapshot();
  };
  return simulator;
}

test("loop, metronome and arm that Live applies on its next tick are confirmed in fresh state and undone the same way", async () => {
  const simulator = applyingOnNextTick(new DeterministicLiveSimulator(), ["transport.set", "routing.set"]);
  Object.assign((simulator as any).state.playback.transport, { position: 4096, loop: { enabled: false, start: 8, length: 16 }, metronome: false });
  const { call, apply, undo } = hostFor(simulator);
  const transport = await call("live_transport_preview", { loopEnabled: true, loopStart: 16, loopLength: 16, metronome: true });
  const applied = await apply(transport, "transport-next-tick");
  assert.equal(applied.body.state, "applied", JSON.stringify(applied.body));
  assert.deepEqual([(simulator as any).state.playback.transport.loop, (simulator as any).state.playback.transport.metronome], [{ enabled: true, start: 16, length: 16 }, true]);
  const transportUndone = await undo(transport, "transport-next-tick-undo");
  assert.equal(transportUndone.body.state, "undone", JSON.stringify(transportUndone.body));
  assert.deepEqual([(simulator as any).state.playback.transport.loop, (simulator as any).state.playback.transport.metronome], [{ enabled: false, start: 8, length: 16 }, false]);
  const routing = await call("live_routing_preview", { trackRef: "track:track-1", arm: true });
  assert.equal((await apply(routing, "arm-next-tick")).body.state, "applied");
  assert.equal((simulator as any).state.tracks[0].armed, true);
  assert.equal((await undo(routing, "arm-next-tick-undo")).body.state, "undone");
  assert.equal((simulator as any).state.tracks[0].armed, false);
});

test("a playhead-only undo refused while playing leaves the change applied: undone after stopping, with a new key", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply, undo } = hostFor(simulator);
  const moved = await call("live_transport_preview", { position: 32 });
  assert.equal((await apply(moved, "playhead-move")).body.state, "applied");
  (simulator as any).state.playback.transport.playing = true;
  const refused = await undo(moved, "playhead-undo-playing");
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.body), /stop playback first/);
  (simulator as any).state.playback.transport.playing = false;
  const undone = await undo(moved, "playhead-undo-stopped");
  assert.equal(undone.body.state, "undone", JSON.stringify(undone.body));
});

test("a playhead, loop or locators past the end of the Set are refused with where it ends, and nothing is uncertain", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply } = hostFor(simulator);
  const pastEnd = "request failed: past the end of the Set: its arrangement ends at beat 1536, and Live can't go further; nothing changed. Pick an earlier spot, or make the arrangement longer first";
  const invoke = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    if (invocation.operation === "transport.set" || (invocation.operation === "locator.add" && (invocation.args as any).position > 1536)) throw new Error(pastEnd);
    return invoke(invocation);
  };
  const transport = await call("live_transport_preview", { loopEnabled: true, loopStart: 4096, loopLength: 16 });
  const refused = await apply(transport, "past-end-loop");
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.body, { reason: pastEnd, remediation: "Nothing changed in Live." });
  const locators = await call("live_arrangement_section_preview", { start: 1024, end: 4112, startName: "Kumi Start", endName: "Kumi End" });
  const locatorsRefused = await apply(locators, "past-end-locators");
  assert.equal(locatorsRefused.isError, true);
  assert.deepEqual(locatorsRefused.body, { reason: pastEnd, remediation: "Nothing changed in Live." });
  // The start locator it had made first was taken away again.
  assert.equal((await simulator.snapshotAsync()).arrangement.locators.some((locator) => locator.name === "Kumi Start"), false);
});

test("routing a No Input track and undoing it puts No Input back without writing an empty sub-routing", async () => {
  const simulator = checkingArguments(new DeterministicLiveSimulator()); const { call, apply, undo } = hostFor(simulator);
  (simulator as any).state.tracks[0].routing = { ...(simulator as any).state.tracks[0].routing, inputType: "No Input", inputSubRouting: null };
  const routed = await call("live_routing_preview", { trackRef: "track:track-1", inputType: "Ext. In", inputSubRouting: "1" });
  assert.equal((await apply(routed, "route-from-no-input")).body.state, "applied");
  const undone = await undo(routed, "route-from-no-input-undo");
  assert.equal(undone.body.state, "undone", JSON.stringify(undone.body));
  assert.deepEqual([(simulator as any).state.tracks[0].routing.inputType, (simulator as any).state.tracks[0].routing.inputSubRouting], ["No Input", null]);
});

test("an undo Live can't carry out because it no longer offers the old routing is a refusal, not uncertain", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply, undo } = hostFor(simulator);
  const routed = await call("live_routing_preview", { trackRef: "track:track-1", inputType: "Resampling" });
  assert.equal((await apply(routed, "route-resampling")).body.state, "applied");
  const invoke = simulator.invokeAsync.bind(simulator); let refuse = true;
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    if (refuse && invocation.operation === "routing.set") throw new Error("request failed: Live doesn't offer Ext. In for this track now; nothing changed");
    return invoke(invocation);
  };
  const refused = await undo(routed, "route-resampling-undo");
  assert.equal(refused.isError, true);
  assert.match(refused.body.reason, /^Undo refused before anything changed in Live: request failed: Live doesn't offer Ext. In/);
  refuse = false;
  assert.equal((await undo(routed, "route-resampling-undo-again")).body.state, "undone");
});

test("a scene Live launches on its next tick is confirmed in fresh state", async () => {
  const simulator = applyingOnNextTick(new DeterministicLiveSimulator(), ["scene.fire-selected"]);
  const { call } = hostFor(simulator);
  const preview = await call("live_scene_fire_preview", { ref: "scene:scene-1" });
  assert.equal(preview.isError, false, JSON.stringify(preview.body));
  const applied = await call("live_scene_fire_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: "scene-next-tick" });
  assert.equal(applied.body.state, "applied", JSON.stringify(applied.body));
  assert.equal((simulator as any).state.playback.transport.playing, true);
  // An empty scene has nothing to play, and says so before anything happens.
  (simulator as any).state.playback.transport.playing = false; (simulator as any).state.scenes[0].isEmpty = true; (simulator as any).state.scenes[0].isTriggered = false;
  const empty = await call("live_scene_fire_preview", { ref: "scene:scene-1" });
  assert.equal(empty.isError, true);
  assert.deepEqual(empty.body, { reason: "that scene has no clips to play, so launching it would only stop what's playing", remediation: "Nothing was launched. Put clips in the scene first, or launch another." });
});

test("a track the client made as scratch goes on an undo with discard, though it changed; without it, the undo is refused", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply } = hostFor(simulator);
  const made = await call("live_session_structure_preview", { tracks: [{ name: "Kumi Listen", kind: "audio" }], scenes: [] });
  assert.equal((await apply(made, "scratch-track")).body.state, "applied");
  // Something recorded on it: its fingerprint no longer matches.
  const scratch = (simulator as any).state.tracks.find((track: any) => track.name === "Kumi Listen"); scratch.armed = true; scratch.monitoringState = "in";
  const kept = await call("live_undo", { transactionId: made.body.transactionId, confirmation: "undo", idempotencyKey: "scratch-undo" });
  assert.equal(kept.isError, true); assert.match(kept.body.reason, /modified after apply/);
  const discarded = await call("live_undo", { transactionId: made.body.transactionId, confirmation: "undo", idempotencyKey: "scratch-discard", discard: true });
  assert.equal(discarded.body.state, "undone", JSON.stringify(discarded.body));
  assert.equal((simulator as any).state.tracks.some((track: any) => track.name === "Kumi Listen"), false);
});

test("a client releases applied changes it won't undo: they stop holding capacity, and an undo of one says it's gone", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply } = hostFor(simulator);
  const made = await call("live_session_structure_preview", { tracks: [{ name: "Scratch", kind: "audio" }], scenes: [] });
  assert.equal((await apply(made, "release-me")).body.state, "applied");
  const released = await call("live_transaction_release", { transactionIds: [made.body.transactionId, "never-heard-of-it"] });
  assert.deepEqual(released.body, { released: 1 }, "the unknown one is simply gone already");
  const undo = await call("live_undo", { transactionId: made.body.transactionId, confirmation: "undo", idempotencyKey: "after-release" });
  assert.equal(undo.isError, true, "no undo left for it");
  assert.equal((simulator as any).state.tracks.some((track: any) => track.name === "Scratch"), true, "and nothing changed in Live");
  assert.equal((await call("live_transaction_release", { transactionIds: [] })).isError ?? true, true);
});

test("an undo the bridge refuses before anything reaches Live is a refusal, and the change stays applied", async () => {
  const simulator = new DeterministicLiveSimulator(); const { call, apply, undo } = hostFor(simulator);
  const created = await call("live_track_structure_preview", { action: "create-return", name: "Sweep Return" });
  assert.equal((await apply(created, "return-create")).body.state, "applied");
  // A later track insertion moved the return, so the bridge no longer holds its cleanup ownership.
  const invoke = simulator.invokeAsync.bind(simulator); let refuse = true;
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    if (refuse && invocation.operation === "track.delete-return") throw new LiveMutationNotDispatchedError("request failed: destructive cleanup lacks exact transaction-owned authority");
    return invoke(invocation);
  };
  const refused = await undo(created, "return-undo-refused");
  assert.equal(refused.isError, true);
  assert.match(refused.body.reason, /^Undo refused before anything changed in Live: request failed: destructive cleanup lacks exact transaction-owned authority/);
  assert.equal((simulator as any).state.tracks.some((track: any) => track.kind === "return"), true);
  // Left applied, not uncertain: another undo with a new key goes ahead normally.
  refuse = false;
  assert.equal((await undo(created, "return-undo-again")).body.state, "undone");
  assert.equal((simulator as any).state.tracks.some((track: any) => track.kind === "return"), false);
});

test("deleting an existing device or return track carries the explicit deletion authority the bridge checks", async () => {
  const seen: LiveInvocation[] = []; const simulator = checkingArguments(new DeterministicLiveSimulator(), seen); const { call, apply } = hostFor(simulator);
  const device = await call("live_device_delete_preview", { ref: "device:utility-1" });
  assert.equal((await apply(device, "device-delete")).body.state, "applied");
  assert.equal((seen.find((invocation) => invocation.operation === "device.delete")!.args as any).explicitDeletion, true);
  // A return track the producer made by hand, not through this host.
  const track = structuredClone((simulator as any).state.tracks[0]); Object.assign(track, { ref: "track:return-a", objectIdentity: "simulator:track:return-a", name: "A-Reverb", kind: "return", clips: [], clipSlots: [], devices: [] });
  (simulator as any).state.tracks.push(track);
  const removed = await call("live_track_structure_preview", { action: "delete-return", ref: "track:return-a" });
  assert.equal((await apply(removed, "return-delete")).body.state, "applied");
  assert.equal((seen.find((invocation) => invocation.operation === "track.delete-return")!.args as any).explicitDeletion, true);
  assert.equal((simulator as any).state.tracks.some((candidate: any) => candidate.ref === "track:return-a"), false);
});

test("a switched-off scene tempo (-1 in Live) is undone by switching it off, never by writing -1", async () => {
  const simulator = checkingArguments(new DeterministicLiveSimulator()); Object.assign((simulator as any).state.scenes[0], { tempo: -1, tempoEnabled: false });
  const { call, apply, undo } = hostFor(simulator);
  const preview = await call("live_scene_preview", { ref: "scene:scene-1", tempo: 122, tempoEnabled: true });
  assert.deepEqual(preview.body.prior, { tempo: -1, tempoEnabled: false });
  assert.equal((await apply(preview, "scene-tempo")).body.state, "applied");
  assert.deepEqual([(simulator as any).state.scenes[0].tempo, (simulator as any).state.scenes[0].tempoEnabled], [122, true]);
  const undone = await undo(preview, "scene-tempo-undo");
  assert.equal(undone.body.state, "undone", JSON.stringify(undone.body));
  assert.equal((simulator as any).state.scenes[0].tempoEnabled, false);
  // Only the tempo changed: its switch still belongs to the prior, and undo switches it off again.
  Object.assign((simulator as any).state.scenes[0], { tempo: -1, tempoEnabled: false });
  const tempoOnly = await call("live_scene_preview", { ref: "scene:scene-1", tempo: 100 });
  assert.deepEqual(tempoOnly.body.prior, { tempo: -1, tempoEnabled: false });
});

test("a device moved to another track is moved back where it came from, with wire-valid arguments", async () => {
  const simulator = checkingArguments(new DeterministicLiveSimulator());
  const second = structuredClone((simulator as any).state.tracks[0]); Object.assign(second, { ref: "track:track-2", objectIdentity: "simulator:track:track-2", name: "Bass", clips: [], clipSlots: [], devices: [] }); (simulator as any).state.tracks.push(second);
  const { call, apply, undo } = hostFor(simulator);
  const move = await call("live_device_advanced_preview", { action: "move-cross", ref: "device:utility-1", index: 0, targetTrackRef: "track:track-2" });
  assert.equal((await apply(move, "move-cross")).body.state, "applied");
  assert.deepEqual([(simulator as any).state.tracks[0].devices.length, (simulator as any).state.tracks[1].devices.length], [0, 1]);
  const undone = await undo(move, "move-cross-undo");
  assert.equal(undone.body.state, "undone", JSON.stringify(undone.body));
  assert.deepEqual([(simulator as any).state.tracks[0].devices.length, (simulator as any).state.tracks[1].devices.length], [1, 0]);
});

test("a swing Live keeps as a 32-bit float is confirmed and undone", async () => {
  const simulator = new DeterministicLiveSimulator(); const invoke = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation: LiveInvocation) => {
    const result = await invoke(invocation) as any;
    if (invocation.operation === "song.set" && typeof (simulator as any).state.song.swingAmount === "number") (simulator as any).state.song.swingAmount = Math.fround((simulator as any).state.song.swingAmount);
    return result;
  };
  const { call, apply, undo } = hostFor(simulator);
  const preview = await call("live_song_settings_preview", { swingAmount: 0.15 });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  const applied = await apply(preview, "swing-apply");
  assert.equal(applied.body.state, "applied", JSON.stringify(applied.body));
  assert.notEqual((simulator as any).state.song.swingAmount, 0.15);
  assert.equal((await undo(preview, "swing-undo")).body.state, "undone");
  assert.equal((simulator as any).state.song.swingAmount, 0);
});

test("a capture previewed while the song plays applies although the playhead moved", async () => {
  const simulator = new DeterministicLiveSimulator(); Object.assign((simulator as any).state.playback.transport, { playing: true, position: 1272 });
  const { call, apply } = hostFor(simulator);
  const preview = await call("live_scene_capture_preview", {});
  (simulator as any).state.playback.transport.position = 1276.5; (simulator as any).state.set.position = 1276.5;
  assert.equal((await apply(preview, "capture-while-playing")).body.state, "applied");
});

test("a clip action previewed while the clip plays applies although its playing position moved; a changed clip still refuses", async () => {
  const simulator = new DeterministicLiveSimulator(); const clip = (simulator as any).state.tracks[0].clips[0];
  Object.assign(clip, { isPlaying: true, playingPosition: 1.25, loopStart: 1, loopEnd: 3 });
  const { call, apply } = hostFor(checkingArguments(simulator));
  const crop = await call("live_clip_action_preview", { clipRef: "clip:clip-1", action: "crop" });
  clip.playingPosition = 2.62;
  assert.equal((await apply(crop, "crop-while-playing")).body.state, "applied"); assert.equal(clip.length, 2);
  const jump = await call("live_clip_action_preview", { clipRef: "clip:clip-1", action: "move-playing-position", offset: 1 });
  clip.playingPosition = 1.5;
  assert.equal((await apply(jump, "jump-while-playing")).body.state, "applied");
  const stale = await call("live_clip_action_preview", { clipRef: "clip:clip-1", action: "move-playing-position", offset: 1 });
  clip.loopEnd = 2.5;
  const refused = await apply(stale, "jump-after-loop-change");
  assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.body), /changed since preview/);
});
