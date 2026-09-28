import assert from "node:assert/strict";
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
  function bridge(): McpEndpoint {
    const own = { poisoned: false, closed: false, epoch };
    bridges.push(own);
    const disconnects = new Set<() => void>();
    return {
      pid: null, serverInfo: { name: "kumi-synthetic-bridge", version: "1" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
      async list() { return { tools: catalog }; },
      async call(name, args) {
        if (own.closed) throw new Error("closed");
        if (live && own.epoch !== epoch) own.poisoned = true;
        const connected = live && !own.poisoned;
        if (name === "live_status") return wrap({ connected, adapter: "remote-script", provenance: "fake-live", epoch: connected ? epoch : null, ...(own.poisoned ? { reason: "remote-bridge-or-live-epoch-changed" } : {}) });
        if (!connected) return { isError: true, content: [{ type: "text", text: "Live adapter is not connected" }] };
        return wrap({ epoch, kind: args.kind, items: args.kind === "set" ? [{ ref: `${epoch}:set:song`, objectIdentity: `song-${epoch}`, name: "Night Drive" }] : [], revision: "r", truncated: false });
      },
      onCatalogChanged() { return () => {}; },
      onDisconnect(listener) { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
      async close() { own.closed = true; for (const listener of disconnects) listener(); },
    };
  }
  return { bridge, bridges, away: () => { live = false; }, restart: () => { live = true; epoch++; } };
}

test("after Live restarts, Kumi starts a fresh bridge, keeps the conversation and never needs /new", async () => {
  const w = world();
  const states: ConnectionState[] = [];
  const integration = createAbletonIntegration({ connect: async () => w.bridge(), onConnection: (state) => states.push(state), reconnectIntervalMs: 10 });
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
    assert.equal((await integration.observe(AbortSignal.timeout(5_000))).key, before.key, "on every later turn too");
    assert.equal(JSON.parse(after.context).epoch, 2);
  } finally { await integration.close(); }
});
