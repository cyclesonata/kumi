import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORITY_FREE_INVOKES, RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveInvocation } from "../src/live.js";
import { type ToolPolicyProfile } from "../src/tool-catalog.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

class PythonReplyLive extends DeterministicLiveSimulator {
  reply: Record<string, unknown> = { ok: true, result: null, stdout: "", error: null };
  override async invokeAsync(invocation: LiveInvocation): Promise<unknown> {
    return invocation.operation === "python.run" ? structuredClone(this.reply) : super.invokeAsync(invocation);
  }
}

function hosted(adapter: RemoteScriptLiveAdapter, profile: ToolPolicyProfile = "full") {
  const host = new McpHost(adapter, { toolPolicy: { profile } });
  host.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 2;
  const request = (args: unknown) => ({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "live_run_python", arguments: args } });
  const call = async (args: unknown) => await host.handleAsync(request(args)) as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number; message: string } };
  const listed = () => (host.handle({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  return { host, request, call, listed };
}

test("Python eval/exec results and stdout cross the host wire with no authority or transaction undo", async () => {
  const simulator = new PythonReplyLive();
  const live = await serveSimulator(simulator, ["python.run"]);
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { host, request, call, listed } = hosted(adapter);
    assert.ok(listed().includes("live_run_python"));
    assert.ok(AUTHORITY_FREE_INVOKES.has("python.run"));
    assert.equal((host.handle(request({ code: "1 + 1", mode: "eval" })) as { error: { code: number } }).error.code, -32001);
    simulator.reply = { ok: true, result: [2, true, null, { ref: "1:track:0", type: "Track", name: "Bass" }], stdout: "", error: null };
    const evaluated = await call({ code: "(2, True, None, song.tracks[0])", mode: "eval", ref: "1:track:0", timeoutMs: 30000 });
    assert.equal(evaluated.result?.isError, false);
    assert.deepEqual(JSON.parse(evaluated.result!.content[0]!.text), simulator.reply);
    simulator.reply = { ok: true, result: { renamed: true }, stdout: "renamed\n", error: null };
    const executed = await call({ code: "print('renamed'); result = {'renamed': True}" });
    assert.deepEqual(JSON.parse(executed.result!.content[0]!.text), simulator.reply);
    assert.deepEqual(live.requests.filter((row) => row.operation === "python.run"), [
      { method: "invoke", operation: "python.run", args: { code: "(2, True, None, song.tracks[0])", mode: "eval", ref: "1:track:0", timeoutMs: 30000 } },
      { method: "invoke", operation: "python.run", args: { code: "print('renamed'); result = {'renamed': True}", mode: "exec", timeoutMs: 5000 } },
    ]);
    assert.equal(live.requests.some((row) => ["prepare", "preflight", "mutate", "retire"].includes(row.method)), false);
  } finally { await adapter.close(); await live.close(); }
});

test("Python errors and timeouts stay JSON data and leave the wire usable", async () => {
  const simulator = new PythonReplyLive();
  const live = await serveSimulator(simulator, ["python.run"]);
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { call } = hosted(adapter);
    for (const type of ["ValueError", "SystemExit", "TimeoutError"]) {
      simulator.reply = { ok: false, result: null, stdout: "before failure\n", error: { type, message: "stopped", traceback: `Traceback\n${type}: stopped` } };
      const answer = await call({ code: "raise SystemExit('stopped')", timeoutMs: 10 });
      assert.equal(answer.result?.isError, false, "a script failure is returned by the operation as data");
      assert.deepEqual(JSON.parse(answer.result!.content[0]!.text), simulator.reply);
    }
    simulator.reply = { ok: true, result: 42, stdout: "", error: null };
    assert.equal(JSON.parse((await call({ code: "42", mode: "eval" })).result!.content[0]!.text).result, 42);
  } finally { await adapter.close(); await live.close(); }
});

test("Python host arguments are validated before dispatch", async () => {
  const live = await serveSimulator(new PythonReplyLive(), ["python.run"]);
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { call } = hosted(adapter);
    for (const args of [{}, { code: "" }, { code: "x".repeat(65537) }, { code: "1", mode: "other" }, { code: "1", ref: "" }, { code: "1", timeoutMs: 0 }, { code: "1", timeoutMs: 30001 }, { code: "1", timeoutMs: 1.5 }, { code: "1", timeoutMs: true }, { code: "1", extra: true }]) {
      assert.equal((await call(args)).error?.code, -32602);
    }
    assert.equal(live.requests.some((row) => row.operation === "python.run"), false);
  } finally { await adapter.close(); await live.close(); }
});

test("Python is listed only when negotiated and allowed by the deployment profile", async () => {
  const live = await serveSimulator(new PythonReplyLive(), ["python.run"]);
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    assert.ok(hosted(adapter).listed().includes("live_run_python"));
    for (const profile of ["read-only", "edit-no-audio", "performance"] as const) {
      const host = hosted(adapter, profile);
      assert.equal(host.listed().includes("live_run_python"), false);
      assert.equal((await host.call({ code: "1", mode: "eval" })).result?.isError, true);
    }
    assert.equal(live.requests.some((row) => row.operation === "python.run"), false);
  } finally { await adapter.close(); await live.close(); }
  const unavailable = await serveSimulator();
  const older = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: unavailable.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try { assert.equal(hosted(older).listed().includes("live_run_python"), false); }
  finally { await older.close(); await unavailable.close(); }
});
