import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { LiveMutationNotDispatchedError } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

// The Remote Script refuses a change before running it (its replay ledger, its fences: ownership, the
// preview's state) and says nothing changed: the adapter reports it as not dispatched, so an undo it
// refuses leaves the change in place, plainly refused, instead of uncertain.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const REFUSALS = [
  "destructive cleanup lacks exact transaction-owned authority",
  "transaction-owned object changed after creation; cleanup refused",
  "transaction-owned structure cleanup must proceed from the highest positional authority",
  "mutation replay authority has been retired",
  "idempotency key conflicts with an executed mutation",
  "Live state changed since the preview",
];

async function wired(mutationPath: "mutate" | "authority" = "mutate") {
  const live = await serveSimulator();
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000, mutationPath });
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const call = async (name: string, args: unknown): Promise<Record<string, any>> => {
    const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    return { ...JSON.parse(answer.result.content[0]!.text), ...(answer.result.isError ? { isError: true } : {}) };
  };
  return { live, adapter, call, close: async () => { await adapter.close(); await live.close(); } };
}

test("each refusal before a change runs reaches the host as not dispatched; any other stays uncertain", async () => {
  for (const mutationPath of ["mutate", "authority"] as const) {
    const { live, adapter, close } = await wired(mutationPath);
    try {
      const set = (await adapter.snapshotAsync(undefined, { parts: ["set"] })).set;
      const rename = (name: string) => adapter.invokeAsync({ operation: "data.set", args: { ref: set.ref, key: "kumi.note", value: name } }, { deadlineMs: Date.now() + 2_000, transactionId: `saved_${name.replace(/\W/g, "")}0`, idempotencyKey: `key-${name.replace(/\W/g, "")}0` });
      for (const [index, reason] of REFUSALS.entries()) {
        live.refuseNext("data.set", `request failed: ${reason}; nothing changed`);
        await assert.rejects(rename(`Refused ${index}`), (error: unknown) => error instanceof LiveMutationNotDispatchedError && error.message.endsWith(`${reason}; nothing changed`), `${mutationPath}: ${reason}`);
      }
      // A reason past the change's start says nothing of the kind: what happened is unknown.
      live.refuseNext("data.set", "request failed: data change was not confirmed");
      await assert.rejects(rename("Unsure"), (error: unknown) => error instanceof Error && !(error instanceof LiveMutationNotDispatchedError));
    } finally { await close(); }
  }
});

test("an undo refused before anything ran leaves the change in place, plainly refused, and a later undo goes", async () => {
  const { live, call, close } = await wired();
  try {
    for (const [index, reason] of REFUSALS.slice(0, 3).entries()) {
      const name = `Made ${index}`;
      const previewed = await call("live_session_structure_preview", { tracks: [{ name, kind: "midi", index: 1 }], scenes: [] });
      const made = await call("live_session_structure_apply", { transactionId: previewed.transactionId, confirmation: previewed.confirmation ?? "apply", idempotencyKey: `made-${index}-key` });
      assert.equal(made.state, "applied", JSON.stringify({ previewed, made }));
      live.refuseNext("track.delete", `request failed: ${reason}; nothing changed`);
      const refused = await call("live_undo", { transactionId: previewed.transactionId, confirmation: "undo", idempotencyKey: `refused-${index}-key` });
      assert.equal(refused.isError, true); assert.match(refused.reason, /^Undo refused before anything changed in Live/, JSON.stringify(refused));
      const names = async () => (await call("live_snapshot", {})).snapshot.tracks.map((track: { name: string }) => track.name);
      assert.ok((await names()).includes(name));
      assert.equal((await call("live_undo", { transactionId: previewed.transactionId, confirmation: "undo", idempotencyKey: `undone-${index}-key` })).state, "undone");
      assert.ok(!(await names()).includes(name));
    }
  } finally { await close(); }
});
