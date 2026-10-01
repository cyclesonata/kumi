import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type AsyncLiveAdapter, type LiveDiscoveryRequest, type LiveInvocation } from "../src/live.js";

// A parameter, mixer or rename change reads what it touches, by its ref: the parameter with its device's
// and track's identities, the track's mixer, the track's or scene's name. No snapshot (the track whole,
// every other track light), no get of a whole track, no other parameter of the device; the change stays
// fenced on each object's identity at its place, its values, and the digest of what it names.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
type Body = Record<string, any>;
type Seen = { method: string; request?: LiveDiscoveryRequest; invocation?: LiveInvocation };

function watched(simulator: DeterministicLiveSimulator) {
  const seen: Seen[] = [];
  const adapter = Object.assign(Object.create(simulator), {
    snapshotAsync: async (...args: Parameters<DeterministicLiveSimulator["snapshotAsync"]>) => { seen.push({ method: "snapshot" }); return simulator.snapshotAsync(...args); },
    getAsync: async (reference: string) => { seen.push({ method: "get" }); return simulator.getAsync(reference as never); },
    discoverAsync: async (request: LiveDiscoveryRequest) => { seen.push({ method: "discover", request }); return simulator.discoverAsync(request); },
    invokeAsync: async (invocation: LiveInvocation) => { seen.push({ method: "invoke", invocation }); return simulator.invokeAsync(invocation); },
  }) as AsyncLiveAdapter;
  return { adapter, seen };
}

function hosted(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100; let keys = 0;
  const call = async (name: string, args: unknown): Promise<Body> => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any; assert.ok(answer.result, JSON.stringify(answer.error)); return { ...JSON.parse(answer.result.content[0].text), ...(answer.result.isError ? { isError: true } : {}) }; };
  const apply = (tool: string, previewed: Body) => call(tool, { transactionId: previewed.transactionId, confirmation: previewed.confirmation ?? "apply", idempotencyKey: `one-object-${++keys}` });
  const undo = (transactionId: string) => call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: `one-object-undo-${++keys}` });
  return { call, apply, undo };
}

const state = (simulator: DeterministicLiveSimulator) => (simulator as unknown as { state: { tracks: Array<Record<string, any>>; scenes: Array<Record<string, any>> } }).state;

function bigSet(): DeterministicLiveSimulator {
  const simulator = new DeterministicLiveSimulator(); const tracks = state(simulator).tracks;
  tracks[0]!.devices[0].parameters.push({ ref: "parameter:width-1", objectIdentity: "simulator:parameter:width-1", name: "Width", value: 1, min: 0, max: 4, automatable: true, quantization: 0, enabled: true, revision: 1 });
  for (let index = 2; index <= 12; index += 1) tracks.push({ ...structuredClone(tracks[0]), ref: `track:track-${index}`, objectIdentity: `simulator:track:track-${index}`, name: `Track ${index}`, clips: [], clipSlots: [], devices: [] });
  return simulator;
}

test("a parameter, mixer or rename change reads what it touches, by its ref: no snapshot, no whole track, no other parameter", async () => {
  const simulator = bigSet(); const { adapter, seen } = watched(simulator);
  const { call, apply, undo } = hosted(adapter);
  const families: Array<[string, string, Record<string, unknown>, string]> = [
    ["parameter", "live_device_parameter_preview", { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.25 }, "live_device_parameter_apply"],
    ["parameters", "live_device_parameter_preview", { deviceRef: "device:utility-1", values: [{ parameterRef: "parameter:gain-1", value: 0.3 }, { parameterRef: "parameter:width-1", value: 2 }] }, "live_device_parameter_apply"],
    ["mixer", "live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 }, "live_mixer_apply"],
    ["track rename", "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "Beats" }, "live_object_rename_apply"],
    ["scene rename", "live_object_rename_preview", { kind: "scene", ref: "scene:scene-1", name: "Verse" }, "live_object_rename_apply"],
  ];
  for (const [label, preview, args, applyTool] of families) {
    seen.length = 0;
    const previewed = await call(preview, args); assert.ok(previewed.transactionId, `${label}: ${JSON.stringify(previewed)}`);
    assert.equal((await apply(applyTool, previewed)).state, "applied", label);
    assert.equal((await undo(previewed.transactionId)).state, "undone", label);
    const reads = seen.filter((item) => item.method !== "invoke");
    assert.deepEqual(reads.filter((item) => item.method !== "discover").map((item) => item.method), [], `${label} reads no snapshot and no whole row`);
    for (const { request } of reads) {
      assert.deepEqual(Object.keys(request!.filter ?? {}), ["ref"], `${label} discovers one object by its ref`);
      assert.equal(request!.limit, 1, label);
    }
    const discovered = new Set(reads.map(({ request }) => request!.filter!.ref));
    assert.ok(!discovered.has("parameter:width-1") || label === "parameters", `${label} reads no parameter it doesn't change`);
    // Fenced on the parameter, its device and its track, each by identity: no sibling parameter named.
    for (const { invocation } of seen.filter((item) => item.invocation?.operation === "device.parameter.set" || item.invocation?.operation === "device.parameters.set")) assert.deepEqual(invocation!.args.expectedSiblings, [], label);
  }
});

test("a parameter change stays fenced on its device and its track: another device at the place since the preview is refused", async () => {
  const simulator = bigSet(); const { adapter, seen } = watched(simulator); const { call, apply } = hosted(adapter);
  const previewed = await call("live_device_parameter_preview", { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.25 });
  assert.equal(previewed.device.name, "Utility"); assert.equal(previewed.device.trackRef, "track:track-1"); assert.equal(previewed.parameter.currentValue, 0.5);
  state(simulator).tracks[0]!.devices[0].objectIdentity = "simulator:device:another-utility";
  const refused = await apply("live_device_parameter_apply", previewed);
  assert.equal(refused.isError, true); assert.match(refused.reason, /identity or value changed since preview/);
  assert.equal(seen.some((item) => item.invocation?.operation === "device.parameter.set"), false, "refused before anything was sent");
  assert.equal(state(simulator).tracks[0]!.devices[0].parameters[0].value, 0.5, "nothing changed");
  // A rename's name changed by hand since its preview: refused, and the hand-made name stays.
  const renamed = await call("live_object_rename_preview", { kind: "track", ref: "track:track-2", name: "Bass" });
  state(simulator).tracks[1]!.name = "By hand";
  assert.equal((await apply("live_object_rename_apply", renamed)).isError, true); assert.equal(state(simulator).tracks[1]!.name, "By hand");
});

test("a change on many parameters reads their device's list, a page at a time, not one request each", async () => {
  const simulator = new DeterministicLiveSimulator(); const device = state(simulator).tracks[0]!.devices[0];
  for (let index = 0; index < 40; index += 1) device.parameters.push({ ref: `parameter:knob-${index}`, objectIdentity: `simulator:parameter:knob-${index}`, name: `Knob ${index}`, value: 0, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 });
  const { adapter, seen } = watched(simulator); const { call, apply, undo } = hosted(adapter);
  const knob = (index: number) => device.parameters.find((parameter: Record<string, unknown>) => parameter.ref === `parameter:knob-${index}`);
  const previewed = await call("live_device_parameter_preview", { deviceRef: "device:utility-1", values: Array.from({ length: 30 }, (_, index) => ({ parameterRef: `parameter:knob-${index}`, value: 0.5 })) });
  assert.ok(previewed.transactionId, JSON.stringify(previewed));
  assert.equal((await apply("live_device_parameter_apply", previewed)).state, "applied"); assert.equal(knob(29).value, 0.5);
  assert.equal((await undo(previewed.transactionId)).state, "undone"); assert.equal(knob(29).value, 0);
  // The preview, the apply's check and confirmation, the undo's check and confirmation: the device's list once each.
  const lists = seen.filter((item) => item.method === "discover" && item.request!.kind === "parameter");
  assert.equal(lists.length, 5);
  for (const { request } of lists) { assert.equal(request!.parent, "device:utility-1"); assert.equal(request!.filter, undefined); }
});
