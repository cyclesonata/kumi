import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExtensionChannel, readExtensionEndpoint } from "../src/bridge/extension-channel.js";
import { RemoteScriptLiveAdapter } from "../src/bridge/remote-adapter.js";
import { routedAdapter } from "../src/bridge/router.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, EXTENSION_OPERATIONS, LIVE_EVENT_TYPES, LIVE_OPERATIONS, REMOTE_SCRIPT_EVENT_TYPES, type AsyncLiveAdapter } from "../src/live.js";
import { serveSimulator, WIRE_SECRET } from "./helpers/wire-live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const registry = JSON.parse(readFileSync(join(repository, "protocol", "ableton-live-v1.operations.json"), "utf8")) as { operations: Array<{ id: string; method: string; request: { properties?: Record<string, { items?: { enum?: string[] } }> } }> };

/** A host whose notifications land in `sent`. */
function listening(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  const sent: Array<{ method: string; params: Record<string, any> }> = [];
  host.setEventEmitter(async (line) => { sent.push(JSON.parse(line)); });
  let id = 100;
  const call = async (name: string, args: unknown) => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result: { isError: boolean; content: Array<{ text: string }> } }; return { isError: answer.result.isError, body: JSON.parse(answer.result.content[0]!.text) as Record<string, any> }; };
  const events = () => sent.filter((frame) => frame.method === "notifications/live_event").map((frame) => frame.params);
  return { host, call, events };
}
async function until<T>(check: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test("every registry operation and every subscribable event type is in the bridge's own lists", () => {
  const invokes = registry.operations.filter((operation) => operation.method === "invoke").map((operation) => operation.id);
  assert.deepEqual(invokes.filter((operation) => !(LIVE_OPERATIONS as readonly string[]).includes(operation)), []);
  const subscribe = registry.operations.find((operation) => operation.id === "subscribe")!;
  assert.deepEqual([...REMOTE_SCRIPT_EVENT_TYPES].sort(), [...(subscribe.request.properties!.types!.items!.enum ?? [])].sort());
  assert.ok((LIVE_EVENT_TYPES as readonly string[]).includes("pointed"));
});

test("the Remote Script's new events reach Kumi as notifications/live_event, on the remote-script channel", async () => {
  const live = await serveSimulator();
  const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: live.port, secret: WIRE_SECRET, timeoutMs: 2_000 });
  try {
    const { call, events } = listening(adapter);
    const subscribed = await call("live_subscribe", { types: [...REMOTE_SCRIPT_EVENT_TYPES] });
    assert.equal(subscribed.body.subscribed, true, JSON.stringify(subscribed.body));
    assert.deepEqual(live.requests.filter((request) => request.method === "subscribe").at(-1)!.args, { types: [...REMOTE_SCRIPT_EVENT_TYPES] });
    const pushed = [
      { type: "selection" as const, payload: { selectedTrack: "1:track:0" } },
      { type: "mixer" as const, ref: "1:track:0", payload: { field: "volume", value: 0.5 } },
      { type: "name" as const, ref: "1:scene:1", payload: { field: "name", value: "Drop" } },
      { type: "parameter" as const, ref: "1:parameter:1:device:0:0:3", payload: { value: 0.25 } },
      { type: "structure" as const, ref: "1:track:0", payload: { what: "devices" } },
    ];
    for (const event of pushed) live.push(event as never);
    const seen = await until(() => events().length >= pushed.length ? events() : undefined);
    assert.deepEqual(seen.map((event) => [event.channel, event.type, event.ref ?? null, event.sequence]), pushed.map((event, index) => ["remote-script", event.type, event.ref ?? null, index + 1]));
    assert.deepEqual(seen[1]!.payload, { field: "volume", value: 0.5 });
  } finally { await adapter.close(); await live.close(); }
});

// Kumi's Live extension, committed, against its fake Live: a right-click reaches Kumi as a pointed event.
const extensionDir = join(repository, "apps", "live-extension");
let root: string; let storage: string; let live: Record<string, any>;
let extension: { activate(activation: unknown): void; deactivate(): Promise<void> };
before(async () => {
  root = mkdtempSync(join(tmpdir(), "live-events-")); storage = join(root, "storage");
  const { fakeLive } = await import(pathToFileURL(join(extensionDir, "test", "fake-live.mjs")).href) as { fakeLive(options: Record<string, string>): { activation: unknown; model: Record<string, any> } };
  const fake = fakeLive({ storage, temp: join(root, "temp"), liveTemp: join(root, "live-temp") }); live = fake.model;
  extension = createRequire(import.meta.url)(join(extensionDir, "dist", "extension.js")) as typeof extension;
  extension.activate(fake.activation);
  await until(() => readExtensionEndpoint(storage));
});
after(async () => { await extension.deactivate(); rmSync(root, { recursive: true, force: true }); });

test("a right-click in Live reaches Kumi as a pointed event on the extension channel, with the Remote Script reference of what it names", async () => {
  const simulator = new DeterministicLiveSimulator();
  const lom = Object.create(simulator) as DeterministicLiveSimulator;
  lom.status = () => { const status = simulator.status(); return { ...status, operations: (status.operations ?? []).filter((operation) => !(EXTENSION_OPERATIONS as readonly string[]).includes(operation)) }; };
  const channel = new ExtensionChannel({ storageDirectory: storage });
  assert.equal(await channel.connect(), true);
  const { events } = listening(routedAdapter(lom as unknown as AsyncLiveAdapter, channel));
  (live.commands as Map<string, (argument: unknown) => void>).get("kumi.point")!((live.handle as (object: unknown) => unknown)(live.vox));
  const pointed = await until(() => events().find((event) => event.type === "pointed"));
  assert.equal(pointed.channel, "extension");
  assert.deepEqual([pointed.payload.kind, pointed.payload.path, pointed.payload.name, pointed.payload.ref], ["track", [2], "Vox", `${simulator.status().epoch}:track:2`]);
  // The simulator's own events come through the router too, tagged as the Remote Script's.
  simulator.invoke({ operation: "undo.step.begin", args: {} });
  simulator.invoke({ operation: "song.undo", args: {} });
  const reset = await until(() => events().find((event) => event.type === "reset"));
  assert.equal(reset.channel, "remote-script");
  await channel.close();
});
