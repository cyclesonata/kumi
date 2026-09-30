import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionState, JsonObject } from "../src/core/contracts.js";
import type { McpEndpoint } from "../src/mcp/client.js";
import { createAbletonIntegration } from "../src/integrations/ableton/index.js";

// Synthetic: like the real bridge, a bridge process that saw Live restart stays "poisoned"
// (remote-bridge-or-live-epoch-changed) and a fresh bridge process connects normally.
function world() {
  let live = true; let epoch = 1;
  const bridges: { poisoned: boolean; closed: boolean }[] = [];
  const catalog: Tool[] = ["server_status", "live_status", "live_discover", "live_snapshot"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));
  const wrap = (value: JsonObject): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const drops: (() => void)[] = [];
  function bridge(): McpEndpoint {
    const own = { poisoned: false, closed: false, epoch };
    bridges.push(own);
    const disconnects = new Set<() => void>();
    // The bridge's own connection breaking (its process ending, say), with Live still open.
    drops.push(() => { own.closed = true; for (const listener of disconnects) listener(); });
    return {
      pid: null, serverInfo: { name: "kumi-synthetic-bridge", version: "1" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
      async list() { return { tools: catalog }; },
      async call(name, args) {
        if (own.closed) throw new Error("closed");
        if (live && own.epoch !== epoch) own.poisoned = true;
        const connected = live && !own.poisoned;
        // Like the real bridge, a failed recovery ends up reported as a failed reconnect.
        if (name === "live_status") return wrap({ connected, adapter: "remote-script", provenance: "fake-live", epoch: connected ? epoch : null, ...(own.poisoned ? { reason: "remote-reconnect-failed" } : {}) });
        if (!connected) return { isError: true, content: [{ type: "text", text: "Live adapter is not connected" }] };
        return wrap({ epoch, kind: args.kind, items: args.kind === "set" ? [{ ref: `${epoch}:set:song`, objectIdentity: `song-${epoch}`, name: "Night Drive" }] : [], revision: "r", truncated: false });
      },
      onCatalogChanged() { return () => {}; },
      onDisconnect(listener) { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
      async close() { own.closed = true; for (const listener of disconnects) listener(); },
    };
  }
  return { bridge, bridges, away: () => { live = false; }, restart: () => { live = true; epoch++; }, drop: () => drops.at(-1)!() };
}

test("after Live restarts, Kumi starts a fresh bridge, keeps the conversation and never needs /new", async () => {
  const w = world();
  const states: ConnectionState[] = [];
  // Live's Remote Script answering on its port is the cue for a fresh bridge.
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "kumi-reconnect-"));
  const bridgeConfig = join(directory, "bridge-config.json");
  writeFileSync(bridgeConfig, JSON.stringify({ bridge: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const integration = createAbletonIntegration({ connect: async () => w.bridge(), bridgeConfig, onConnection: (state) => states.push(state), reconnectIntervalMs: 10 });
  try {
    await integration.start(AbortSignal.timeout(5_000));
    const before = await integration.observe(AbortSignal.timeout(5_000));
    w.away();
    await integration.observe(AbortSignal.timeout(5_000));
    assert.equal(states.at(-1), "disconnected");
    w.restart();
    const deadline = Date.now() + 3_000;
    while (states.at(-1) !== "connected" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(states.at(-1), "connected", "back without /new");
    assert.equal(w.bridges.length, 2, "one fresh bridge process");
    assert.equal(w.bridges[0]!.closed, true, "the old one is closed");
    assert(!states.slice(states.lastIndexOf("disconnected") + 1).includes("disconnected"), "closing the old bridge isn't mistaken for losing Live");
    const after = await integration.observe(AbortSignal.timeout(5_000));
    assert.equal(after.key, before.key, "the same Set continues the conversation");
    const later = await integration.observe(AbortSignal.timeout(5_000));
    assert.equal(later.key, before.key, "on every later turn too");
    assert.equal(JSON.parse(after.context).epoch, 2);
    // The model is told its references from before are gone, once.
    assert.equal(JSON.parse(before.context).reconnected, undefined);
    assert.match(JSON.parse(after.context).reconnected, /reconnected to Live since your last answer, so every reference from earlier answers .* is gone\. Use the ones listed here, or discover again\./);
    assert.equal(JSON.parse(later.context).reconnected, undefined);
  } finally { await integration.close(); server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("when the bridge's own connection drops, Kumi starts a fresh one and carries on", async () => {
  const w = world();
  const states: [ConnectionState, string | undefined][] = [];
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "kumi-reconnect-"));
  const bridgeConfig = join(directory, "bridge-config.json");
  writeFileSync(bridgeConfig, JSON.stringify({ bridge: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const integration = createAbletonIntegration({ connect: async () => w.bridge(), bridgeConfig, onConnection: (state, cause) => states.push([state, cause]), reconnectIntervalMs: 10 });
  try {
    await integration.start(AbortSignal.timeout(5_000));
    const before = await integration.observe(AbortSignal.timeout(5_000));
    w.drop();
    assert.deepEqual(states.at(-1), ["disconnected", "bridge"], "says the link dropped, not that Live closed");
    const deadline = Date.now() + 3_000;
    while (states.at(-1)![0] !== "connected" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(states.at(-1)![0], "connected", "back without /new");
    assert.equal(w.bridges.length, 2, "a fresh bridge");
    const after = await integration.observe(AbortSignal.timeout(5_000));
    assert.equal(after.key, before.key, "the conversation carries on");
    assert.equal(JSON.parse(after.context).epoch, 1, "Live itself never went away");
    assert.ok(JSON.parse(after.context).reconnected, "a fresh bridge has fresh references too");
  } finally { await integration.close(); server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("after Live restarts into a blank Set, the conversation carries on; a different saved Set gets its own", async () => {
  // Live's Set: the same one, then a blank one after a restart. A different saved Set is covered in ableton.test.ts.
  const w = world();
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "kumi-reconnect-"));
  const bridgeConfig = join(directory, "bridge-config.json");
  writeFileSync(bridgeConfig, JSON.stringify({ bridge: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const states: ConnectionState[] = [];
  const integration = createAbletonIntegration({ connect: async () => w.bridge(), bridgeConfig, onConnection: (state) => states.push(state), reconnectIntervalMs: 10 });
  try {
    await integration.start(AbortSignal.timeout(5_000));
    const before = await integration.observe(AbortSignal.timeout(5_000));
    w.away(); await integration.observe(AbortSignal.timeout(5_000));
    w.restart();
    const deadline = Date.now() + 3_000;
    while (states.at(-1) !== "connected" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    // The restarted Live's Set has a new identity (song-2): it's still this conversation.
    assert.equal((await integration.observe(AbortSignal.timeout(5_000))).key, before.key);
  } finally { await integration.close(); server.close(); rmSync(directory, { recursive: true, force: true }); }
});
