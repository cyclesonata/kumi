import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { DeterministicLiveSimulator, LIVE_REGISTRY_HASH, liveCapabilitiesForOperations, type LiveDiscoveryKind, type LiveEvent, type LiveInvocation } from "../../src/live.js";

// The simulator served over the Remote Script's wire (signed hello, signed answers by id, the methods
// the bridge sends), so a host reaches it through RemoteScriptLiveAdapter exactly as it reaches Live,
// and a test can count the requests one change costs.

export const WIRE_SECRET = "0123456789abcdef0123456789abcdef";
const BRIDGE_EPOCH = "wire-bridge-epoch-0123456789";
const CHALLENGE = "wire-connection-challenge-0123456789";
const REGISTRY_PATHS = ["../../../../protocol/ableton-live-v1.operations.json", "../../../../../protocol/ableton-live-v1.operations.json"];
const registry = JSON.parse(readFileSync(REGISTRY_PATHS.map((path) => fileURLToPath(new URL(path, import.meta.url))).find((path) => { try { readFileSync(path); return true; } catch { return false; } })!, "utf8")) as { operations: Array<{ id: string; method: string; result: { properties?: Record<string, unknown> } }> };
const SNAPSHOT_KEYS = new Set(Object.keys(registry.operations.find((operation) => operation.id === "snapshot")!.result.properties ?? {}));
/** What each operation's result may hold, where the registry closes it: the simulator's results carry more (whole rows). */
const RESULT_KEYS = new Map(registry.operations.filter((operation) => (operation.result as { additionalProperties?: unknown }).additionalProperties === false && operation.result.properties).map((operation) => [operation.id, new Set(Object.keys(operation.result.properties!))]));
const CREATIONS = new Set(["track.create", "track.create-return", "track.duplicate", "scene.create", "scene.duplicate", "clip.create", "clip.duplicate", "arrangement.clip.create", "arrangement.audio-clip.create", "session.audio-clip.create", "browser.load", "device.insert", "session.capture-midi", "scene.capture", "locator.add"]);
const WIRE_KINDS: Record<string, LiveDiscoveryKind> = { set: "set", track: "track", return_track: "return-track", main_track: "main-track", scene: "scene", clip_slot: "clip-slot", session_clip: "session-clip", arrangement_clip: "arrangement-clip", note: "note", locator: "locator", device: "device", parameter: "parameter", selection: "selection", routing_choice: "routing-choice" };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
};
function answer(id: string, value: unknown, ok = true): string {
  const base = { version: "ableton-loopback/v1", id, ok, bridgeEpoch: BRIDGE_EPOCH, connectionChallenge: CHALLENGE, ...(ok ? { result: value } : { error: String(value) }) };
  return `${JSON.stringify({ ...base, mac: createHmac("sha256", WIRE_SECRET).update(canonical(base)).digest("base64url") })}\n`;
}
function references(value: unknown, key = "", into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) references(item, key, into);
  else if (value && typeof value === "object") for (const [child, item] of Object.entries(value)) references(item, child, into);
  else if (typeof value === "string" && (key === "ref" || key.endsWith("Ref") || key.endsWith("Refs"))) into.add(value);
  return into;
}

export interface WireRequest { method: string; operation?: string; args?: Record<string, unknown>; stateDigest?: string; transactionId?: string; idempotencyKey?: string }
export interface WireLive {
  port: number;
  /** Every request the bridge sent, in order. */
  requests: WireRequest[];
  /** Pushes an event on every connection, as the Remote Script does for a subscription. */
  push(event: Omit<LiveEvent, "epoch" | "sequence">): void;
  /** The next mutate of `operation` fails with `error`, as the Remote Script's refusal (nothing runs). */
  refuseNext(operation: string, error: string): void;
  close(): Promise<void>;
}

/**
 * The digest a change is checked against, as the Remote Script's authority digest works: the rows of
 * the references its arguments name, for that operation. A change of any of them changes it.
 */
function stateDigest(simulator: DeterministicLiveSimulator, operation: string, args: Record<string, unknown>): string {
  const rows = [...references(args)].sort().map((reference) => { try { return [reference, simulator.get(reference as never)]; } catch { return [reference, null]; } });
  return createHash("sha256").update(JSON.stringify([operation, rows])).digest("hex");
}

export async function serveSimulator(simulator = new DeterministicLiveSimulator(), extraOperations: readonly string[] = ["authority.digest", "subscribe"]): Promise<WireLive> {
  const requests: WireRequest[] = [];
  const executed = new Map<string, unknown>();
  const refusals = new Map<string, string>();
  const sockets = new Set<Socket>();
  const sequences = new Map<Socket, number>();
  const operations = [...new Set([...(simulator.status().operations ?? []), ...extraOperations])];
  const status = () => ({ connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: liveCapabilitiesForOperations(operations), registryHash: LIVE_REGISTRY_HASH, operations, provenance: "fake-live" });
  const invoke = async (operation: string, args: Record<string, unknown>) => {
    if (operation === "authority.digest") return { stateDigest: stateDigest(simulator, String(args.operation), args.args as Record<string, unknown>), epoch: 1 };
    let result = await simulator.invokeAsync({ operation, args } as LiveInvocation) as unknown;
    const keys = RESULT_KEYS.get(operation);
    if (keys && result && typeof result === "object" && !Array.isArray(result)) result = Object.fromEntries(Object.entries(result).filter(([key]) => keys.has(key)));
    if (!CREATIONS.has(operation) || !result || typeof result !== "object") return result;
    return operation === "session.capture-midi" ? result : { ...(result as Record<string, unknown>), ownershipToken: "o".repeat(48) };
  };
  const handle = async (request: Record<string, unknown>): Promise<unknown> => {
    const method = String(request.method); const operation = typeof request.operation === "string" ? request.operation : undefined; const args = (request.args ?? {}) as Record<string, unknown>;
    requests.push({ method, ...(operation ? { operation } : {}), args, ...(typeof request.stateDigest === "string" ? { stateDigest: request.stateDigest } : {}), ...(typeof request.transactionId === "string" ? { transactionId: request.transactionId } : {}), ...(typeof request.idempotencyKey === "string" ? { idempotencyKey: request.idempotencyKey } : {}) });
    if (method === "status" || method === "reconnect") return status();
    if (method === "snapshot") { const value = JSON.parse(JSON.stringify(await simulator.snapshotAsync(undefined, args))) as Record<string, unknown>; for (const key of Object.keys(value)) if (!SNAPSHOT_KEYS.has(key)) delete value[key]; return value; }
    if (method === "get") return simulator.get(request.ref as never);
    if (method === "discover") {
      if (args.kind === "session_playback") return (await simulator.discoverAsync({ kind: "session-playback" })).items[0];
      const kind = WIRE_KINDS[String(args.kind)]!;
      const result = await simulator.discoverAsync({ kind, ...(args.parent ? { parent: String(args.parent) } : {}), ...(args.limit ? { limit: Number(args.limit) } : {}), ...(args.cursor ? { cursor: String(args.cursor) } : {}) });
      return { ...result, kind: args.kind };
    }
    if (method === "subscribe") return { subscribed: true, subscriptionId: "wire-subscription" };
    if (method === "retire") return { retired: [...executed.keys()].filter((key) => key.startsWith(`${String(request.transactionId)}\0`)).map((key) => executed.delete(key)).length };
    if (method === "preflight") return { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation, argsDigest: createHash("sha256").update(canonical(args)).digest("hex"), stateDigest: stateDigest(simulator, operation!, args), impact: "mutates-live", expiresAt: Date.now() + 10_000 };
    if (method === "prepare") return { authorityToken: "t".repeat(32), operation, argsDigest: createHash("sha256").update(canonical(args)).digest("hex"), stateDigest: stateDigest(simulator, operation!, args), expiresAt: Date.now() + 10_000 };
    if (method === "mutate") {
      const key = `${String(request.transactionId)}\0${String(request.idempotencyKey)}`;
      if (executed.has(key)) return executed.get(key);
      const refusal = refusals.get(operation!); if (refusal !== undefined) { refusals.delete(operation!); throw new Error(refusal); }
      if (typeof request.stateDigest === "string" && request.stateDigest !== stateDigest(simulator, operation!, args)) throw new Error("request failed: Live state changed since the preview; nothing changed");
      const result = await invoke(operation!, args); executed.set(key, result); return result;
    }
    if (method === "invoke") { const refusal = refusals.get(operation!); if (refusal !== undefined) { refusals.delete(operation!); throw new Error(refusal); } return await invoke(operation!, args); }
    throw new Error(`the wire fake doesn't answer ${method}`);
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket); sequences.set(socket, 0);
    socket.on("close", () => { sockets.delete(socket); sequences.delete(socket); });
    socket.write(answer("hello", { protocol: "ableton-live/v1", registryHash: LIVE_REGISTRY_HASH, maxDeadlineMs: 60_000 }));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        void handle(request).then((value) => socket.write(answer(String(request.id), value)), (error: unknown) => socket.write(answer(String(request.id), error instanceof Error ? error.message : String(error), false)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("the wire fake has no port");
  return {
    port: address.port, requests,
    refuseNext: (operation, error) => { refusals.set(operation, error); },
    push: (event) => { for (const socket of sockets) { const sequence = (sequences.get(socket) ?? 0) + 1; sequences.set(socket, sequence); socket.write(answer("event", { event: { ...event, epoch: 1, sequence } })); } },
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}
