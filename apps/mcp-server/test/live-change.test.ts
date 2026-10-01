import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function hosted(simulator = new DeterministicLiveSimulator(), options: ConstructorParameters<typeof McpHost>[1] = {}) {
  const host = new McpHost(simulator, options); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const raw = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as Promise<{ result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number; message: string } }>;
  const call = async (name: string, args: unknown) => { const answer = await raw(name, args); assert.ok(answer.result, JSON.stringify(answer.error)); return { isError: answer.result.isError, body: JSON.parse(answer.result.content[0]!.text) as Record<string, any> }; };
  return { simulator, host, raw, call };
}
const volume = (simulator: DeterministicLiveSimulator) => (simulator.snapshot().tracks[0]!.mixer as { volume: number }).volume;

test("live_change previews and applies one change in one call, and live_undo undoes it as usual", async () => {
  const { simulator, call } = hosted();
  const changed = await call("live_change", { tool: "live_mixer_preview", args: { trackRef: "track:track-1", volume: 0.5 }, idempotencyKey: "fused-mixer-key" });
  assert.equal(changed.isError, false, JSON.stringify(changed.body));
  assert.equal(changed.body.state, "applied");
  assert.deepEqual(changed.body.change, { preview: "live_mixer_preview", apply: "live_mixer_apply", idempotencyKey: "fused-mixer-key" });
  assert.deepEqual(changed.body.preview.prior, { volume: 0.85 }); assert.equal(changed.body.preview.transactionId, changed.body.transactionId);
  assert.equal(volume(simulator), 0.5);
  const undone = await call("live_undo", { transactionId: changed.body.transactionId, confirmation: "undo", idempotencyKey: "fused-mixer-undo" });
  assert.equal(undone.body.state, "undone", JSON.stringify(undone.body)); assert.equal(volume(simulator), 0.85);
});

test("live_change carries a preview's own confirmation to its apply, and a retry with the same key makes no second change", async () => {
  const { simulator, call, raw } = hosted();
  const gain = () => ((simulator as unknown as { state: { tracks: Array<{ devices: Array<{ parameters: Array<{ value: number }> }> }> } }).state.tracks[0]!.devices[0]!.parameters[0]!.value);
  const args = { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.25 };
  const first = await call("live_change", { tool: "live_device_parameter_preview", args, idempotencyKey: "fused-parameter-key" });
  assert.equal(first.body.state, "applied", JSON.stringify(first.body)); assert.equal(gain(), 0.25);
  const again = await call("live_change", { tool: "live_device_parameter_preview", args, idempotencyKey: "fused-parameter-key" });
  assert.equal(again.body.state, "applied"); assert.equal(again.body.transactionId, first.body.transactionId); assert.equal(again.body.idempotent, true);
  const other = await raw("live_change", { tool: "live_device_parameter_preview", args: { ...args, value: 0.5 }, idempotencyKey: "fused-parameter-key" });
  assert.equal(other.error?.code, -32602); assert.match(other.error!.message, /already made another change/);
  assert.equal(gain(), 0.25);
});

test("live_change refuses what the producer decides on after its preview, and anything that isn't a preview with an apply", async () => {
  const { call, raw } = hosted();
  const audition = await call("live_change", { tool: "live_session_audition_preview", args: { sceneRef: "scene:scene-1", setName: "Disposable Set", outputSafety: { safe: true, provenance: "operator-confirmed-headphones", scope: "master" } } });
  assert.equal(audition.isError, true); assert.match(audition.body.reason, /plays a scene out loud/); assert.match(audition.body.remediation, /live_session_audition_apply/);
  assert.equal((await raw("live_change", { tool: "live_snapshot", args: {} })).error?.code, -32602);
  assert.equal((await raw("live_change", { tool: "live_nothing_preview", args: {} })).error?.code, -32602);
  assert.equal((await raw("live_change", { tool: "live_mixer_preview" })).error?.code, -32602);
  // A preview that refuses answers for itself; nothing is applied.
  const refused = await call("live_change", { tool: "live_mixer_preview", args: { trackRef: "track:none", volume: 0.5 } });
  assert.equal(refused.isError, true); assert.equal(refused.body.change, undefined);
});

test("live_change obeys the tool policy of the tools it runs", async () => {
  const { call } = hosted(new DeterministicLiveSimulator(), { toolPolicy: { profile: "full", deny: ["live_mixer_apply"] } });
  const denied = await call("live_change", { tool: "live_mixer_preview", args: { trackRef: "track:track-1", volume: 0.5 } });
  assert.equal(denied.isError, true); assert.equal(denied.body.reason, "tool-denied-by-deployment-policy");
});

test("over the wire, a fused change costs what its preview and apply cost, in one call", async () => {
  const live = await serveSimulator();
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { call } = hosted(adapter as never);
    const start = live.requests.length;
    const changed = await call("live_change", { tool: "live_mixer_preview", args: { trackRef: "track:track-1", volume: 0.5 } });
    assert.equal(changed.body.state, "applied", JSON.stringify(changed.body));
    const label = (request: { method: string; operation?: string }) => request.method === "invoke" || request.method === "mutate" ? `${request.method} ${request.operation}` : request.method;
    // The track's mixer is read by its ref, alone: no status, no snapshot of its track.
    assert.deepEqual(live.requests.slice(start).map(label), ["discover", "invoke authority.digest", "discover", "mutate mixer.set", "discover"]);
  } finally { await adapter.close(); await live.close(); }
});
