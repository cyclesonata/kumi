import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

// The Remote Script's phase 2 widened three fences: Drift's covers its modulation matrix, song settings
// cover selectOnLaunch, and a track's view covers whether its racks show their chains. The host computes
// the same states, and each can be changed and undone.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function hosted(simulator: DeterministicLiveSimulator) {
  const host = new McpHost(simulator); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const call = async (name: string, args: unknown) => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result?: { isError: boolean; content: Array<{ text: string }> } }; assert.ok(answer.result); return JSON.parse(answer.result.content[0]!.text) as Record<string, any>; };
  const change = async (preview: string, apply: string, args: unknown, key: string) => { const previewed = await call(preview, args); assert.ok(previewed.transactionId, JSON.stringify(previewed)); const applied = await call(apply, { transactionId: previewed.transactionId, confirmation: "apply", idempotencyKey: key }); assert.equal(applied.state, "applied", JSON.stringify(applied)); return previewed; };
  const undo = async (transactionId: string, key: string) => { const undone = await call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: key }); assert.equal(undone.state, "undone", JSON.stringify(undone)); };
  return { call, change, undo };
}

test("a Drift modulation-matrix slot is changed and undone, fenced with Drift's other settings", async () => {
  const simulator = new DeterministicLiveSimulator();
  const drift = { ref: "device:drift-1", parentRef: "track:track-1", name: "Drift", kind: "instrument", className: "DriftDevice", parameters: [], objectIdentity: "simulator:device:drift-1", enabled: true, drift: { pitchBendRange: 12, voiceCount: 2, voiceMode: 0, modSource1: 1, modTarget1: 4 } };
  (simulator as unknown as { state: { tracks: Array<{ devices: unknown[] }> } }).state.tracks[0]!.devices.push(drift);
  const { change, undo } = hosted(simulator);
  const previewed = await change("live_device_specialized_preview", "live_device_specialized_apply", { family: "drift", deviceRef: "device:drift-1", modSource1: 3, modTarget1: 7 }, "drift-mod-key");
  assert.deepEqual(previewed.prior, { modSource1: 1, modTarget1: 4 });
  assert.deepEqual([drift.drift.modSource1, drift.drift.modTarget1], [3, 7]);
  await undo(previewed.transactionId, "drift-mod-undo");
  assert.deepEqual([drift.drift.modSource1, drift.drift.modTarget1], [1, 4]);
});

test("whether launching selects the clip or scene is a song setting, changed and undone", async () => {
  const simulator = new DeterministicLiveSimulator();
  const song = (simulator as unknown as { state: { song: { selectOnLaunch?: boolean } } }).state.song; song.selectOnLaunch = true;
  const { change, undo } = hosted(simulator);
  const previewed = await change("live_song_settings_preview", "live_song_settings_apply", { selectOnLaunch: false }, "select-on-launch-key");
  assert.equal(song.selectOnLaunch, false);
  await undo(previewed.transactionId, "select-on-launch-undo");
  assert.equal(song.selectOnLaunch, true);
});

test("a track's racks showing their chains is part of its view, changed and undone", async () => {
  const simulator = new DeterministicLiveSimulator();
  const track = (simulator as unknown as { state: { tracks: Array<{ view?: Record<string, unknown> }> } }).state.tracks[0]!; track.view = { ...(track.view ?? {}), isShowingChains: false };
  const { change, undo } = hosted(simulator);
  const previewed = await change("live_track_view_preview", "live_track_view_apply", { ref: "track:track-1", showChains: true }, "show-chains-key");
  assert.equal(previewed.prior.showChains, false); assert.equal(track.view.isShowingChains, true);
  await undo(previewed.transactionId, "show-chains-undo");
  assert.equal(track.view.isShowingChains, false);
});
