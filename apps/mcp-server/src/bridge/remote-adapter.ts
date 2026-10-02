import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  LIVE_CAPABILITIES, LIVE_REGISTRY_HASH, LIVE_REGISTRY_OPERATIONS, LiveMutationNotDispatchedError, REMOTE_SCRIPT_EVENT_TYPES, checkSnapshotAnswer, liveCapabilitiesForOperations,
  type AsyncLiveAdapter, type LiveDiscoveryKind, type LiveDiscoveryRequest, type LiveDiscoveryResult,
  type LiveCapability, type LiveEvent, type LiveInvocation, type LiveOperationContext, type LiveRef, type LiveSnapshot, type LiveSnapshotRequest, type LiveStatus,
} from "../live.js";
import { LOOPBACK_PROTOCOL_VERSION, type RemoteBridgeRequest, type LoopbackResponse } from "../loopback.js";
import { validateLiveOperationRequest, validateLiveOperationResult } from "../registry.js";

// As large as the Remote Script sends (its MAX_WIRE_BYTES): big Sets make big frames, and what keeps
// Live responsive is paging on its side, not a cap here.
const MAX_FRAME_BYTES = 256 * 1_048_576;
const MAX_PENDING = 4096;
const DEFAULT_TIMEOUT_MS = 5_000;
// A snapshot or discovery page of a big Set legitimately takes longer than one change: without a caller's
// deadline such reads get six times the configured timeout (30 s on the 5 s default), within the Remote
// Script's 60 s deadline maximum.
const LARGE_READ_TIMEOUT_FACTOR = 6;
const MAX_DEADLINE_MS = 60_000;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const LIVE_PROTOCOL = "ableton-live/v1";
const ADAPTERS = new Set(["remote-script", "simulator", "extension", "unavailable"]);
// What the Remote Script pushes: its subscription's event types (the registry's subscribe types).
const EVENT_TYPES: ReadonlySet<string> = new Set(REMOTE_SCRIPT_EVENT_TYPES);
// Pure reads need no mutation authority (identical to the Remote Script's _READ_ONLY_INVOKES).
export const READ_ONLY_INVOKES = new Set(["session.playback", "willington.device.read", "automation.envelope.read", "arrangement.automation.read", "audio.take-lane.read", "audio.warp-marker.read", "browser.search", "browser.inspect", "browser.roots", "audio.capture.inspect", "audio.capture.status", "realtime.stats", "session.reconnect", "song.read", "song.time-convert", "tuning.read", "groove.read", "note.read-by-id", "note.read-selected", "performance.read", "authority.digest", "dev.lom-audit", "data.get", "automation.value-at", "plugin.parameter-names", "device.banks.read", "clip.time-convert"]);
/** Direct Remote Script calls without mutation authority: Live undo steps, messages and Python. */
export const AUTHORITY_FREE_INVOKES = new Set(["undo.step.begin", "undo.step.end", "application.message", "python.run"]);
// Creation classification has one shared source: the mapper's
// _TRANSACTION_CREATIONS in remote-script/ableton_mcp_remote_script.py. Keep
// this set identical so ownership tokens are retained (never leaked into
// results) and later cleanup deletes can present them.
export const TRANSACTION_CREATIONS = new Set(["track.create", "track.create-return", "track.duplicate", "scene.create", "scene.duplicate", "clip.create", "clip.duplicate", "arrangement.clip.create", "arrangement.audio-clip.create", "session.audio-clip.create", "browser.load", "device.insert", "device.duplicate", "session.capture-midi", "scene.capture", "locator.add"]);
export const TRANSACTION_DELETIONS = new Set(["track.delete", "track.delete-return", "scene.delete", "clip.delete", "arrangement.clip.delete", "device.delete", "locator.delete"]);
// Deletions of an existing object the producer previewed and confirmed (never an undo or a cleanup):
// they carry explicitDeletion instead of a creating transaction's ownership token, and the Remote
// Script checks the exact identity fences in their arguments. Mirrors _EXPLICIT_DELETIONS there.
export const EXPLICIT_DELETIONS = new Set(["device.delete", "track.delete-return", "clip.delete", "arrangement.clip.delete", "scene.delete", "track.delete", "locator.delete"]);
// An undo step belongs to the connection that opened it; the Remote Script closes it when that connection goes.
function mutationAuthorityRequired(operation: string): boolean { return !READ_ONLY_INVOKES.has(operation) && !AUTHORITY_FREE_INVOKES.has(operation); }
// The Remote Script keeps every change's reply (its MAX_MUTATION_LEDGER, 65,536) so a lost one can be
// replayed; a reply the host has seen is only memory there. With single-tick mutations the adapter frees
// that memory itself, off the path of any change: past this many changed transactions it retires the
// oldest in the background, down to half.
const DEFAULT_RETIRE_AFTER = 4096;
// A preview's state digest waits this long for its change; the preview itself expires sooner.
const EXPECTED_DIGEST_TTL_MS = 10 * 60_000;
const MAX_EXPECTED_DIGESTS = 4096;
/** Where the Remote Script refused a change before running it (its arguments, its replay ledger, its fences:
 * ownership, the preview's state; a queue that never ran it), it says nothing changed: nothing reached Live.
 * A Remote Script from before that said so only of a stale preview. */
const MUTATION_REFUSED_UNRUN = /; nothing changed\b|Live state changed since the preview$/;
/**
 * The references in a change's arguments, as the Remote Script's authority digest collects them (every
 * `ref`, `*Ref` and `*Refs` value, nested too): with the operation, all a state digest depends on.
 */
export function digestReferences(value: unknown, key = "", into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) digestReferences(item, key, into);
  else if (value && typeof value === "object") for (const [child, item] of Object.entries(value)) digestReferences(item, child, into);
  else if (typeof value === "string" && (key === "ref" || key.endsWith("Ref") || key.endsWith("Refs"))) into.add(value);
  return into;
}
const referencesKey = (args: Record<string, unknown>): string => JSON.stringify([...digestReferences(args)].sort());
const KIND_TO_WIRE: Readonly<Record<LiveDiscoveryKind, string>> = {
  set: "set", track: "track", "return-track": "return_track", "main-track": "main_track", scene: "scene",
  "clip-slot": "clip_slot", "session-clip": "session_clip", "arrangement-clip": "arrangement_clip", note: "note",
  locator: "locator", device: "device", parameter: "parameter", selection: "selection", "routing-choice": "routing_choice",
  "session-playback": "session_playback",
};
const WIRE_TO_KIND = new Map(Object.entries(KIND_TO_WIRE).map(([key, value]) => [value, key as LiveDiscoveryKind]));

type Endpoint = {
  host: string; port: number; secret: string; timeoutMs?: number;
  /**
   * How a change reaches Live: `mutate` (the default) is one request that the Remote Script checks and
   * applies in one Live tick, with the state digest from the preview when there is one; `authority` is
   * the older preflight → prepare → invoke chain, kept for the tests that exercise it.
   */
  mutationPath?: "mutate" | "authority";
  /** Past this many changed transactions the adapter retires the oldest in the background (tests set it low). */
  retireAfter?: number;
};
type Pending = {
  operationId: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
};
type Hello = LoopbackResponse & { id: "hello"; result: { protocol: string; registryHash: string; maxDeadlineMs: number } };

function canonical(value: unknown, depth = 0): string {
  // The Remote Script's own bounds (MAX_WIRE_DEPTH and the rest): both ends sign the same text.
  if (depth > 256) throw new Error("wire payload is too deeply nested");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") { if (value.length > 1_048_576) throw new Error("wire string is too large"); return JSON.stringify(value); }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("wire number is not finite"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
  if (Array.isArray(value)) { if (value.length > 10_000_000) throw new Error("wire array is too large"); return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`; }
  if (typeof value === "object") { const object = value as Record<string, unknown>; const keys = Object.keys(object); if (keys.length > 1_000_000) throw new Error("wire object is too large"); return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`; }
  throw new Error("unsupported wire value");
}
function mac(secret: string, value: unknown): string { const encoded = canonical(value); if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error("wire payload is too large"); return createHmac("sha256", secret).update(encoded).digest("base64url"); }
/**
 * The Remote Script sends a loaded Drum Rack's chains in full once, on the rack, and each pad names
 * its chains (`listedOnRack`). Pads point at the rack's rows again, the very same objects, so every
 * reader sees a pad's devices as before while the wire carries them once.
 */
export function expandPadChains(value: unknown, depth = 0): void {
  if (depth > 48 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) expandPadChains(item, depth + 1); return; }
  const row = value as Record<string, unknown>;
  for (const child of Object.values(row)) expandPadChains(child, depth + 1);
  if (!Array.isArray(row.drumPads)) return;
  const chains = new Map<unknown, unknown>((Array.isArray(row.chains) ? row.chains : []).filter((chain): chain is Record<string, unknown> => !!chain && typeof chain === "object").map((chain) => [chain.objectIdentity, chain]));
  for (const pad of row.drumPads) {
    if (!pad || typeof pad !== "object" || !Array.isArray((pad as { chains?: unknown }).chains)) continue;
    const named = pad as { chains: unknown[] };
    named.chains = named.chains.map((chain) => {
      if (!chain || typeof chain !== "object" || (chain as { listedOnRack?: unknown }).listedOnRack !== true) return chain;
      return chains.get((chain as { objectIdentity?: unknown }).objectIdentity) ?? { ...(chain as object), devices: [] };
    });
  }
}
function validEndpoint(endpoint: Endpoint): void {
  if ((endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 || endpoint.secret.length < 32) throw new Error("remote script endpoint must use exact loopback address 127.0.0.1 or ::1 with a strong secret");
}
function validStatus(value: unknown): value is LiveStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<LiveStatus>;
  const capabilities = status.capabilities;
  const operations = status.operations;
  if (typeof status.connected !== "boolean" || typeof status.adapter !== "string" || !ADAPTERS.has(status.adapter) ||
      !(status.epoch === null || (typeof status.epoch === "number" && Number.isSafeInteger(status.epoch) && status.epoch >= 1)) ||
      status.protocol !== LIVE_PROTOCOL || !Array.isArray(capabilities) || capabilities.length > 4096 ||
      !capabilities.every((capability) => typeof capability === "string" && capability.length > 0 && capability.length <= 128) ||
      status.registryHash !== LIVE_REGISTRY_HASH || !Array.isArray(operations) || operations.length > 4096) return false;
  if (new Set(capabilities).size !== capabilities.length || !capabilities.every((capability) => (LIVE_CAPABILITIES as readonly string[]).includes(capability))) return false;
  if (!operations.every((operation) => typeof operation === "string" && operation.length > 0 && operation.length <= 128) ||
      new Set(operations).size !== operations.length ||
      !operations.every((operation) => (LIVE_REGISTRY_OPERATIONS as readonly string[]).includes(operation)) ||
      !["status", "snapshot", "discover", "get", "reconnect", "session.playback"].every((operation) => operations.includes(operation))) return false;
  const derivable = new Set<string>(liveCapabilitiesForOperations(operations));
  return capabilities.every((capability) => derivable.has(capability));
}
function verifySigned(secret: string, response: LoopbackResponse): void {
  const unsigned = { ...response } as Partial<LoopbackResponse>;
  delete unsigned.mac;
  const expected = Buffer.from(mac(secret, unsigned));
  const received = Buffer.from(response.mac);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("remote response authentication failed");
}
/** A snapshot request's wire args: only the fields given (the registry checks their bounds), none for the whole Set. */
function snapshotArgs(request: LiveSnapshotRequest | undefined): Record<string, unknown> | undefined {
  if (request === undefined) return undefined;
  const args: Record<string, unknown> = {};
  if (request.tracks !== undefined) args.tracks = { from: request.tracks.from, count: request.tracks.count };
  if (request.scenes !== undefined) args.scenes = { from: request.scenes.from, count: request.scenes.count };
  if (request.focus !== undefined) args.focus = [...request.focus];
  if (request.parts !== undefined) args.parts = [...request.parts];
  return Object.keys(args).length > 0 ? args : undefined;
}
function registryRequest(operationId: string, fields: Omit<RemoteBridgeRequest, "version" | "id" | "nonce" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs" | "mac">): unknown {
  if (operationId === "status" || operationId === "reconnect" || operationId === "session.playback") return {};
  if (operationId === "snapshot") return fields.args ?? {};
  if (operationId === "discover") return fields.args ?? {};
  if (operationId === "get") return { ref: fields.ref };
  if (operationId === "authority.preflight") return { operation: fields.operation, argsDigest: createHash("sha256").update(canonical(fields.args ?? {})).digest("hex"), transactionId: fields.transactionId };
  if (operationId === "authority.prepare") return { operation: fields.operation, argsDigest: createHash("sha256").update(canonical(fields.args ?? {})).digest("hex"), transactionId: fields.transactionId, preflightToken: fields.preflightToken, confirmation: fields.confirmation, idempotencyKey: fields.idempotencyKey };
  if (operationId === "authority.retire") return { transactionId: fields.transactionId, ...("terminal" in fields ? { terminal: fields.terminal } : {}) };
  return fields.args ?? {};
}

/** Async authenticated TCP adapter with registry validation and channel binding. */
export class RemoteScriptLiveAdapter implements AsyncLiveAdapter {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private pieces: Buffer[] = [];
  private piecesLength = 0;
  private sequence = 0;
  private epoch: number | null = null;
  private bridgeEpoch?: string;
  private connectionChallenge?: string;
  private helloResolve?: () => void;
  private helloReject?: (reason?: unknown) => void;
  private cached: LiveStatus = { connected: false, adapter: "unavailable", epoch: null, protocol: LIVE_PROTOCOL, capabilities: [], reason: "not-connected" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private lastEventEpoch: number | null = null;
  private lastEventSequence = 0;
  private reopening?: Promise<void>;
  private explicitlyClosed = false;
  private reconciliationPoisoned = false;
  private activeSubscriptionArgs?: Record<string, unknown>;
  private readonly cleanupOwnership = new Map<string, Map<string, string>>();
  private readonly mutationPath: "mutate" | "authority";
  private readonly retireAfter: number;
  /** State digests previews asked for, by transaction: the change they expect, and the digest on its way. */
  private readonly expectedDigests = new Map<string, { operation: string; references: string; digest: Promise<string | undefined>; expiresAt: number }>();
  /** Transactions whose changes the Remote Script still keeps for replay, oldest first. */
  private readonly unretired = new Map<string, true>();
  /** Transactions with a change on its way: never retired meanwhile. */
  private readonly changing = new Map<string, number>();
  private retiring?: Promise<void>;
  private constructor(private readonly endpoint: Endpoint) {
    validEndpoint(endpoint);
    this.mutationPath = endpoint.mutationPath ?? "mutate";
    this.retireAfter = Math.max(2, endpoint.retireAfter ?? DEFAULT_RETIRE_AFTER);
  }

  static async connect(endpoint: Endpoint): Promise<RemoteScriptLiveAdapter> {
    const adapter = new RemoteScriptLiveAdapter(endpoint);
    await adapter.open();
    const result = await adapter.requestAsync({ method: "status" }, "status");
    if (!validStatus(result) || !result.connected || result.adapter !== "remote-script" || result.epoch === null) { await adapter.close(); throw new Error("remote script handshake or negotiation failed"); }
    adapter.epoch = result.epoch; adapter.cached = result; return adapter;
  }

  status(): LiveStatus { return this.cached; }
  snapshot(): never { throw new Error("remote adapter is asynchronous; use snapshotAsync"); }
  get(): never { throw new Error("remote adapter is asynchronous; use getAsync"); }
  invoke(): never { throw new Error("remote adapter is asynchronous; use invokeAsync"); }
  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect(): LiveStatus { throw new Error("remote adapter is asynchronous; use reconnectAsync"); }
  /** A snapshot; `request` (windows, focus, parts) goes as the wire args, checked against the registry
   * before anything is sent. No request sends none: the whole Set, as before. The answer is checked
   * against what was asked (checkSnapshotAnswer): without a window it must be the whole Set. */
  snapshotAsync(context?: LiveOperationContext, request?: LiveSnapshotRequest): Promise<LiveSnapshot> {
    const args = snapshotArgs(request);
    return this.ensureConnectedAsync(context).then(() => this.requestAsync({ method: "snapshot", ...(args ? { args } : {}) }, "snapshot", context)).then((snapshot) => { expandPadChains(snapshot); return checkSnapshotAnswer(snapshot as LiveSnapshot, (args ?? {}) as LiveSnapshotRequest); });
  }
  async discoverAsync(request: LiveDiscoveryRequest, context?: LiveOperationContext): Promise<LiveDiscoveryResult> {
    await this.ensureConnectedAsync(context);
    const wireKind = KIND_TO_WIRE[request.kind];
    if (!wireKind) throw new Error(`unsupported discovery kind: ${String(request.kind)}`);
    const args: Record<string, unknown> = { kind: wireKind };
    if (request.parent !== undefined) args.parent = request.parent;
    if (request.filter !== undefined) args.filters = request.filter;
    if (request.fields !== undefined) args.requestedFields = request.fields;
    if (request.budget !== undefined) args.traversalBudget = request.budget;
    if (request.limit !== undefined) args.limit = request.limit;
    if (request.cursor !== undefined) args.cursor = request.cursor;
    const operationId = request.kind === "session-playback" ? "session.playback" : "discover";
    const result = await this.requestAsync({ method: "discover", args }, operationId, context) as Record<string, unknown>;
    expandPadChains(result);
    if (request.kind === "session-playback") return { epoch: result.epoch as number, items: [result], truncated: false, revision: result.revision as string, kind: request.kind };
    const translated = WIRE_TO_KIND.get(String(result.kind));
    if (!translated || translated !== request.kind) throw new Error("remote discovery returned an unexpected kind");
    return { ...(result as unknown as LiveDiscoveryResult), kind: translated };
  }
  getAsync(ref: LiveRef, context?: LiveOperationContext): Promise<unknown> { return this.ensureConnectedAsync(context).then(() => this.requestAsync({ method: "get", ref }, "get", context)).then((row) => { expandPadChains(row); return row; }); }
  /** Live applies playhead moves on its next tick; operations that need the playhead somewhere answer
   * "retry shortly" after moving it. Retry those (full authority chain each time) a few ticks later. */
  async invokeAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.invokeOnceAsync(invocation, context); }
      catch (error) {
        const retry = error instanceof Error && error.message.endsWith("retry shortly") && attempt < 10 && !context?.signal?.aborted
          && (context?.deadlineMs === undefined || context.deadlineMs - Date.now() > 250);
        if (!retry) throw error;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }

  private async invokeOnceAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<unknown> {
    await this.ensureConnectedAsync(context);
    if (!this.cached.operations?.includes(invocation.operation)) throw new Error(`remote operation is not negotiated: ${invocation.operation}`);
    if (invocation.operation === "subscribe") {
      const result = await this.requestAsync({ method: "subscribe", args: invocation.args }, "subscribe", context) as { subscribed?: unknown };
      this.activeSubscriptionArgs = result.subscribed === true ? structuredClone(invocation.args) : undefined;
      return result;
    }
    if (!mutationAuthorityRequired(invocation.operation)) { const result = await this.requestAsync({ method: "invoke", operation: invocation.operation, args: invocation.args }, invocation.operation, context); if (String(invocation.operation) === "session.reconnect") this.cleanupOwnership.clear(); return result; }
    // Arguments the wire or the registry refuses are refused here, before any authority is minted
    // or anything reaches Live (an undefined field, a value outside the registry's bounds).
    let argsDigest: string;
    try { argsDigest = createHash("sha256").update(canonical(invocation.args)).digest("hex"); validateLiveOperationRequest(invocation.operation, invocation.args); }
    catch (error) { throw new LiveMutationNotDispatchedError(error instanceof Error ? error.message : "remote mutation arguments are invalid"); }
    const baseIdempotencyKey = context?.idempotencyKey ?? randomBytes(18).toString("base64url");
    const transactionScope = context?.transactionId ?? randomBytes(18).toString("base64url");
    if (baseIdempotencyKey.length < 8 || baseIdempotencyKey.length > 128 || transactionScope.length < 8 || transactionScope.length > 128) throw new Error("remote mutation idempotency authority is invalid");
    const ownedCount = [...this.cleanupOwnership.values()].reduce((count, rows) => count + rows.size, 0); const reserve = invocation.operation === "session.capture-midi" ? 256 : 1;
    if (TRANSACTION_CREATIONS.has(invocation.operation) && ownedCount + reserve > 4096) throw new Error("remote cleanup ownership ledger is full");
    // A deletion, or settling a device just made, carries the creating transaction's ownership token;
    // an explicit deletion of an existing object carries its exact identity fences instead.
    const explicitDeletion = EXPLICIT_DELETIONS.has(invocation.operation) && invocation.args.explicitDeletion === true;
    const owned = (TRANSACTION_DELETIONS.has(invocation.operation) && !explicitDeletion) || invocation.operation === "ownership.settle";
    const reference = typeof invocation.args.ref === "string" ? invocation.args.ref : undefined; let ownershipToken = owned && reference ? this.cleanupOwnership.get(transactionScope)?.get(reference) : undefined; let consumedMoveOwnership: { transactionId: string; reference: string } | undefined;
    if (owned && !ownershipToken) throw new LiveMutationNotDispatchedError("remote destructive cleanup lacks transaction-owned authority");
    if ((invocation.operation === "clip.move" || invocation.operation === "arrangement.clip.move") && reference) {
      const matches = [...this.cleanupOwnership.entries()].filter(([, rows]) => rows.has(reference));
      if (matches.length > 1) throw new Error("remote transaction-owned move authority is ambiguous");
      if (matches.length === 1) { ownershipToken = matches[0]![1].get(reference); consumedMoveOwnership = { transactionId: matches[0]![0], reference }; }
    }
    const ownershipFields = ownershipToken ? { ownershipToken } : {};
    const bridgeIdempotencyKey = createHash("sha256").update(`${transactionScope}\0${baseIdempotencyKey}\0${invocation.operation}\0${argsDigest}`).digest("base64url");
    let wireResult: unknown;
    try { wireResult = this.mutationPath === "mutate" ? await this.mutateAsync(invocation, transactionScope, bridgeIdempotencyKey, ownershipFields, context) : await this.authorizedInvokeAsync(invocation, transactionScope, bridgeIdempotencyKey, ownershipFields, context); }
    catch (error) {
      if (consumedMoveOwnership && reference && !(error instanceof LiveMutationNotDispatchedError) && this.socket && !this.socket.destroyed) {
        try {
          const observed = await this.requestAsync({ method: "get", ref: reference as LiveRef }, "get", context) as Record<string, unknown>; const expectedIdentity = invocation.args.expectedObjectIdentity;
          if (!observed || typeof observed !== "object" || typeof expectedIdentity !== "string" || observed.objectIdentity !== expectedIdentity) { const owned = this.cleanupOwnership.get(consumedMoveOwnership.transactionId); owned?.delete(consumedMoveOwnership.reference); if (owned?.size === 0) this.cleanupOwnership.delete(consumedMoveOwnership.transactionId); }
        } catch {}
      }
      throw error;
    }
    if (TRANSACTION_CREATIONS.has(invocation.operation)) {
      const result = structuredClone(wireResult) as Record<string, unknown>; const rows = invocation.operation === "session.capture-midi" ? result.clipIdentities : [result]; if (!Array.isArray(rows)) throw new Error("remote creation ownership result is malformed"); const owned = this.cleanupOwnership.get(transactionScope) ?? new Map<string, string>();
      for (const value of rows) { if (!value || typeof value !== "object") throw new Error("remote creation ownership evidence is malformed"); const row = value as Record<string, unknown>; const reference = invocation.operation === "browser.load" ? row.deviceRef : row.ref; if (typeof reference !== "string" || typeof row.ownershipToken !== "string" || row.ownershipToken.length < 32) throw new Error("remote creation ownership token is missing"); owned.set(reference, row.ownershipToken); delete row.ownershipToken; }
      if (owned.size > 0) this.cleanupOwnership.set(transactionScope, owned); return result;
    }
    if (consumedMoveOwnership) { const owned = this.cleanupOwnership.get(consumedMoveOwnership.transactionId); owned?.delete(consumedMoveOwnership.reference); if (owned?.size === 0) this.cleanupOwnership.delete(consumedMoveOwnership.transactionId); }
    if (TRANSACTION_DELETIONS.has(invocation.operation) && reference) { const owned = this.cleanupOwnership.get(transactionScope); owned?.delete(reference); if (owned?.size === 0) this.cleanupOwnership.delete(transactionScope); }
    return wireResult;
  }
  /** The older chain: preflight and prepare mint authority, then invoke spends it. */
  private async authorizedInvokeAsync(invocation: LiveInvocation, transactionScope: string, idempotencyKey: string, ownershipFields: { ownershipToken?: string }, context?: LiveOperationContext): Promise<unknown> {
    // Preflight and prepare only mint authority in the bridge: whatever goes wrong there, nothing
    // was dispatched to Live, which callers (undo above all) may report as a plain refusal.
    let prepared: { authorityToken?: unknown; operation?: unknown; argsDigest?: unknown; expiresAt?: unknown };
    try {
      const preflight = await this.requestAsync({ method: "preflight", operation: invocation.operation, args: invocation.args, transactionId: transactionScope, ...ownershipFields }, "authority.preflight", context) as { preflightToken?: unknown; confirmation?: unknown; operation?: unknown; argsDigest?: unknown; expiresAt?: unknown };
      if (typeof preflight.preflightToken !== "string" || typeof preflight.confirmation !== "string" || preflight.operation !== invocation.operation || typeof preflight.argsDigest !== "string" || typeof preflight.expiresAt !== "number" || preflight.expiresAt <= Date.now()) throw new Error("remote mutation authority preflight failed");
      prepared = await this.requestAsync({ method: "prepare", operation: invocation.operation, args: invocation.args, transactionId: transactionScope, preflightToken: preflight.preflightToken, confirmation: preflight.confirmation, idempotencyKey, ...ownershipFields }, "authority.prepare", context) as { authorityToken?: unknown; operation?: unknown; argsDigest?: unknown; expiresAt?: unknown };
      if (typeof prepared.authorityToken !== "string" || prepared.operation !== invocation.operation || prepared.argsDigest !== preflight.argsDigest || typeof prepared.expiresAt !== "number" || prepared.expiresAt <= Date.now()) throw new Error("remote mutation authority preparation failed");
    } catch (error) { throw new LiveMutationNotDispatchedError(error instanceof Error ? error.message : "remote mutation authority failed"); }
    try { return await this.requestAsync({ method: "invoke", operation: invocation.operation, args: invocation.args, authorityToken: prepared.authorityToken as string, transactionId: transactionScope, ...ownershipFields }, invocation.operation, context); }
    catch (error) { if (error instanceof Error && MUTATION_REFUSED_UNRUN.test(error.message)) throw new LiveMutationNotDispatchedError(error.message); throw error; }
  }

  /**
   * One request, one Live tick: the Remote Script checks the change's fences (its arguments' identities,
   * and the state digest from the preview when this transaction's preview asked for one) and applies it,
   * or refuses it unrun. It records the reply under the idempotency key, so a retry after a lost reply
   * gets that reply instead of a second change.
   */
  private async mutateAsync(invocation: LiveInvocation, transactionScope: string, idempotencyKey: string, ownershipFields: { ownershipToken?: string }, context?: LiveOperationContext): Promise<unknown> {
    const expectation = this.expectedDigests.get(transactionScope);
    let stateDigest: string | undefined;
    if (expectation && expectation.operation === invocation.operation && expectation.references === referencesKey(invocation.args)) {
      this.expectedDigests.delete(transactionScope);
      if (expectation.expiresAt > Date.now()) stateDigest = await expectation.digest;
    }
    this.changing.set(transactionScope, (this.changing.get(transactionScope) ?? 0) + 1);
    try {
      const result = await this.requestAsync({ method: "mutate", operation: invocation.operation, args: invocation.args, transactionId: transactionScope, idempotencyKey, ...ownershipFields, ...(stateDigest ? { stateDigest } : {}) }, invocation.operation, context);
      this.unretired.delete(transactionScope); this.unretired.set(transactionScope, true);
      return result;
    } catch (error) {
      if (error instanceof Error && MUTATION_REFUSED_UNRUN.test(error.message)) throw new LiveMutationNotDispatchedError(error.message);
      throw error;
    } finally {
      const left = (this.changing.get(transactionScope) ?? 1) - 1;
      if (left > 0) this.changing.set(transactionScope, left); else this.changing.delete(transactionScope);
      if (this.unretired.size > this.retireAfter) this.retireOldestSoon();
    }
  }

  /** True when this adapter retires the Remote Script's replay records itself (single-tick mutations), so the host needn't after each change. */
  get retiresOnItsOwn(): boolean { return this.mutationPath === "mutate"; }

  /**
   * A preview's word that its transaction will send `invocation`: asks the Remote Script now for the state
   * digest that change is checked against, and the change carries it, so it's refused if anything it
   * depends on (the rows it names, the Set's structure, the song's transport) changed since the preview.
   * Only the transaction's first change of that operation on the same references carries it: a later
   * step would see the first step's own effect.
   */
  expectStateDigest(transactionId: string, invocation: LiveInvocation): void {
    if (this.mutationPath !== "mutate" || !this.cached.operations?.includes("authority.digest") || !mutationAuthorityRequired(invocation.operation)) return;
    const now = Date.now();
    for (const [key, row] of this.expectedDigests) if (row.expiresAt <= now) this.expectedDigests.delete(key);
    while (this.expectedDigests.size >= MAX_EXPECTED_DIGESTS) this.expectedDigests.delete(this.expectedDigests.keys().next().value as string);
    let digest: Promise<string | undefined>;
    try {
      digest = this.requestAsync({ method: "invoke", operation: "authority.digest", args: { operation: invocation.operation, args: invocation.args } }, "authority.digest")
        .then((value) => { const stateDigest = (value as { stateDigest?: unknown }).stateDigest; return typeof stateDigest === "string" ? stateDigest : undefined; }, () => undefined);
    } catch { return; }
    this.expectedDigests.set(transactionId, { operation: invocation.operation, references: referencesKey(invocation.args), digest, expiresAt: now + EXPECTED_DIGEST_TTL_MS });
  }

  /** Retires the oldest changed transactions in the background, down to half the bound, skipping any with a change in flight. */
  private retireOldestSoon(): void {
    if (this.retiring) return;
    this.retiring = (async () => {
      for (const transactionId of [...this.unretired.keys()]) {
        if (this.unretired.size <= Math.floor(this.retireAfter / 2)) break;
        if (this.changing.has(transactionId)) continue;
        this.unretired.delete(transactionId);
        try { await this.retireTransactionAsync(transactionId, { deadlineMs: Date.now() + (this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS) }); } catch { /* the Remote Script clears its ledger on reconnect */ }
      }
    })().finally(() => { this.retiring = undefined; });
  }

  async retireTransactionAsync(transactionId: string, context?: LiveOperationContext, terminal = false): Promise<{ retired: number }> { if (transactionId.length < 8 || transactionId.length > 128) throw new Error("remote retirement transaction id is invalid"); this.unretired.delete(transactionId); await this.ensureConnectedAsync(context); const result = await this.requestAsync({ method: "retire", transactionId, ...(terminal ? { terminal: true } : {}) }, "authority.retire", context) as { retired: number }; if (terminal) this.cleanupOwnership.delete(transactionId); return result; }
  /** Internal adapter-status change channel (never the public LiveEvent stream:
   * those events carry remote wire sequence semantics that synthetic events
   * must not contaminate). Subscribers are notified after connect/disconnect,
   * reconnect, and negotiated operation/capability shape changes. */
  private readonly statusListeners = new Set<(status: LiveStatus) => void>();
  subscribeStatus(listener: (status: LiveStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  private emitStatusChange(): void { for (const listener of this.statusListeners) listener(this.cached); }
  private shapeChanged(prior: LiveStatus, next: LiveStatus): boolean {
    return prior.connected !== next.connected || prior.epoch !== next.epoch || JSON.stringify(prior.willingtonKinds ?? []) !== JSON.stringify(next.willingtonKinds ?? []) || JSON.stringify(prior.operations ?? []) !== JSON.stringify(next.operations ?? []) || JSON.stringify([...prior.capabilities].sort()) !== JSON.stringify([...next.capabilities].sort());
  }
  reconnectAsync(context?: LiveOperationContext): Promise<LiveStatus> { return this.ensureConnectedAsync(context).then(() => this.requestAsync({ method: "reconnect" }, "reconnect", context)).then((value) => { const status = value as LiveStatus; if (!validStatus(status)) throw new Error("invalid reconnect status"); const changed = this.shapeChanged(this.cached, status); this.epoch = status.epoch; this.cached = status; this.lastEventEpoch = this.epoch; this.lastEventSequence = 0; this.cleanupOwnership.clear(); this.unretired.clear(); this.expectedDigests.clear(); if (changed) this.emitStatusChange(); return status; }); }
  /** Re-request the mapper's current status without a reconnect; operations and
   * capabilities reflect the shape at call time (no epoch change). */
  refreshStatusAsync(context?: LiveOperationContext): Promise<LiveStatus> { return this.ensureConnectedAsync(context).then(() => this.requestAsync({ method: "status" }, "status", context)).then((value) => { const status = value as LiveStatus; if (!validStatus(status)) throw new Error("invalid refreshed status"); const changed = this.shapeChanged(this.cached, status); this.cached = status; if (changed) this.emitStatusChange(); return status; }); }
  async close(): Promise<void> { this.explicitlyClosed = true; this.failPending(new Error("remote adapter disconnected")); this.helloReject?.(new Error("remote adapter disconnected")); this.helloResolve = undefined; this.helloReject = undefined; this.socket?.destroy(); this.socket = undefined; this.cached = { ...this.cached, connected: false, reason: "closed" }; }

  private contextualReconnectWait(promise: Promise<void>, context?: LiveOperationContext): Promise<void> {
    if (!context) return promise;
    if (context.signal?.aborted) return Promise.reject(new Error("remote adapter reconnect cancelled"));
    const deadlineMs = context.deadlineMs ?? Date.now() + (this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || deadlineMs > Date.now() + 60_000) return Promise.reject(new Error("remote adapter reconnect deadline is invalid or expired"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("remote adapter reconnect deadline expired")); }, Math.max(1, deadlineMs - Date.now()));
      const abort = () => { cleanup(); reject(new Error("remote adapter reconnect cancelled")); };
      const cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); };
      context.signal?.addEventListener("abort", abort, { once: true });
      promise.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
    });
  }

  private ensureConnectedAsync(context?: LiveOperationContext): Promise<void> {
    if (this.explicitlyClosed) return Promise.reject(new Error("remote adapter is closed"));
    if (this.reconciliationPoisoned) return Promise.reject(new Error("remote adapter reconciliation channel is poisoned by a bridge or Live epoch change"));
    if (this.reopening) return this.contextualReconnectWait(this.reopening, context);
    if (this.socket && !this.socket.destroyed && this.bridgeEpoch && this.connectionChallenge) return Promise.resolve();
    const priorBridgeEpoch = this.bridgeEpoch; const priorLiveEpoch = this.epoch;
    this.bridgeEpoch = undefined; this.connectionChallenge = undefined; this.buffer = Buffer.alloc(0); this.pieces = []; this.piecesLength = 0; this.sequence = 0;
    this.reopening = (async () => {
      await this.open();
      const value = await this.requestAsync({ method: "status" }, "status") as LiveStatus;
      if (!validStatus(value) || !value.connected || value.adapter !== "remote-script" || value.epoch === null) throw new Error("remote adapter recovery negotiation failed");
      if ((priorBridgeEpoch && this.bridgeEpoch !== priorBridgeEpoch) || (priorLiveEpoch !== null && value.epoch !== priorLiveEpoch)) { this.cached = { ...this.cached, connected: false, reason: "remote-bridge-or-live-epoch-changed" }; this.reconciliationPoisoned = true; this.bridgeEpoch = undefined; this.connectionChallenge = undefined; this.socket?.destroy(); this.socket = undefined; throw new Error("remote bridge or Live epoch changed; mutation reconciliation is unavailable"); }
      const changed = this.shapeChanged(this.cached, value);
      this.epoch = value.epoch; this.cached = value; this.lastEventEpoch = this.epoch; this.lastEventSequence = 0;
      if (changed) this.emitStatusChange();
      if (this.activeSubscriptionArgs) {
        const subscribed = await this.requestAsync({ method: "subscribe", args: this.activeSubscriptionArgs }, "subscribe") as { subscribed?: unknown };
        if (subscribed.subscribed !== true) throw new Error("remote adapter subscription restoration failed");
      }
    })().catch((error) => { this.cached = { ...this.cached, connected: false, reason: "remote-reconnect-failed" }; this.socket?.destroy(); this.socket = undefined; throw error; }).finally(() => { this.reopening = undefined; });
    return this.contextualReconnectWait(this.reopening, context);
  }

  private open(context?: LiveOperationContext): Promise<void> {
    return new Promise((resolve, reject) => {
      if (context?.signal?.aborted) { reject(new Error("remote adapter reconnect cancelled")); return; }
      const configuredTimeout = this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS; const deadlineRemaining = context?.deadlineMs === undefined ? configuredTimeout : context.deadlineMs - Date.now();
      if (!Number.isFinite(deadlineRemaining) || deadlineRemaining <= 0) { reject(new Error("remote adapter reconnect deadline expired")); return; }
      const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      this.socket = socket; socket.setNoDelay(true);
      const abort = () => { socket.destroy(); reject(new Error("remote adapter reconnect cancelled")); };
      context?.signal?.addEventListener("abort", abort, { once: true });
      const cleanupHandshake = () => { clearTimeout(timer); context?.signal?.removeEventListener("abort", abort); };
      this.helloResolve = resolve; this.helloReject = reject;
      const handshakeTimeout = context?.deadlineMs === undefined ? configuredTimeout : deadlineRemaining;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("remote adapter connection timed out")); }, Math.max(1, handshakeTimeout));
      const disconnected = (error: Error) => { cleanupHandshake(); if (this.socket !== socket) return; const wasConnected = this.cached.connected; this.socket = undefined; this.cached = { ...this.cached, connected: false, reason: "remote-adapter-disconnected" }; if (this.bridgeEpoch && wasConnected) this.emitStatusChange(); if (!this.bridgeEpoch) reject(error); this.failPending(error); };
      socket.on("data", (chunk) => { if (this.socket === socket) this.onData(chunk); });
      socket.on("error", (error) => disconnected(error));
      socket.on("close", () => disconnected(new Error("remote adapter disconnected")));
      const originalResolve = this.helloResolve;
      this.helloResolve = () => { cleanupHandshake(); originalResolve?.(); };
    });
  }

  private requestAsync(fields: Omit<RemoteBridgeRequest, "version" | "id" | "nonce" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs" | "mac">, operationId: string, context?: LiveOperationContext): Promise<unknown> {
    if (!this.socket || this.socket.destroyed || !this.bridgeEpoch || !this.connectionChallenge) return Promise.reject(new Error("remote adapter is disconnected"));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("remote adapter queue is full"));
    if (this.sequence >= MAX_SEQUENCE) return Promise.reject(new Error("remote adapter sequence exhausted"));
    if (context?.signal?.aborted) return Promise.reject(new Error("remote adapter request cancelled before dispatch"));
    const configured = this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = fields.method === "snapshot" || fields.method === "discover" ? Math.min(MAX_DEADLINE_MS, configured * LARGE_READ_TIMEOUT_FACTOR) : configured;
    const deadlineMs = context?.deadlineMs ?? Date.now() + timeoutMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || deadlineMs > Date.now() + 60_000) return Promise.reject(new Error("remote adapter deadline is invalid or expired"));
    validateLiveOperationRequest(operationId, registryRequest(operationId, fields));
    const id = `async-${++this.sequence}`;
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id, ...fields, nonce: randomBytes(18).toString("base64url"), sequence: this.sequence, bridgeEpoch: this.bridgeEpoch, connectionChallenge: this.connectionChallenge, deadlineMs };
    const request = { ...unsigned, mac: mac(this.endpoint.secret, unsigned) };
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, context?.deadlineMs === undefined ? timeoutMs : deadlineMs - Date.now());
      const timer = setTimeout(() => { this.cached = { ...this.cached, connected: false, reason: "remote-request-timeout" }; this.socket?.destroy(); this.failPending(new Error("remote adapter request state uncertain after dispatch timeout")); }, remaining);
      const pending: Pending = { operationId, resolve, reject, timer };
      if (context?.signal) {
        const abort = () => { this.cached = { ...this.cached, connected: false, reason: "remote-request-cancelled-after-dispatch" }; this.socket?.destroy(); this.failPending(new Error("remote adapter request state uncertain after dispatch cancellation")); };
        context.signal.addEventListener("abort", abort, { once: true });
        pending.abortCleanup = () => context.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      try { this.socket?.write(`${JSON.stringify(request)}\n`); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); pending.abortCleanup?.(); reject(error); this.socket?.destroy(); }
    });
  }

  private onData(chunk: Buffer): void {
    // A frame arrives in many pieces: keep them until one holds a line end, then join once.
    if (chunk.indexOf(10) < 0) {
      this.pieces.push(chunk); this.piecesLength += chunk.length;
      if (this.buffer.length + this.piecesLength > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); }
      return;
    }
    this.buffer = Buffer.concat([this.buffer, ...this.pieces, chunk]); this.pieces = []; this.piecesLength = 0;
    while (true) {
      const index = this.buffer.indexOf(10); if (index < 0) return;
      const frame = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1); if (frame.length === 0) continue;
      if (frame.length > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); return; }
      try { this.onResponse(JSON.parse(frame.toString("utf8")) as LoopbackResponse); }
      catch (error) { this.failPending(error instanceof Error ? error : new Error("malformed remote response")); this.helloReject?.(error); this.socket?.destroy(); return; }
    }
  }

  private onResponse(response: LoopbackResponse): void {
    if (!response || response.version !== LOOPBACK_PROTOCOL_VERSION || typeof response.id !== "string" || typeof response.mac !== "string" || typeof response.bridgeEpoch !== "string" || typeof response.connectionChallenge !== "string") throw new Error("invalid remote response");
    verifySigned(this.endpoint.secret, response);
    if (response.id === "hello") {
      if (this.bridgeEpoch || !response.ok || !response.result || typeof response.result !== "object") throw new Error("invalid or duplicate remote hello");
      const hello = response as Hello;
      if (hello.result.protocol !== LIVE_PROTOCOL || hello.result.registryHash !== LIVE_REGISTRY_HASH || !Number.isSafeInteger(hello.result.maxDeadlineMs) || hello.result.maxDeadlineMs < 100 || hello.bridgeEpoch.length < 16 || hello.connectionChallenge.length < 16) throw new Error("remote hello negotiation failed");
      this.bridgeEpoch = hello.bridgeEpoch; this.connectionChallenge = hello.connectionChallenge; this.helloResolve?.(); this.helloResolve = undefined; this.helloReject = undefined; return;
    }
    if (response.bridgeEpoch !== this.bridgeEpoch || response.connectionChallenge !== this.connectionChallenge) throw new Error("remote response channel binding failed");
    if (response.result && typeof response.result === "object" && "event" in (response.result as Record<string, unknown>)) {
      const event = (response.result as { event?: unknown }).event;
      if (!event || typeof event !== "object" || !Number.isSafeInteger((event as { epoch?: unknown }).epoch) || (event as { epoch: number }).epoch <= 0 || !Number.isSafeInteger((event as { sequence?: unknown }).sequence) || (event as { sequence: number }).sequence <= 0 || typeof (event as { type?: unknown }).type !== "string" || !EVENT_TYPES.has((event as { type: string }).type)) throw new Error("invalid remote event");
      const liveEvent = event as LiveEvent;
      if (liveEvent.epoch !== this.epoch) throw new Error("remote event epoch does not match the current connection");
      if (this.lastEventEpoch !== liveEvent.epoch) { this.lastEventEpoch = liveEvent.epoch; this.lastEventSequence = 0; }
      if (liveEvent.sequence <= this.lastEventSequence || (liveEvent.type !== "reset" && liveEvent.sequence !== this.lastEventSequence + 1)) throw new Error("remote event sequence gap or replay requires reset");
      this.lastEventSequence = liveEvent.sequence;
      for (const listener of this.listeners) listener(event as LiveEvent); return;
    }
    const pending = this.pending.get(response.id); if (!pending) throw new Error("unknown or duplicate remote response");
    this.pending.delete(response.id); clearTimeout(pending.timer); pending.abortCleanup?.();
    if (response.ok) { try { validateLiveOperationResult(pending.operationId, response.result); if (pending.operationId === "subscribe") { this.lastEventEpoch = this.epoch; this.lastEventSequence = 0; } if (pending.operationId === "reconnect" && validStatus(response.result)) { this.epoch = response.result.epoch; this.lastEventEpoch = this.epoch; this.lastEventSequence = 0; } pending.resolve(response.result); } catch (error) { this.cached = { ...this.cached, connected: false, reason: "registry-result-validation-failed" }; pending.reject(error); this.socket?.destroy(); } }
    else pending.reject(new Error(response.error ?? "remote request failed"));
  }

  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.abortCleanup?.(); pending.reject(error); } this.pending.clear(); }
}

export type { Endpoint as RemoteScriptEndpoint };
