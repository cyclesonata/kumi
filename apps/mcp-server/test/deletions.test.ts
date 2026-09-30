import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const KEPT = "Kumi can't bring this back; Live's undo can.";

function hosted(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const raw = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as Promise<{ result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number } }>;
  const call = async (name: string, args: unknown) => { const answer = await raw(name, args); assert.ok(answer.result, JSON.stringify(answer.error)); return { isError: answer.result.isError, body: JSON.parse(answer.result.content[0]!.text) as Record<string, any> }; };
  const remove = async (kind: string, ref: string, key: string) => {
    const preview = await call(`live_${kind}_delete_preview`, { [`${kind}Ref`]: ref });
    assert.equal(preview.isError, false, JSON.stringify(preview.body)); assert.equal(preview.body.kept, KEPT);
    const applied = await call(`live_${kind}_delete_apply`, { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: key });
    return { preview: preview.body, applied };
  };
  return { host, raw, call, remove };
}

/** A second track and a second scene, made as Live would. */
function biggerSet(): DeterministicLiveSimulator {
  const simulator = new DeterministicLiveSimulator();
  const structure = () => { const snapshot = simulator.snapshot(); return createHash("sha256").update(JSON.stringify({ tracks: snapshot.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: snapshot.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) })).digest("hex"); };
  simulator.invoke({ operation: "track.create", args: { name: "Bass", kind: "midi", expectedStructureRevision: structure() } });
  simulator.invoke({ operation: "scene.create", args: { name: "Drop", expectedStructureRevision: structure() } });
  return simulator;
}

test("a Session clip the producer asked to remove is deleted, fenced, and kept: live_undo says Live's undo can bring it back", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, remove } = hosted(simulator);
  const { preview, applied } = await remove("clip", "clip:clip-1", "delete-clip-key");
  assert.deepEqual([preview.clip.ref, preview.clip.arrangement, preview.impact], ["clip:clip-1", false, "deletes-clip-no-undo"]);
  assert.deepEqual([applied.body.state, applied.body.deleted, applied.body.kept], ["applied", "clip:clip-1", KEPT]);
  assert.equal(simulator.snapshot().tracks[0]!.clips.length, 0);
  const again = await call("live_clip_delete_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "delete-clip-key" });
  assert.equal(again.body.idempotent, true);
  const undo = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "undo-deleted-clip" });
  assert.equal(undo.isError, true); assert.equal(undo.body.reason, KEPT); assert.match(undo.body.remediation, /Live's own undo/);
});

test("an Arrangement clip, a scene, a track and a locator are deleted the same way, each fenced to what surrounds it", async () => {
  const simulator = biggerSet();
  (simulator as unknown as { state: { arrangementClips: unknown[] } }).state.arrangementClips.push({ clip: { ...structuredClone(simulator.snapshot().tracks[0]!.clips[0]!), ref: "arrangement-clip:track-1:0", objectIdentity: "simulator:arrangement-clip:1", name: "Arranged", start: 8, length: 4 }, trackRef: "track:track-1" });
  const { remove } = hosted(simulator);
  const arranged = await remove("clip", "arrangement-clip:track-1:0", "delete-arranged-key");
  assert.equal(arranged.preview.clip.arrangement, true); assert.equal(arranged.applied.body.state, "applied", JSON.stringify(arranged.applied.body));
  assert.equal(simulator.snapshot().arrangement.clips?.length ?? 0, 0);
  const scene = simulator.snapshot().scenes[1]!;
  assert.equal((await remove("scene", scene.ref, "delete-scene-key")).applied.body.state, "applied"); assert.equal(simulator.snapshot().scenes.length, 1);
  const bass = simulator.snapshot().tracks.find((track) => track.name === "Bass")!;
  assert.equal((await remove("track", bass.ref, "delete-track-key")).applied.body.state, "applied"); assert.equal(simulator.snapshot().tracks.some((track) => track.name === "Bass"), false);
  assert.equal((await remove("locator", "locator:locator-1", "delete-locator-key")).applied.body.state, "applied"); assert.equal(simulator.snapshot().arrangement.locators.length, 0);
});

test("a deletion is refused when what it's fenced to changed since its preview, and the last scene stays", async () => {
  const simulator = biggerSet();
  const { call } = hosted(simulator);
  const lastScene = new DeterministicLiveSimulator();
  const single = hosted(lastScene);
  const refused = await single.call("live_scene_delete_preview", { sceneRef: "scene:scene-1" });
  assert.equal(refused.isError, true); assert.match(refused.body.reason, /at least one scene/);
  const preview = await call("live_track_delete_preview", { trackRef: "track:track-1" });
  // The producer renames a track in Live between the preview and the apply.
  simulator.simulateExternalEdit(simulator.snapshot().tracks[1]!.ref, "name", "Bass 2");
  const stale = await call("live_track_delete_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: "stale-track-key" });
  assert.equal(stale.isError, true); assert.match(stale.body.reason, /changed since the preview/);
  assert.equal(simulator.snapshot().tracks.length, 2, "nothing was deleted");
  assert.equal((await call("live_track_delete_preview", { trackRef: "track:none" })).isError, true);
  assert.equal((await single.raw("live_track_delete_preview", {})).error?.code, -32602);
});

test("over the wire a deletion is one mutate with explicitDeletion and no ownership token", async () => {
  const live = await serveSimulator(new DeterministicLiveSimulator());
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { remove } = hosted(adapter);
    const { applied } = await remove("locator", "locator:locator-1", "wire-delete-locator");
    assert.equal(applied.body.state, "applied", JSON.stringify(applied.body));
    const mutate = live.requests.find((request) => request.method === "mutate")!;
    assert.equal(mutate.operation, "locator.delete"); assert.equal(mutate.args!.explicitDeletion, true);
    assert.match(mutate.stateDigest ?? "", /^[a-f0-9]{64}$/, "the preview's state digest goes with it");
  } finally { await adapter.close(); await live.close(); }
});
