import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { connectMcp, bridgeEntry, type McpEndpoint } from "../src/mcp/client.js";
import { AllowedTools } from "../src/mcp/allowed-tools.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
const fixture = fileURLToPath(new URL("../../test/fixtures/mcp-server.mjs", import.meta.url));
const freshSignal = () => new AbortController().signal;
function data(result: CallToolResult) {
  return result.structuredContent ?? JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("")) as Record<string, unknown>;
}
async function open(mode = "normal", timeoutMs = 2_000) {
  // Starting Node on a cold CI runner can take longer than a short request timeout.
  const client = await connectMcp({ entry: fixture, args: [mode], timeoutMs, connectTimeoutMs: Math.max(timeoutMs, 10_000), signal: freshSignal() });
  return { client, tools: new AllowedTools(client) };
}
function running(pid: number | null) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

test("real SDK stdio initialization, bounded pagination and exact four-tool schema intersection", async () => {
  const { client, tools } = await open(); const pid = client.pid;
  try {
    await tools.refresh(freshSignal());
    assert.deepEqual(tools.list().map((tool) => tool.name).sort(), ["live_discover", "live_snapshot", "live_status", "server_status"]);
    assert.deepEqual(tools.list()[0]?.inputSchema, { type: "object", properties: { action: { type: "string" } }, additionalProperties: true });
    const result = await tools.call("live_status", {}, freshSignal());
    assert.equal(data(result).provenance, "synthetic-fixture");
    assert.equal(client.serverInfo?.name, "kumi-synthetic-fixture");
    const generation = tools.generation;
    await tools.refresh(freshSignal()); assert.equal(tools.generation, generation);
  } finally { await tools.close(); await tools.close(); }
  assert(!running(pid));
});

test("unknown and mutation calls never reach the server; fresh call-time catalog gate rejects old tools", async () => {
  const { client, tools } = await open();
  try {
    await tools.refresh(freshSignal());
    for (const name of ["mutation_0", "live_tempo_apply", "tools/call", "new_unsafe_tool"]) await assert.rejects(tools.call(name, {}, freshSignal()), /allowed tool list|not currently available/);
    assert.deepEqual(data(await tools.call("server_status", {}, freshSignal())).calls, ["server_status"]);
    await client.call("server_status", { action: "notify" }, freshSignal());
    await assert.rejects(tools.call("live_snapshot", {}, freshSignal()), /catalog/);
    await tools.refresh(freshSignal());
    assert(!tools.list().some((tool) => tool.name === "live_snapshot"));
    await assert.rejects(tools.call("live_snapshot", {}, freshSignal()), /allowed tool list|not currently available/);
    await assert.rejects(tools.call("new_unsafe_tool", {}, freshSignal()), /allowed tool list|not currently available/);
    assert.deepEqual(data(await tools.call("server_status", {}, freshSignal())).calls, ["server_status", "server_status", "server_status"]);
  } finally { await tools.close(); }
});

test("an answer arriving after its request was cancelled doesn't cost the connection", async () => {
  const { client, tools } = await open();
  let disconnected = false;
  client.onDisconnect(() => { disconnected = true; });
  try {
    await tools.refresh(freshSignal());
    // Live quits mid-request: Kumi stops the turn, and the bridge's answer to it is already on its way.
    await assert.rejects(client.call("server_status", { action: "late" }, AbortSignal.timeout(50)));
    await delay(400);
    assert.equal(disconnected, false, "still connected");
    assert.deepEqual(data(await tools.call("server_status", {}, freshSignal())).fixture, true);
  } finally { await tools.close(); }
});

test("catalog loops, excess tools and duplicates fail closed", async () => {
  for (const mode of ["repeat-cursor", "excessive", "duplicate", "catalog-bytes"]) {
    const { tools } = await open(mode);
    try { await assert.rejects(tools.refresh(freshSignal()), /catalog|cursor|duplicate/i); assert.deepEqual(tools.list(), []); }
    finally { await tools.close(); }
  }
});

test("MCP isError/structured data are preserved; oversized output becomes explicit narrowing error", async () => {
  const { tools } = await open();
  try {
    await tools.refresh(freshSignal());
    const failed = await tools.call("server_status", { action: "error" }, freshSignal());
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent?.reason, "expected-error");
    const large = await tools.call("server_status", { action: "oversized" }, freshSignal());
    assert.equal(large.isError, true); assert.match(JSON.stringify(large), /too large.*narrow/i); assert(Buffer.byteLength(JSON.stringify(large)) < 1024);
  } finally { await tools.close(); }
});

test("timeouts and signal cancellation reach the MCP request and leave the client usable", async () => {
  const { tools } = await open("normal", 150);
  try {
    await tools.refresh(freshSignal());
    await assert.rejects(tools.call("server_status", { action: "delay" }, freshSignal()), /MCP request/);
    const controller = new AbortController();
    const pending = tools.call("server_status", { action: "delay" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending);
    await delay(20);
    assert.equal(data(await tools.call("server_status", {}, freshSignal())).cancelled, 2);
  } finally { await tools.close(); }
});

test("unexpected child exit invalidates catalog and reports disconnected", async () => {
  const { client, tools } = await open();
  try {
    await tools.refresh(freshSignal());
    let disconnected = false; client.onDisconnect(() => { disconnected = true; });
    await assert.rejects(tools.call("server_status", { action: "exit" }, freshSignal()));
    await delay(10);
    assert(disconnected); assert.deepEqual(tools.list(), []);
    await assert.rejects(tools.call("live_status", {}, freshSignal()));
  } finally { await tools.close(); }
});

test("child environment excludes inference credentials and stderr is drained without retaining payloads", async () => {
  const names = ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "KUMI_AUTH_FILE"] as const;
  const saved = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = "fixture-secret-never-copy";
  let endpoint: McpEndpoint | undefined;
  try {
    const { client, tools } = await open("stderr"); endpoint = client;
    await tools.refresh(freshSignal());
    assert.equal(data(await tools.call("server_status", {}, freshSignal())).secretPresent, false);
    assert.equal(client.stderrStatus().truncated, true);
    assert(client.stderrStatus().bytes <= 64 * 1024);
    assert(!JSON.stringify(client.stderrStatus()).includes("secret"));
    await tools.close();
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    await endpoint?.close();
  }
});

test("the bridge is asked to expose exactly Kumi's tools, or only reads when none are named", async () => {
  const readOnly = await open();
  try {
    await readOnly.tools.refresh(freshSignal());
    const status = data(await readOnly.tools.call("server_status", {}, freshSignal()));
    assert.equal(status.toolPolicy, "read-only"); assert.equal(status.toolAllow, null);
  } finally { await readOnly.tools.close(); }
  const client = await connectMcp({ entry: fixture, args: ["normal"], timeoutMs: 2_000, connectTimeoutMs: 10_000, signal: freshSignal(), allowTools: ["live_tempo_apply", "live_status", "live_tempo_preview", "live_status"] });
  const tools = new AllowedTools(client);
  try {
    await tools.refresh(freshSignal());
    const status = data(await tools.call("server_status", {}, freshSignal()));
    assert.equal(status.toolPolicy, "full");
    assert.equal(status.toolAllow, "live_status,live_tempo_apply,live_tempo_preview", "an exact, sorted list without duplicates");
  } finally { await tools.close(); }
});

test("Kumi's own calls may bring back more than the model's 64 KB; the model's stay bounded", async () => {
  const { tools } = await open();
  try {
    await tools.refresh(freshSignal());
    const model = await tools.call("server_status", { action: "oversized" }, freshSignal());
    assert.equal(model.isError, true, "the model's read is refused when too large");
    const host = await tools.call("server_status", { action: "oversized" }, freshSignal(), { host: true });
    assert.notEqual(host.isError, true, "Kumi's own call gets the whole answer (a Set export, a large clip)");
  } finally { await tools.close(); }
});

test("the bridge's word on bad arguments comes back as a tool error; other failures stay generic", async () => {
  const { tools } = await open();
  try {
    await tools.refresh(freshSignal());
    const rejected = await tools.call("server_status", { action: "invalid-params" }, freshSignal());
    assert.equal(rejected.isError, true);
    assert.deepEqual(rejected.content, [{ type: "text", text: "The bridge rejected the arguments: trackRef is required" }]);
  } finally { await tools.close(); }
});

test("bounded SDK shutdown terminates only the owned stubborn child", { timeout: 8_000 }, async () => {
  const sibling = await open();
  try {
    const { client, tools } = await open("stubborn"); const pid = client.pid;
    await tools.close(); await delay(20); assert(!running(pid));
    assert(running(sibling.client.pid)); await sibling.tools.refresh(freshSignal());
    assert.equal(data(await sibling.tools.call("server_status", {}, freshSignal())).fixture, true);
  } finally { await sibling.tools.close(); }
});

test("missing capabilities cannot be called, even under the allowlist", async () => {
  const { tools } = await open("missing");
  try {
    await tools.refresh(freshSignal());
    assert.deepEqual(tools.list().map((tool) => tool.name), ["server_status"]);
    await assert.rejects(tools.call("live_status", {}, freshSignal()), /available/);
  } finally { await tools.close(); }
});

test("oversized protocol frame closes transport and invalidates old descriptors", async () => {
  const { tools } = await open();
  try {
    await tools.refresh(freshSignal());
    await assert.rejects(tools.call("server_status", { action: "frame" }, freshSignal()));
    assert.deepEqual(tools.list(), []);
  } finally { await tools.close(); }
});

test("failed startup closes the owned child; already-aborted startup creates none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kumi-mcp-test-"));
  const pidFile = join(dir, "pid");
  try {
    await assert.rejects(connectMcp({ entry: fixture, args: ["no-init", pidFile], timeoutMs: 200, signal: freshSignal() }), /connection failed/);
    assert(!running(Number(await readFile(pidFile, "utf8"))));
    await rm(pidFile);
    await assert.rejects(connectMcp({ entry: fixture, args: ["no-init", pidFile], signal: AbortSignal.abort() }));
    await assert.rejects(access(pidFile));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("actual built bridge interoperates without config and truthfully reports unavailable Live", async (t) => {
  try { await access(bridgeEntry); }
  catch {
    if (process.env.KUMI_TEST_BRIDGE === "1") throw new Error("Build the standalone bridge before the interoperability check");
    t.skip("Standalone bridge is not built; build it and set KUMI_TEST_BRIDGE=1 for required interoperability verification"); return;
  }
  const cwd = process.cwd();
  let client: McpEndpoint;
  try { process.chdir(tmpdir()); client = await connectMcp({ signal: freshSignal() }); }
  finally { process.chdir(cwd); }
  const tools = new AllowedTools(client);
  try {
    await tools.refresh(freshSignal());
    const status = data(await tools.call("live_status", {}, freshSignal()));
    assert.equal(status.connected, false);
    assert.notEqual(status.provenance, "real-live");
    assert.equal(status.adapter, "unavailable");
    assert(!tools.list().some((tool) => tool.name === "live_discover"));
  } finally { await tools.close(); }
});
