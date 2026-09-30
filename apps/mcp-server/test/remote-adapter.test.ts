import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { expandPadChains, AUTHORITY_FREE_INVOKES, EXPLICIT_DELETIONS, READ_ONLY_INVOKES, RemoteScriptLiveAdapter, TRANSACTION_CREATIONS, TRANSACTION_DELETIONS } from "../src/bridge/remote-adapter.js";
import { LIVE_REGISTRY_HASH, LiveMutationNotDispatchedError } from "../src/live.js";

const secret = "0123456789abcdef0123456789abcdef";
const bridgeEpoch = "bridge-epoch-0123456789abcdef";
const challenge = "connection-challenge-0123456789abcdef";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
};
const signed = (value: Record<string, unknown>): string => createHmac("sha256", secret).update(canonical(value)).digest("base64url");
const response = (id: string, result: unknown, ok = true) => {
  const base = { version: "ableton-loopback/v1", id, ok, bridgeEpoch, connectionChallenge: challenge, ...(ok ? { result } : { error: String(result) }) };
  return { ...base, mac: signed(base) };
};
const hello = () => response("hello", { protocol: "ableton-live/v1", registryHash: LIVE_REGISTRY_HASH, maxDeadlineMs: 60_000 });
const requiredOperations = ["status", "snapshot", "discover", "get", "reconnect", "session.playback"];
const status = (overrides: Record<string, unknown> = {}) => ({ connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", capabilities: [], registryHash: LIVE_REGISTRY_HASH, operations: requiredOperations, provenance: "fake-live", ...overrides });

function framedServer(handler: (request: Record<string, unknown>, socket: Socket) => void) {
  return createServer((socket) => {
    socket.write(`${JSON.stringify(hello())}\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line) handler(JSON.parse(line) as Record<string, unknown>, socket);
      }
    });
  });
}
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function close(server: ReturnType<typeof createServer>): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }


test("a Drum Rack's pads point at the chains the rack lists in full, nested racks too", () => {
  const simpler = { ref: "1:device:0:0:0:0", name: "Simpler", parameters: [{ ref: "1:parameter:x", name: "Volume" }] };
  const kick = { ref: "1:chain:0:0:0", objectIdentity: "live:kick", name: "Kick", devices: [simpler] };
  const inner = { ref: "1:device:0:0:0:1", name: "Drum Rack", chains: [{ ref: "1:chain:inner", objectIdentity: "live:inner", devices: [] }], drumPads: [{ ref: "1:drum_pad:inner", chains: [{ ref: "1:chain:inner", objectIdentity: "live:inner", listedOnRack: true }] }] };
  const nested = { ref: "1:chain:0:0:1", objectIdentity: "live:nested", name: "Nested", devices: [inner] };
  const snapshot = { tracks: [{ devices: [{ ref: "1:device:0:0", name: "Drum Rack", chains: [kick, nested], drumPads: [
    { ref: "1:drum_pad:0:0:0", note: 36, chains: [{ ref: kick.ref, objectIdentity: "live:kick", name: "Kick", listedOnRack: true }] },
    { ref: "1:drum_pad:0:0:1", note: 37, chains: [] },
    { ref: "1:drum_pad:0:0:2", note: 38, chains: [{ ref: "1:chain:gone", objectIdentity: "live:gone", listedOnRack: true }] },
    { ref: "1:drum_pad:0:0:3", note: 39, chains: [{ ref: "1:chain:own", objectIdentity: "live:own", devices: [simpler] }] },
  ] }] }] };
  expandPadChains(snapshot);
  const pads = snapshot.tracks[0]!.devices[0]!.drumPads as Array<{ chains: Array<Record<string, unknown>> }>;
  assert.equal(pads[0]!.chains[0], kick, "the rack's own row, not a copy");
  assert.deepEqual(pads[1]!.chains, []);
  assert.deepEqual(pads[2]!.chains[0]!.devices, [], "a chain the rack doesn't list has no devices to show");
  assert.equal(pads[3]!.chains[0]!.devices && (pads[3]!.chains[0]!.devices as unknown[])[0], simpler, "full rows stay as they are");
  assert.equal((inner.drumPads[0]!.chains[0] as unknown), inner.chains[0], "a rack inside a chain too");
});

test("remote adapter fails closed before opening non-loopback or weakly authenticated endpoints", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "192.168.1.10", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.999.0.1", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.2", port: 9000, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 9000, secret: "short" }), /strong secret/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 0, secret }), /loopback/);
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "localhost", port: 9000, secret }), /loopback/);
});

test("remote adapter requires an authenticated registry-bound server hello", async () => {
  const server = createServer((socket) => {
    const invalid = { ...hello(), connectionChallenge: "forged-connection-challenge" };
    socket.write(`${JSON.stringify(invalid)}\n`);
  });
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /authentication|hello/); }
  finally { await close(server); }
});

test("remote adapter rejects an invalid negotiated status", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ epoch: -1, capabilities: [42] })))}\n`));
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /registry|handshake|type|bounds/); }
  finally { await close(server); }
});

test("remote adapter rejects forged or operation-inconsistent capabilities", async () => {
  for (const capabilities of [["session.write"], ["max"], ["transport"], ["warp"], ["takes"]]) {
    const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities })))}\n`));
    const port = await listen(server);
    try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
    finally { await close(server); }
  }
});

test("remote adapter accepts locator-derived arrangement capabilities with canonical operation names", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["arrangement.read", "arrangement.write"], operations: [...requiredOperations, "locator.add", "locator.delete"] })))}\n`));
  const port = await listen(server);
  let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }); assert.equal(adapter.status().connected, true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter rejects a registry operation outside the canonical set", async () => {
  const server = framedServer((request, socket) => socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "forged.operation"] })))}\n`));
  const port = await listen(server);
  try { await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 }), /handshake or negotiation/); }
  finally { await close(server); }
});

test("remote adapter delegates discovery with exhaustive kind translation and schema validation", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, { epoch: 1, items: [], truncated: false, revision: "1:return_track:0", kind: "return_track" }))}\n`);
  });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const result = await adapter.discoverAsync({ kind: "return-track", parent: "set:one", filter: { name: "A" }, fields: ["name"], budget: 50, limit: 4, cursor: "cursor" });
    assert.equal(result.kind, "return-track");
    assert.deepEqual(seen[1]?.args, { kind: "return_track", parent: "set:one", filters: { name: "A" }, requestedFields: ["name"], traversalBudget: 50, limit: 4, cursor: "cursor" });
    await adapter.close();
  } finally { await close(server); }
});

test("remote adapter retries an operation that waits for Live's playhead, with a fresh authority chain", async () => {
  const seen: string[] = []; let invokes = 0;
  const server = framedServer((request, socket) => {
    seen.push(String(request.method));
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "locator.add"] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else if (++invokes === 1) socket.write(`${JSON.stringify(response(request.id as string, "request failed: playhead is moving; retry shortly", false))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, { ref: "1:locator:1", objectIdentity: "live:locator:1", name: "Drop", position: 16, createdFingerprint: "f".repeat(64), ownershipToken: "o".repeat(48) }))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const result = await adapter.invokeAsync({ operation: "locator.add", args: { name: "Drop", position: 16, expectedCollectionRevision: "a".repeat(64) } }, { deadlineMs: Date.now() + 5000, idempotencyKey: "locator-drop-key", transactionId: "locator-transaction" }) as { name?: string };
    assert.equal(result.name, "Drop");
    assert.deepEqual(seen, ["status", "preflight", "prepare", "invoke", "preflight", "prepare", "invoke"]);
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter obtains mutation preflight authority with stable transaction idempotency", async () => {
  const seen: Record<string, unknown>[] = []; const idempotencyKeys: unknown[] = [];
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "scene.capture"] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") { idempotencyKeys.push(request.idempotencyKey); socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); }
    else socket.write(`${JSON.stringify(response(request.id as string, { captured: true, ref: "1:scene:captured", objectIdentity: "live:captured-scene", createdFingerprint: "f".repeat(64), ownershipToken: "o".repeat(48) }))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const context = { deadlineMs: Date.now() + 5000, idempotencyKey: "scene-capture-apply-key", transactionId: "host-scene-capture-transaction" };
    await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, context); await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, context);
    await adapter.invokeAsync({ operation: "scene.capture", args: { expectedStateRevision: "a".repeat(64) } }, { ...context, transactionId: "second-scene-capture-transaction" });
    assert.deepEqual(seen.map((item) => item.method), ["status", "preflight", "prepare", "invoke", "preflight", "prepare", "invoke", "preflight", "prepare", "invoke"]);
    assert.equal(idempotencyKeys.length, 3); assert.equal(idempotencyKeys[0], idempotencyKeys[1]); assert.notEqual(idempotencyKeys[1], idempotencyKeys[2]);
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter hides cleanup tokens and binds destructive cleanup to the creating transaction", async () => {
  const seen: Record<string, unknown>[] = []; const token = "o".repeat(48);
  const server = framedServer((request, socket) => { seen.push(request); if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "track.create", "track.delete"] })))}\n`); return; } if (request.method === "retire") { socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; } const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex"); if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`); else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); else if (request.operation === "track.create") socket.write(`${JSON.stringify(response(request.id as string, { ref: "1:track:1", objectIdentity: "live:track:1", name: "Owned", kind: "midi", index: 1, createdFingerprint: "f".repeat(64), ownershipToken: token }))}\n`); else { assert.equal(request.ownershipToken, token); socket.write(`${JSON.stringify(response(request.id as string, { deleted: "1:track:1" }))}\n`); } });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined; const transactionId = "creating-structure-transaction";
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const created = await adapter.invokeAsync({ operation: "track.create", args: { name: "Owned", kind: "midi", index: 1, expectedStructureRevision: "a".repeat(64) } }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-track", transactionId }) as Record<string, unknown>; assert.equal(created.ownershipToken, undefined); await adapter.retireTransactionAsync(transactionId, { deadlineMs: Date.now() + 1000 }); const deleteInvocation = { operation: "track.delete" as const, args: { ref: "1:track:1", expectedStructureRevision: "b".repeat(64), expectedObjectIdentity: "live:track:1" } }; await assert.rejects(adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "foreign-delete", transactionId: "foreign-structure-transaction" }), /lacks transaction-owned authority/); const beforeDelete = seen.length; assert.deepEqual(await adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "owned-delete", transactionId }), { deleted: "1:track:1" }); assert.equal(seen.slice(beforeDelete).filter((row) => ["preflight", "prepare", "invoke"].includes(String(row.method))).every((row) => row.ownershipToken === token), true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter retains and strips audio-clip creation tokens across create, replay, and owned undo", async () => {
  const seen: Record<string, unknown>[] = []; const token = "a".repeat(48);
  const server = framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "session.audio-clip.create", "clip.delete"] })))}\n`); return; }
    if (request.method === "retire") { socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.operation === "session.audio-clip.create") { socket.write(`${JSON.stringify(response(request.id as string, { ref: "1:clip:0:1", objectIdentity: "live:clip:0:1", name: "Imported", length: 4, filePath: "/tmp/staged.wav", createdFingerprint: "f".repeat(64), ownershipToken: token }))}\n`); }
    else { assert.equal(request.ownershipToken, token); socket.write(`${JSON.stringify(response(request.id as string, { deleted: "1:clip:0:1" }))}\n`); }
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined; const transactionId = "creating-audio-import-transaction";
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const createArgs = { trackRef: "1:track:0", sceneIndex: 1, filePath: "/tmp/staged.wav", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:1", expectedSlotIdentity: "live:slot:0:1", expectedSceneRef: "1:scene:1", expectedSceneIdentity: "live:scene:1" };
    const created = await adapter.invokeAsync({ operation: "session.audio-clip.create", args: createArgs }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-audio-clip", transactionId }) as Record<string, unknown>;
    assert.equal(created.ownershipToken, undefined, "the cleanup token is never leaked into results");
    const replayed = await adapter.invokeAsync({ operation: "session.audio-clip.create", args: createArgs }, { deadlineMs: Date.now() + 1000, idempotencyKey: "create-owned-audio-clip", transactionId }) as Record<string, unknown>;
    assert.equal(replayed.ownershipToken, undefined);
    const deleteInvocation = { operation: "clip.delete" as const, args: { ref: "1:clip:0:1", expectedObjectIdentity: "live:clip:0:1", expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:1", expectedSlotIdentity: "live:slot:0:1", expectedSceneRef: "1:scene:1", expectedSceneIdentity: "live:scene:1" } };
    await assert.rejects(adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "foreign-clip-delete", transactionId: "foreign-audio-transaction" }), /lacks transaction-owned authority/);
    const beforeDelete = seen.length;
    assert.deepEqual(await adapter.invokeAsync(deleteInvocation, { deadlineMs: Date.now() + 1000, idempotencyKey: "owned-clip-delete", transactionId }), { deleted: "1:clip:0:1" });
    assert.equal(seen.slice(beforeDelete).filter((row) => ["preflight", "prepare", "invoke"].includes(String(row.method))).every((row) => row.ownershipToken === token), true);
  }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter reconnects to the same bridge epoch and reconciles a lost mutation acknowledgement", async () => {
  let executed = false; let executions = 0; let dropFirst = true;
  const result = { captured: true, ref: "1:scene:captured", objectIdentity: "live:captured-scene", createdFingerprint: "f".repeat(64) }; const wireResult = { ...result, ownershipToken: "o".repeat(48) };
  const server = framedServer((request, socket) => {
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "scene.capture"] })))}\n`); return; }
    if (request.method === "retire") { assert.equal(request.transactionId, "lost-ack-transaction"); socket.write(`${JSON.stringify(response(request.id as string, { retired: 1 }))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") { socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`); return; }
    if (request.method === "prepare") { socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`); return; }
    if (!executed) { executed = true; executions += 1; }
    if (dropFirst) { dropFirst = false; socket.destroy(); return; }
    socket.write(`${JSON.stringify(response(request.id as string, wireResult))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const context = { deadlineMs: Date.now() + 5000, idempotencyKey: "lost-ack-key", transactionId: "lost-ack-transaction" }; const invocation = { operation: "scene.capture" as const, args: { expectedStateRevision: "a".repeat(64) } };
    await assert.rejects(adapter.invokeAsync(invocation, context), /disconnected|uncertain/);
    const reconciled = await adapter.invokeAsync(invocation, { ...context, deadlineMs: Date.now() + 5000 }); assert.deepEqual(reconciled, result); assert.equal(executions, 1); assert.deepEqual(await adapter.retireTransactionAsync("lost-ack-transaction", { deadlineMs: Date.now() + 5000 }), { retired: 1 });
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter refuses reconciliation after the Live epoch changes", async () => {
  let connection = 0;
  const server = createServer((socket) => {
    connection += 1; const generation = connection; socket.write(`${JSON.stringify(hello())}\n`); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>;
      if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ epoch: generation })))}\n`); else if (generation === 1) socket.destroy(); else socket.write(`${JSON.stringify(response(request.id as string, { set: {}, tracks: [], scenes: [], arrangement: {}, playback: {} }))}\n`);
    } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /disconnected|uncertain/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /Live epoch changed/); assert.equal(adapter.status().connected, false); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /poisoned/); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter remains poisoned after a replacement bridge reports the same Live epoch", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1; const generation = connections; const epoch = `bridge-epoch-generation-${generation}-0123456789`; const send = (id: string, result: unknown) => { const base = { version: "ableton-loopback/v1", id, ok: true, bridgeEpoch: epoch, connectionChallenge: challenge, result }; socket.write(`${JSON.stringify({ ...base, mac: signed(base) })}\n`); }; send("hello", { protocol: "ableton-live/v1", registryHash: LIVE_REGISTRY_HASH, maxDeadlineMs: 60_000 }); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") send(request.id as string, status({ epoch: 1 })); else if (generation === 1) socket.destroy(); else send(request.id as string, { set: {}, tracks: [], scenes: [], arrangement: {}, playback: {} }); } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /disconnected|uncertain/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /bridge or Live epoch changed/); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 2000 }), /poisoned/); assert.equal(connections, 2); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter restores subscriptions with a reset after same-epoch reconnect", async () => {
  let connections = 0; let subscriptions = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); connections += 1; const generation = connections; socket.write(`${JSON.stringify(hello())}\n`); let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>;
      if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["subscriptions"], operations: [...requiredOperations, "subscribe"] })))}\n`);
      else if (request.method === "subscribe") { subscriptions += 1; const subscribed = response(request.id as string, { subscribed: true, subscriptionId: `subscription-${subscriptions}` }); const event = response("event", { event: { epoch: 1, sequence: 1, type: "reset", payload: { resnapshot: true } } }); socket.write(`${JSON.stringify(subscribed)}\n${JSON.stringify(event)}\n`); if (generation === 1) setTimeout(() => socket.destroy(), 5); }
    } });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const events: unknown[] = []; adapter.subscribe((event) => events.push(event)); const statusChanges: string[] = []; const adapterWithStatus = adapter as unknown as { subscribeStatus?: (listener: (status: { connected: boolean }) => void) => void }; adapterWithStatus.subscribeStatus?.((status) => statusChanges.push(String(status.connected))); await adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() + 1000 }); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(adapter.status().connected, false);
    assert.deepEqual(statusChanges, ["false"], "the internal status channel reports the disconnect without manufacturing a LiveEvent");
    const refreshed = await adapter.refreshStatusAsync({ deadlineMs: Date.now() + 1000 }); assert.equal(refreshed.connected, true); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(subscriptions, 2); assert.equal(events.length, 2); assert.deepEqual(events.map((event) => (event as { type: string }).type), ["reset", "reset"]); assert.deepEqual(statusChanges, ["false", "true"]);
  } finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter reconnect obeys caller cancellation and absolute deadline", async () => {
  let connections = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); connections += 1; const generation = connections; if (generation === 1) socket.write(`${JSON.stringify(hello())}\n`); let buffer = ""; socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); else socket.destroy(); } }); });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 1000 }), /disconnected|uncertain/); const started = Date.now(); await assert.rejects(adapter.refreshStatusAsync({ deadlineMs: Date.now() + 50 }), /deadline|timed out/); assert.ok(Date.now() - started < 500);
    const controller = new AbortController(); const cancelled = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 1000, signal: controller.signal }); controller.abort(); await assert.rejects(cancelled, /cancelled/);
  } finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("concurrent reconnect callers retain independent deadlines", async () => {
  let connections = 0; const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); connections += 1; const generation = connections; const start = () => { socket.write(`${JSON.stringify(hello())}\n`); let buffer = ""; socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const request = JSON.parse(line) as Record<string, unknown>; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); else socket.destroy(); } }); }; if (generation === 1) start(); else setTimeout(start, 100); });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 }); await assert.rejects(adapter.snapshotAsync({ deadlineMs: Date.now() + 1000 }), /disconnected|uncertain/); const short = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 40 }); const long = adapter.refreshStatusAsync({ deadlineMs: Date.now() + 500 }); await assert.rejects(short, /deadline/); assert.equal((await long).connected, true); assert.equal(connections, 2); }
  finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test("a rejected subscribe attempt preserves the active event sequence", async () => {
  let activeSocket: Socket | undefined; const server = framedServer((request, socket) => { activeSocket = socket; if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status({ capabilities: ["subscriptions"], operations: [...requiredOperations, "subscribe"] })))}\n`); else if (request.method === "subscribe") { const subscribed = response(request.id as string, { subscribed: true, subscriptionId: "subscription-one" }); const reset = response("event", { event: { epoch: 1, sequence: 1, type: "reset", payload: { resnapshot: true } } }); socket.write(`${JSON.stringify(subscribed)}\n${JSON.stringify(reset)}\n`); } });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try { adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 }); const events: unknown[] = []; let receivedTransport!: () => void; const transportReceived = new Promise<void>((resolve) => { receivedTransport = resolve; }); adapter.subscribe((event) => { events.push(event); if (event.type === "transport") receivedTransport(); }); await adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() + 500 }); await assert.rejects(adapter.invokeAsync({ operation: "subscribe", args: { types: ["transport"] } }, { deadlineMs: Date.now() - 1 }), /deadline/); activeSocket?.write(`${JSON.stringify(response("event", { event: { epoch: 1, sequence: 2, type: "transport", payload: { playing: false } } }))}\n`); let timeout: NodeJS.Timeout | undefined; try { await Promise.race([transportReceived, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("transport event was not delivered")), 500); })]); } finally { if (timeout) clearTimeout(timeout); } assert.equal(events.length, 2); assert.equal((events[1] as { type: string }).type, "transport"); assert.equal(adapter.status().connected, true); }
  finally { await adapter?.close(); await close(server); }
});

test("remote adapter authenticates a maximum 512-note canonical batch and result", async () => {
  const notes = Array.from({ length: 512 }, (_, index) => ({ pitch: index % 128, start: index, duration: 0.25, velocity: 100, channel: 1 }));
  const noteIds = Array.from({ length: 512 }, (_, index) => index);
  const server = framedServer((request, socket) => {
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, "note.add-batch"] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, { added: 512, noteIds, notesRevision: "b".repeat(64) }))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 1000 });
    const result = await adapter.invokeAsync({ operation: "note.add-batch", args: { ref: "1:clip:0:0", notes, expectedClipAuthority: { expectedObjectIdentity: "live:clip:0", expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:0", expectedSlotIdentity: "live:slot:0", expectedSceneRef: "1:scene:0", expectedSceneIdentity: "live:scene:0" }, expectedNotesRevision: "a".repeat(64) } }, { deadlineMs: Date.now() + 5000, idempotencyKey: "maximum-note-batch", transactionId: "maximum-note-batch-transaction" }) as { added: number; noteIds: number[] };
    assert.equal(result.added, 512); assert.equal(result.noteIds.length, 512);
  } finally { await adapter?.close(); await close(server); }
});

test("an explicit bounded deadline extends the configured default request timeout", async () => {
  let requests = 0;
  const server = framedServer((request, socket) => {
    const send = () => socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    if (requests++ === 0) send(); else setTimeout(send, 80);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 30 });
    const started = Date.now(); const refreshed = await adapter.refreshStatusAsync({ deadlineMs: Date.now() + 500 });
    assert.equal(refreshed.connected, true); assert.ok(Date.now() - started >= 60);
  } finally { await adapter?.close(); await close(server); }
});

test("remote adapter closes the session on timeout and reports post-dispatch uncertainty", async () => {
  const sockets = new Set<Socket>();
  const server = framedServer((request, socket) => { sockets.add(socket); if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 50 });
    await assert.rejects(adapter.snapshotAsync(), /uncertain after dispatch timeout|disconnected/); assert.equal(adapter.status().connected, false);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter distinguishes pre-dispatch cancellation from post-dispatch ambiguity", async () => {
  const sockets = new Set<Socket>();
  const server = framedServer((request, socket) => { sockets.add(socket); if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`); });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const before = new AbortController(); before.abort();
    await assert.rejects(adapter.snapshotAsync({ signal: before.signal, deadlineMs: Date.now() + 500 }), /cancelled before dispatch/);
    const after = new AbortController(); const pending = adapter.snapshotAsync({ signal: after.signal, deadlineMs: Date.now() + 500 }); await new Promise((resolve) => setImmediate(resolve)); after.abort();
    await assert.rejects(pending, /uncertain after dispatch cancellation/);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});

test("remote adapter reports connection refusal as unavailable evidence", async () => {
  await assert.rejects(RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port: 65534, secret, timeoutMs: 25 }), /ECONNREFUSED|connect/);
});

test("remote adapter tears down on an authenticated unknown response", async () => {
  const server = framedServer((request, socket) => {
    const id = request.method === "status" ? request.id as string : "unknown";
    socket.write(`${JSON.stringify(response(id, request.method === "status" ? status() : {}))}\n`);
  });
  const port = await listen(server);
  try {
    const adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 200 });
    await assert.rejects(adapter.snapshotAsync(), /unknown or duplicate remote response|disconnected/);
    await adapter.close();
  } finally { await close(server); }
});

test("read-only invoke classification is identical across the TS adapter and the Python mapper", () => {
  // The two classifiers decide whether an invoke needs mutation authority
  // preflight/prepare; drift strands prepared authorities in the bridge ledger
  // and eventually exhausts it.
  const pythonPath = ["../../../remote-script/ableton_mcp_remote_script.py", "../../../../remote-script/ableton_mcp_remote_script.py"].map((candidate) => fileURLToPath(new URL(candidate, import.meta.url))).find((candidate) => { try { readFileSync(candidate); return true; } catch { return false; } });
  const python = readFileSync(pythonPath!, "utf8");
  const match = python.match(/_READ_ONLY_INVOKES = \{([^}]*)\}/);
  assert.ok(match, "python read-only invoke set not found");
  const pythonSet = new Set([...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]));
  assert.deepEqual([...pythonSet].sort(), [...READ_ONLY_INVOKES].sort());
  // And the sets that decide what a mutation carries: its creations' ownership, its deletions' fences.
  for (const [name, mirror] of [["_AUTHORITY_FREE_INVOKES", AUTHORITY_FREE_INVOKES], ["_TRANSACTION_CREATIONS", TRANSACTION_CREATIONS], ["_TRANSACTION_DELETIONS", TRANSACTION_DELETIONS], ["_EXPLICIT_DELETIONS", EXPLICIT_DELETIONS]] as const) {
    const set = python.match(new RegExp(`${name} = \\{([^}]*)\\}`));
    assert.ok(set, `python ${name} not found`);
    assert.deepEqual([...set[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort(), [...mirror].sort(), `${name} is mirrored exactly`);
  }
});

function authorityServer(operations: string[], seen: Record<string, unknown>[], answer: (request: Record<string, unknown>) => unknown) {
  return framedServer((request, socket) => {
    seen.push(request);
    if (request.method === "status") { socket.write(`${JSON.stringify(response(request.id as string, status({ operations: [...requiredOperations, ...operations] })))}\n`); return; }
    const argsDigest = createHash("sha256").update(canonical(request.args ?? {})).digest("hex");
    if (request.method === "preflight") socket.write(`${JSON.stringify(response(request.id as string, { preflightToken: "p".repeat(32), confirmation: "c".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), impact: "mutates-live", expiresAt: Date.now() + 5000 }))}\n`);
    else if (request.method === "prepare") socket.write(`${JSON.stringify(response(request.id as string, { authorityToken: "t".repeat(32), operation: request.operation, argsDigest, stateDigest: "a".repeat(64), expiresAt: Date.now() + 5000 }))}\n`);
    else socket.write(`${JSON.stringify(response(request.id as string, answer(request)))}\n`);
  });
}
const notDispatched = (pattern?: RegExp) => (error: unknown) => error instanceof LiveMutationNotDispatchedError && (!pattern || pattern.test(error.message));

test("an explicit deletion of an existing device, return or track goes out with its identity fences and no ownership token; without it, the deletion is refused unsent", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = authorityServer(["device.delete", "track.delete-return", "track.delete"], seen, (request) => ({ deleted: (request.args as { ref: string }).ref }));
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  const context = (key: string) => ({ deadlineMs: Date.now() + 5000, idempotencyKey: key, transactionId: `${key}-transaction` });
  const device = { ref: "1:device:0:1", expectedObjectIdentity: "live:device:eq", expectedOwnerRef: "1:track:0", expectedOwnerIdentity: "live:track:0", expectedSiblings: [{ ref: "1:device:0:0", objectIdentity: "live:device:synth" }, { ref: "1:device:0:1", objectIdentity: "live:device:eq" }], expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0" };
  const ret = { ref: "1:track:2", expectedObjectIdentity: "live:return:a", expectedStructureRevision: "a".repeat(64) };
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const before = seen.length;
    await assert.rejects(adapter.invokeAsync({ operation: "device.delete", args: device }, context("unowned-device-delete")), notDispatched(/lacks transaction-owned authority/));
    await assert.rejects(adapter.invokeAsync({ operation: "track.delete-return", args: ret }, context("unowned-return-delete")), notDispatched(/lacks transaction-owned authority/));
    assert.equal(seen.length, before, "a deletion no transaction owns, without the explicit authority, never reaches the bridge");
    assert.deepEqual(await adapter.invokeAsync({ operation: "device.delete", args: { ...device, explicitDeletion: true } }, context("explicit-device-delete")), { deleted: "1:device:0:1" });
    assert.deepEqual(await adapter.invokeAsync({ operation: "track.delete-return", args: { ...ret, explicitDeletion: true } }, context("explicit-return-delete")), { deleted: "1:track:2" });
    const sent = seen.slice(before);
    assert.deepEqual(sent.map((row) => `${String(row.method)} ${String(row.operation)}`), ["preflight device.delete", "prepare device.delete", "invoke device.delete", "preflight track.delete-return", "prepare track.delete-return", "invoke track.delete-return"]);
    assert.equal(sent.every((row) => row.ownershipToken === undefined && (row.args as Record<string, unknown>).explicitDeletion === true), true);
    // A track (like a clip, a scene or a locator) is deleted explicitly the same way: fences, no token.
    const beforeTrack = seen.length;
    assert.deepEqual(await adapter.invokeAsync({ operation: "track.delete", args: { ref: "1:track:0", expectedStructureRevision: "a".repeat(64), expectedObjectIdentity: "live:track:0", explicitDeletion: true } }, context("explicit-track-delete")), { deleted: "1:track:0" });
    assert.equal(seen.slice(beforeTrack).every((row) => row.ownershipToken === undefined), true);
    const beforeOthers = seen.length;
    await assert.rejects(adapter.invokeAsync({ operation: "track.delete", args: { ref: "1:track:0", expectedStructureRevision: "a".repeat(64), expectedObjectIdentity: "live:track:0" } }, context("unowned-track-delete")), notDispatched(/lacks transaction-owned authority/));
    await assert.rejects(adapter.invokeAsync({ operation: "device.delete", args: { ...device, explicitDeletion: false } }, context("half-explicit-delete")), notDispatched(), "only explicitDeletion: true is the authority");
    assert.equal(seen.length, beforeOthers);
  } finally { await adapter?.close(); await close(server); }
});

test("song.read is one read-only invoke with no authority chain, and mutation arguments the registry refuses are refused before anything is sent", async () => {
  const seen: Record<string, unknown>[] = [];
  const song = { visibleTracks: [], appointedDevice: null, songLength: 64, startTime: 0, signatureNumerator: 4, signatureDenominator: 4, swingAmount: 0.25, overdub: false, arrangementOverdub: false, backToArranger: false, canCaptureMidi: false, canUndo: true, canRedo: false, exclusiveArm: true, exclusiveSolo: true, isCountingIn: false, tempoFollowerEnabled: false, reEnableAutomationEnabled: false, sessionRecord: false, sessionAutomationRecord: false, clipTriggerQuantization: null, isAbletonLinkEnabled: false, isAbletonLinkStartStopSyncEnabled: false, tempoFollower: null, revision: "b".repeat(64) };
  const server = authorityServer(["song.read", "transport.set"], seen, (request) => request.operation === "song.read" ? song : { unexpected: true });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const before = seen.length;
    assert.deepEqual(await adapter.invokeAsync({ operation: "song.read", args: { setRef: "1:set" } }, { deadlineMs: Date.now() + 5000 }), song);
    assert.deepEqual(seen.slice(before).map((row) => `${String(row.method)} ${String(row.operation)}`), ["invoke song.read"]);
    const beforeInvalid = seen.length; const context = { deadlineMs: Date.now() + 5000, idempotencyKey: "invalid-transport", transactionId: "invalid-transport-transaction" };
    const fences = { setRef: "1:set", expectedObjectIdentity: "live:set", expectedRevision: "playback-revision-7" };
    await assert.rejects(adapter.invokeAsync({ operation: "transport.set", args: { ...fences, loopEnabled: true, metronome: undefined } }, context), notDispatched(), "an undefined field is not a wire value");
    await assert.rejects(adapter.invokeAsync({ operation: "transport.set", args: { ...fences, loopLength: -4 } }, context), notDispatched(), "a value outside the registry's bounds");
    assert.equal(seen.length, beforeInvalid, "nothing reached the bridge");
  } finally { await adapter?.close(); await close(server); }
});

/** Rows and parts a snapshot answer holds, for fake Remote Scripts. */
const trackRow = (index: number, light = false) => light ? { ref: `1:track:${index}`, objectIdentity: `live:track:${index}`, name: `Track ${index}`, kind: "regular", light: true, clips: [], clipSlots: [], devices: [], takeLanes: [], mixer: null, routing: null } : { ref: `1:track:${index}`, objectIdentity: `live:track:${index}`, name: `Track ${index}`, kind: "regular", clips: [], clipSlots: [], devices: [], takeLanes: [] };
const playbackPart = { ref: "1:session_playback:playback", epoch: 1, revision: "1:playback:1:0", transport: { playing: false, arrangementRecord: false, sessionRecord: false, position: 0, launchQuantization: { raw: null, normalized: null }, loop: { enabled: false, start: 0, length: 4 }, punchIn: null, punchOut: null, metronome: null, countIn: null }, firedTargets: [], playingTargets: [] };
const wholeSetAnswer = (tracks = 4) => ({ set: { ref: "1:set:song", name: "Set" }, tracks: Array.from({ length: tracks }, (_, index) => trackRow(index)), scenes: [], arrangement: { locators: [], clips: [] }, playback: playbackPart, trackCount: tracks, sceneCount: 0, epoch: 1 });

test("a snapshot's windows, focus and parts go as its wire args, checked against the registry before anything is sent", async () => {
  const snapshots: Record<string, unknown>[] = [];
  const server = framedServer((request, socket) => {
    if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    if (request.method !== "snapshot") return;
    snapshots.push(request); const args = request.args as { focus?: number[]; tracks?: { from: number; count: number }; parts?: string[] } | undefined;
    const whole = wholeSetAnswer(4) as Record<string, unknown>;
    if (!args) { socket.write(`${JSON.stringify(response(request.id as string, whole))}\n`); return; }
    const answer: Record<string, unknown> = { trackCount: 4, sceneCount: 0, epoch: 1, window: args };
    for (const part of args.parts ?? ["set", "tracks", "scenes", "arrangement", "playback"]) answer[part] = whole[part];
    if (args.focus) answer.tracks = [0, 1, 2, 3].map((index) => trackRow(index, !args.focus!.includes(index)));
    if (args.tracks) answer.tracks = [0, 1, 2, 3].slice(args.tracks.from, args.tracks.from + args.tracks.count).map((index) => trackRow(index));
    socket.write(`${JSON.stringify(response(request.id as string, answer))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    const focused = await adapter.snapshotAsync(undefined, { focus: [3], parts: ["tracks"] });
    assert.deepEqual(focused.window, { focus: [3], parts: ["tracks"] }); assert.equal("set" in focused, false);
    assert.deepEqual(focused.tracks.map((track) => track.light === true), [true, true, true, false]);
    assert.deepEqual((await adapter.snapshotAsync(undefined, { tracks: { from: 2, count: 16 }, parts: ["tracks", "arrangement"] })).tracks.map((track) => track.ref), ["1:track:2", "1:track:3"]);
    await adapter.snapshotAsync(undefined, {});
    await adapter.snapshotAsync();
    assert.deepEqual(snapshots.map((request) => request.args), [{ focus: [3], parts: ["tracks"] }, { tracks: { from: 2, count: 16 }, parts: ["tracks", "arrangement"] }, undefined, undefined]);
    assert.equal("args" in snapshots[3]!, false, "no request sends no args: the whole Set, as before");
    for (const bad of [{ focus: [1, 1] }, { focus: [100_001] }, { parts: ["everything"] }, { tracks: { from: 0, count: 0 } }]) await assert.rejects(adapter.snapshotAsync(undefined, bad as never), /registry/);
    assert.equal(snapshots.length, 4, "a request the registry refuses is never sent");
  } finally { await adapter?.close(); await close(server); }
});

test("a snapshot answer is checked against what was asked: no window means the whole Set, a window holds exactly what it says", async () => {
  const answers: unknown[] = [];
  const server = framedServer((request, socket) => {
    if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    if (request.method === "snapshot") socket.write(`${JSON.stringify(response(request.id as string, answers.shift()))}\n`);
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  const lightExcept = (...whole: number[]) => [0, 1, 2, 3].map((index) => trackRow(index, !whole.includes(index)));
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 500 });
    // A Remote Script from before snapshot arguments answers a focused read with the whole Set: that's used as the whole Set.
    answers.push(wholeSetAnswer(4));
    const legacy = await adapter.snapshotAsync(undefined, { focus: [1], parts: ["tracks"] });
    assert.equal(legacy.window, undefined); assert.equal(legacy.tracks.every((track) => track.light !== true), true); assert.ok(legacy.playback);
    const refusals: Array<[unknown, Parameters<RemoteScriptLiveAdapter["snapshotAsync"]>[1], RegExp]> = [
      [(({ playback: _playback, ...rest }) => rest)(wholeSetAnswer(4)), undefined, /without a window isn't the whole Set: it lacks playback/],
      [{ ...wholeSetAnswer(4), tracks: lightExcept(0) }, { focus: [0] }, /without a window isn't the whole Set: its tracks aren't all whole/],
      [{ tracks: lightExcept(1), trackCount: 4, epoch: 1, window: { focus: [1], parts: ["tracks"] }, set: {} }, { focus: [1], parts: ["tracks"] }, /holds set, which wasn't asked/],
      [{ trackCount: 4, epoch: 1, window: { parts: ["tracks", "set"] }, set: {} }, { parts: ["tracks", "set"] }, /lacks its tracks/],
      [{ tracks: lightExcept(1, 2), trackCount: 4, epoch: 1, window: { focus: [1], parts: ["tracks"] } }, { focus: [1], parts: ["tracks"] }, /track 2 is whole, but was asked light/],
      [{ tracks: lightExcept(), trackCount: 4, epoch: 1, window: { focus: [1], parts: ["tracks"] } }, { focus: [1], parts: ["tracks"] }, /track 1 is light, but was asked whole/],
      [{ tracks: lightExcept(1).slice(0, 3), trackCount: 4, epoch: 1, window: { focus: [1], parts: ["tracks"] } }, { focus: [1], parts: ["tracks"] }, /doesn't hold the track rows asked/],
      [{ tracks: [0, 1, 2].map((index) => trackRow(index)), trackCount: 4, epoch: 1, window: { tracks: { from: 0, count: 2 }, parts: ["tracks"] } }, { tracks: { from: 0, count: 2 }, parts: ["tracks"] }, /doesn't hold the track rows asked/],
      [{ ...wholeSetAnswer(4), window: { focus: [0] } }, { parts: ["tracks"] }, /honoured focus, which wasn't asked/],
      [{ tracks: lightExcept(3), trackCount: 4, epoch: 1, window: { focus: [3], parts: ["tracks"] } }, { focus: [1], parts: ["tracks"] }, /focus isn't the focus asked/],
    ];
    for (const [answer, request, reason] of refusals) { answers.push(answer); await assert.rejects(adapter.snapshotAsync(undefined, request), reason); }
    // A window honouring the focus and parts asked holds exactly them.
    answers.push({ tracks: lightExcept(2), trackCount: 4, sceneCount: 0, epoch: 1, window: { focus: [2], parts: ["tracks"] } });
    assert.equal((await adapter.snapshotAsync(undefined, { focus: [2], parts: ["tracks"] })).tracks.filter((track) => track.light !== true)[0]!.ref, "1:track:2");
  } finally { await adapter?.close(); await close(server); }
});

test("a snapshot or discovery page without a caller's deadline gets six times the configured timeout; a single object's read doesn't", async () => {
  const server = framedServer((request, socket) => {
    const answer = (result: unknown) => setTimeout(() => { if (!socket.destroyed) socket.write(`${JSON.stringify(response(request.id as string, result))}\n`); }, 150);
    if (request.method === "status") socket.write(`${JSON.stringify(response(request.id as string, status()))}\n`);
    if (request.method === "snapshot") answer(wholeSetAnswer(0));
    if (request.method === "get") answer({ ref: "1:track:0" });
  });
  const port = await listen(server); let adapter: RemoteScriptLiveAdapter | undefined;
  try {
    adapter = await RemoteScriptLiveAdapter.connect({ host: "127.0.0.1", port, secret, timeoutMs: 50 });
    assert.deepEqual((await adapter.snapshotAsync()).tracks, []);
    await assert.rejects(adapter.getAsync("1:track:0"), /uncertain after dispatch timeout|disconnected/);
  } finally { await adapter?.close(); await close(server); }
});
