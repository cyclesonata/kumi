import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION, serve } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function hosted(adapter: ConstructorParameters<typeof McpHost>[0] = new DeterministicLiveSimulator()) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const raw = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as Promise<{ result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number } }>;
  const call = async (name: string, args: unknown) => { const answer = await raw(name, args); assert.ok(answer.result, JSON.stringify(answer.error)); return { isError: answer.result.isError, body: JSON.parse(answer.result.content[0]!.text) as Record<string, any> }; };
  return { host, raw, call };
}

test("a plan's changes go in one Live undo step: it opens, a second opening closes the first, and it closes by its id", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, raw } = hosted(simulator);
  const first = await call("live_undo_step_begin", { label: "Kumi: brighter drums", timeoutMs: 60_000 });
  assert.equal(first.body.open, true); assert.equal(first.body.closedPrevious, false); assert.equal(simulator.undoStep?.stepId, first.body.stepId);
  const second = await call("live_undo_step_begin", {});
  assert.equal(second.body.closedPrevious, true); assert.deepEqual(simulator.closedUndoSteps, [first.body.stepId]);
  const other = await call("live_undo_step_end", { stepId: first.body.stepId });
  assert.deepEqual([other.body.closed, other.body.reason, other.body.stepId], [false, "other-step", second.body.stepId]);
  const ended = await call("live_undo_step_end", { stepId: second.body.stepId });
  assert.deepEqual([ended.body.closed, ended.body.reason], [true, "ended"]); assert.equal(simulator.undoStep, undefined);
  assert.equal((await call("live_undo_step_end", {})).body.reason, "not-open");
  assert.equal((await raw("live_undo_step_begin", { timeoutMs: 10 })).error?.code, -32602);
  assert.equal((await raw("live_undo_step_end", { stepId: "short" })).error?.code, -32602);
});

test("Live's own undo and redo move Live's history once per key, and say what's left", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, raw } = hosted(simulator);
  assert.equal((await raw("live_song_undo", { confirmation: "undo", idempotencyKey: "live-undo-key" })).error?.code, -32602, "the confirmation says it's Live's history");
  const undone = await call("live_song_undo", { confirmation: "undo-in-live", idempotencyKey: "live-undo-key" });
  assert.deepEqual([undone.body.done, undone.body.canUndo, undone.body.canRedo, undone.body.idempotent], [true, false, true, false]);
  const retried = await call("live_song_undo", { confirmation: "undo-in-live", idempotencyKey: "live-undo-key" });
  assert.deepEqual([retried.body.done, retried.body.idempotent], [true, true]); assert.deepEqual(simulator.liveHistory, { undo: 0, redo: 1 });
  assert.equal((await call("live_song_undo", { confirmation: "undo-in-live", idempotencyKey: "live-undo-again" })).body.done, false, "nothing left to undo");
  const redone = await call("live_song_redo", { confirmation: "redo-in-live", idempotencyKey: "live-redo-key" });
  assert.deepEqual([redone.body.operation, redone.body.done, redone.body.canUndo], ["song.redo", true, true]);
});

test("when the client goes, the bridge closes the undo step it left open", async () => {
  const simulator = new DeterministicLiveSimulator();
  const input = new PassThrough(); const output = new PassThrough(); const diagnostics = new PassThrough();
  const frames: Array<Record<string, any>> = []; let buffered = "";
  const opened = new Promise<void>((resolve) => output.on("data", (chunk) => {
    buffered += String(chunk);
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) { frames.push(JSON.parse(buffered.slice(0, newline))); buffered = buffered.slice(newline + 1); }
    if (frames.some((frame) => frame.id === 2)) resolve();
  }));
  const run = serve(input, output, diagnostics, simulator);
  input.write(`${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_undo_step_begin", arguments: {} } })}\n`);
  await opened;
  const stepId = JSON.parse(frames.find((frame) => frame.id === 2)!.result.content[0].text).stepId as string;
  assert.equal(simulator.undoStep?.stepId, stepId);
  input.end(); await run;
  assert.equal(simulator.undoStep, undefined); assert.deepEqual(simulator.closedUndoSteps, [stepId]);
});

test("over the wire, undo steps are plain invokes the connection owns, and Live's undo is one mutate", async () => {
  const live = await serveSimulator();
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { call } = hosted(adapter);
    const start = live.requests.length;
    await call("live_undo_step_begin", {}); await call("live_undo_step_end", {});
    await call("live_song_undo", { confirmation: "undo-in-live", idempotencyKey: "wire-undo-key" });
    const sent = live.requests.slice(start).filter((request) => request.operation !== undefined).map((request) => `${request.method} ${request.operation}`);
    assert.deepEqual(sent, ["invoke undo.step.begin", "invoke undo.step.end", "mutate song.undo"]);
  } finally { await adapter.close(); await live.close(); }
});
