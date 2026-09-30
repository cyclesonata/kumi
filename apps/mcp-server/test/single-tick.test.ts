import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LiveMutationNotDispatchedError } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

async function wired(mutationPath: "mutate" | "authority", retireAfter?: number) {
  const simulator = new DeterministicLiveSimulator();
  const live = await serveSimulator(simulator);
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000, mutationPath, ...(retireAfter ? { retireAfter } : {}) });
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 10;
  const call = async (name: string, args: unknown) => {
    const response = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
    assert.ok(response.result, JSON.stringify(response.error)); return { isError: response.result.isError, body: JSON.parse(response.result.content[0]!.text) as Record<string, unknown> };
  };
  return { simulator, live, adapter, host, call, close: async () => { await adapter.close(); await live.close(); } };
}

/** The requests one mixer change costs: its preview, then its apply. */
async function mixerChange(mutationPath: "mutate" | "authority") {
  const wire = await wired(mutationPath);
  try {
    const start = wire.live.requests.length;
    const preview = await wire.call("live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 });
    assert.equal(preview.isError, false, JSON.stringify(preview.body));
    const previewed = wire.live.requests.length;
    const applied = await wire.call("live_mixer_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: "mixer-change-key" });
    assert.equal(applied.isError, false, JSON.stringify(applied.body));
    assert.equal((wire.simulator.snapshot().tracks[0]!.mixer as { volume: number }).volume, 0.5);
    const label = (request: { method: string; operation?: string }) => request.method === "invoke" || request.method === "mutate" ? `${request.method} ${request.operation}` : request.method;
    return { preview: wire.live.requests.slice(start, previewed).map(label), apply: wire.live.requests.slice(previewed).map(label), requests: wire.live.requests.slice(start) };
  } finally { await wire.close(); }
}

test("one change is one mutate request carrying the preview's state digest, instead of preflight, prepare, invoke and retire", async () => {
  const before = await mixerChange("authority");
  const after = await mixerChange("mutate");
  // Before: the preview reads; the apply reads, mints authority twice, invokes, verifies and retires.
  assert.deepEqual(before.preview, ["status", "snapshot"]);
  assert.deepEqual(before.apply, ["snapshot", "preflight", "prepare", "invoke mixer.set", "snapshot", "retire"]);
  // After: the preview also asks for the change's state digest; the apply sends it with one mutate.
  assert.deepEqual(after.preview.filter((label) => label !== "invoke authority.digest"), ["status", "snapshot"]);
  assert.deepEqual([...after.preview, ...after.apply].filter((label) => label === "invoke authority.digest"), ["invoke authority.digest"]);
  assert.deepEqual(after.apply.filter((label) => label !== "invoke authority.digest"), ["snapshot", "mutate mixer.set", "snapshot"]);
  assert.equal(before.requests.length, 8); assert.equal(after.requests.length, 6);
  const digest = after.requests.find((request) => request.method === "invoke" && request.operation === "authority.digest")!;
  const mutate = after.requests.find((request) => request.method === "mutate")!;
  assert.match(mutate.stateDigest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual((digest.args as { operation: string }).operation, "mixer.set");
});

test("a change is refused unrun when what it depends on changed since the preview", async () => {
  const wire = await wired("mutate");
  try {
    const preview = await wire.call("live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 });
    // The digest is taken as the preview ends; then the producer turns the track's pan.
    await new Promise((resolve) => setTimeout(resolve, 50));
    (wire.simulator as unknown as { state: { tracks: Array<{ mixer: { pan: number } }> } }).state.tracks[0]!.mixer.pan = -0.5;
    const refused = await wire.call("live_mixer_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: "mixer-refused-key" });
    assert.equal(refused.isError, true);
    assert.equal((wire.simulator.snapshot().tracks[0]!.mixer as { volume: number }).volume, 0.85, "nothing reached Live");
    assert.equal(wire.live.requests.filter((request) => request.method === "mutate").length, 0, "the host's own fence refused it first");
  } finally { await wire.close(); }
});

test("the adapter sends a mutate with the digest a preview asked for, once, and says a stale one never ran", async () => {
  const wire = await wired("mutate");
  try {
    const adapter = wire.adapter;
    assert.equal(adapter.retiresOnItsOwn, true);
    // A preview's arguments, as the host retains them (the host asks for the digest as the preview ends).
    const previewed = async (volume: number) => {
      const preview = await wire.call("live_mixer_preview", { trackRef: "track:track-1", volume }); const transactionId = String(preview.body.transactionId);
      return { transactionId, invocation: { operation: "mixer.set" as const, args: (wire.host as unknown as { clipLifecycleTransactions: Map<string, { payload: Record<string, unknown> }> }).clipLifecycleTransactions.get(transactionId)!.payload } };
    };
    const context = (key: string, transactionId: string) => ({ deadlineMs: Date.now() + 2_000, idempotencyKey: key, transactionId });
    const mutates = () => wire.live.requests.filter((request) => request.method === "mutate");
    const first = await previewed(0.5);
    await adapter.invokeAsync(first.invocation, context("first-change", first.transactionId));
    assert.match(mutates()[0]!.stateDigest!, /^[a-f0-9]{64}$/);
    assert.equal(mutates()[0]!.transactionId, first.transactionId);
    // A retried change gets the reply the Remote Script recorded, not a second change; the digest went with the first.
    await adapter.invokeAsync(first.invocation, context("first-change", first.transactionId));
    assert.equal(mutates()[1]!.stateDigest, undefined); assert.equal(mutates()[1]!.idempotencyKey, mutates()[0]!.idempotencyKey);
    // A digest asked for other references isn't sent with this change.
    const second = await previewed(0.6);
    adapter.expectStateDigest("elsewhere-transaction", { operation: "mixer.set", args: { ref: "track:elsewhere" } });
    await adapter.invokeAsync(second.invocation, context("second-change", "elsewhere-transaction"));
    assert.equal(mutates()[2]!.stateDigest, undefined);
    // A digest from before a change elsewhere on the track is refused before anything runs.
    const third = await previewed(0.8);
    await new Promise((resolve) => setTimeout(resolve, 20));
    (wire.simulator as unknown as { state: { tracks: Array<{ mixer: { pan: number } }> } }).state.tracks[0]!.mixer.pan = 0.25;
    await assert.rejects(adapter.invokeAsync(third.invocation, context("stale-change", third.transactionId)), (error: unknown) => error instanceof LiveMutationNotDispatchedError && /changed since the preview/.test(error.message));
    assert.equal((wire.simulator.snapshot().tracks[0]!.mixer as { volume: number }).volume, 0.6);
  } finally { await wire.close(); }
});

test("changed transactions are retired in the background, oldest first, once past the bound", async () => {
  const wire = await wired("mutate", 2);
  try {
    const applied: string[] = [];
    for (const [index, volume] of [0.1, 0.2, 0.3].entries()) {
      const preview = await wire.call("live_mixer_preview", { trackRef: "track:track-1", volume });
      assert.equal((await wire.call("live_mixer_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: `retire-key-${index}` })).isError, false);
      applied.push(String(preview.body.transactionId));
    }
    const deadline = Date.now() + 2_000;
    while (wire.live.requests.filter((request) => request.method === "retire").length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(wire.live.requests.filter((request) => request.method === "retire").map((request) => request.transactionId), applied.slice(0, 2));
    // With the older chain the host retires after each change, as before.
    const older = await wired("authority");
    try { assert.equal(older.adapter.retiresOnItsOwn, false); } finally { await older.close(); }
  } finally { await wire.close(); }
});
