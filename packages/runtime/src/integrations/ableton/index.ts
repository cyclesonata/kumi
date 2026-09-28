import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionState, Integration, JsonObject, KernelTool, Observation } from "../../core/contracts.js";
import { connectMcp, type McpEndpoint } from "../../mcp/client.js";
import { AllowedTools } from "../../mcp/allowed-tools.js";
import { discoveryArgs, discoveryPayload, INSTRUCTIONS, object, ObservationError, PARENTS, payload, queryKey, setIdentity, statusPayload } from "./context.js";

function noAccess(key: string, now: Date): Observation {
  return { key, label: "Inference-only — No Live access", instructions: INSTRUCTIONS, tools: [],
    context: JSON.stringify({ observedAt: now.toISOString(), mode: "inference-only", access: "No Live access; do not describe remembered Set data as current. /new or restart establishes a fresh connection." }) };
}
export function createInferenceOnlyIntegration(onConnection: (state: ConnectionState) => void): Integration {
  let closed = false;
  return {
    async start(signal) { signal.throwIfAborted(); if (closed) throw new Error("Integration is closed"); onConnection("disconnected"); },
    async observe(signal) { signal.throwIfAborted(); if (closed) throw new Error("Integration is closed"); return noAccess("inference-only", new Date()); },
    async close() { closed = true; },
  };
}
interface Options {
  onConnection: (state: ConnectionState) => void;
  bridgeConfig?: string;
  connect?: (signal: AbortSignal) => Promise<McpEndpoint>;
  now?: () => Date;
  generation?: string;
  onDispatch?: (name: string) => void;
}

export function createAbletonIntegration(options: Options): Integration {
  const generation = options.generation ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const lifetime = new AbortController();
  const refs = new Map<string, string>();
  const cursors = new Map<string, string>();
  const unlisten: (() => void)[] = [];
  let endpoint: McpEndpoint | undefined;
  let tools: AllowedTools | undefined;
  let closed = false;
  let started = false;
  let available = false;
  let lost = false;
  let observationGeneration = 0;
  let currentEpoch: number | undefined;
  let currentSet: string | undefined;
  let closing: Promise<void> | undefined;

  const invalidate = () => { refs.clear(); cursors.clear(); currentEpoch = undefined; observationGeneration++; };
  const loseAccess = () => { if (closed || lost) return; lost = true; available = false; invalidate(); options.onConnection("disconnected"); };
  function changed() {
    invalidate(); options.onConnection("error");
    throw new ObservationError("Live epoch or Set identity changed; result discarded. Refresh before continuing.");
  }
  function assertLease(lease: number, signal: AbortSignal) {
    signal.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (closed || lease !== observationGeneration) throw new ObservationError("Observation changed; late result discarded");
  }
  function assertEpoch(actual: unknown, expected: number) { if (actual !== expected) changed(); }
  async function readStatus(signal: AbortSignal) {
    if (!tools?.has("live_status")) throw new ObservationError("Live status capability is unavailable");
    return statusPayload(await tools.call("live_status", {}, signal));
  }
  async function guardEpoch(signal: AbortSignal, expected: number, lease: number) {
    const status = await readStatus(signal);
    assertLease(lease, signal);
    if (!status.connected) { loseAccess(); throw new ObservationError("No Live access; current observations were discarded"); }
    assertEpoch(status.epoch, expected);
    return status;
  }
  function registerRows(kind: string, rows: JsonObject[], args: JsonObject, nextCursor?: string) {
    for (const row of rows) {
      if (args.parent !== undefined && row.parentRef !== args.parent) throw new ObservationError("Discovery returned a different parent; result discarded");
      if (typeof row.ref === "string" && row.ref.length > 0 && row.ref.length <= 256) refs.set(row.ref, kind);
    }
    if (refs.size > 4096) { invalidate(); throw new ObservationError("Too many current references; refresh and narrow the request"); }
    if (nextCursor) {
      if (nextCursor === args.cursor) throw new ObservationError("Discovery cursor repeated; narrow the request");
      cursors.set(nextCursor, queryKey(args));
      if (cursors.size > 128) { invalidate(); throw new ObservationError("Too many page cursors; refresh and narrow the request"); }
    }
  }
  function validateParentAndCursor(args: JsonObject) {
    const kind = String(args.kind);
    const parentKinds = PARENTS[kind];
    if (parentKinds || args.parent !== undefined) {
      const parentKind = typeof args.parent === "string" ? refs.get(args.parent) : undefined;
      if (!parentKind || (parentKinds ? !parentKinds.includes(parentKind) : parentKind !== "set")) {
        throw new ObservationError("A fresh authoritative parent is required; discover the parent in this turn, not from history");
      }
    }
    if (args.cursor !== undefined && (typeof args.cursor !== "string" || cursors.get(args.cursor) !== queryKey(args))) {
      throw new ObservationError("Cursor is stale or belongs to another query; rediscover without it");
    }
  }
  function encode(result: CallToolResult, epoch: number): { text: string; isError: boolean } {
    if (result.isError) return { text: JSON.stringify(result), isError: true };
    const text = JSON.stringify({ mcp: result, observation: { observedAt: now().toISOString(), connectionGeneration: generation, epoch,
      coverage: "Bounded read; preserve truncated/nextCursor markers. Traversal completeness is not established." } });
    if (Buffer.byteLength(text) > 64 * 1024) return { text: "Result too large; narrow fields/parent/page.", isError: true };
    return { text, isError: false };
  }
  async function invoke(name: string, input: JsonObject, originalSignal: AbortSignal) {
    const signal = AbortSignal.any([originalSignal, lifetime.signal]);
    let reading = false;
    const lease = observationGeneration;
    try {
      signal.throwIfAborted();
      if (!available || lost || currentEpoch === undefined || !tools?.isValid) throw new ObservationError("No current Live access; refresh or use /new before reading");
      const epoch = currentEpoch;
      const args = name === "live_discover" ? discoveryArgs(input) : input;
      if (name === "live_discover") validateParentAndCursor(args);
      reading = true;
      await guardEpoch(signal, epoch, lease);
      const result = await tools.call(name, args, signal);
      assertLease(lease, signal);
      await guardEpoch(signal, epoch, lease);
      if (!result.isError) {
        if (name === "live_discover") {
          assertEpoch(payload(result).epoch, epoch);
          const page = discoveryPayload(result, String(args.kind), epoch);
          if (args.kind === "set" && (page.items.length !== 1 || setIdentity(page.items[0]!) !== currentSet)) changed();
          registerRows(String(args.kind), page.items, args, page.nextCursor);
        } else if (name === "live_snapshot") {
          const data = payload(result); assertEpoch(data.epoch, epoch);
          if (setIdentity(object(object(data.snapshot).set)) !== currentSet) changed();
          // Snapshot refs intentionally do not satisfy fresh-discovery parent leases.
        } else if (name === "live_status") {
          const data = statusPayload(result);
          if (!data.connected) loseAccess();
          assertEpoch(data.epoch, epoch);
        }
      }
      const encoded = encode(result, epoch);
      if (encoded.isError) { refs.clear(); cursors.clear(); }
      return encoded;
    } catch (error) {
      // A failed upstream read cannot authorize retries with cached refs/cursors.
      if (reading && lease === observationGeneration) { refs.clear(); cursors.clear(); }
      return { text: error instanceof ObservationError ? error.message : "Live read failed; refresh current observations and narrow the request before retrying.", isError: true };
    }
  }
  function definitions(): KernelTool[] {
    return tools!.list().map((tool) => ({ name: tool.name, description: tool.description ?? "Read current Live state", inputSchema: tool.inputSchema,
      execute: (input, signal) => invoke(tool.name, input, signal) }));
  }
  return {
    async start(signal) {
      if (closed || started) throw new ObservationError("Integration cannot be started again");
      started = true; options.onConnection("connecting");
      const combined = AbortSignal.any([signal, lifetime.signal]);
      try {
        if (!options.connect && !options.bridgeConfig) throw new ObservationError("Bridge configuration is required; choose explicit inference-only mode otherwise");
        endpoint = await (options.connect ? options.connect(combined) : connectMcp({ signal: combined, bridgeConfig: options.bridgeConfig!, ...(options.onDispatch ? { onDispatch: options.onDispatch } : {}) }));
        if (combined.aborted || closed) { await endpoint.close(); combined.throwIfAborted(); throw new ObservationError("Connection closed"); }
        tools = new AllowedTools(endpoint);
        unlisten.push(endpoint.onDisconnect(loseAccess), endpoint.onCatalogChanged(invalidate));
        available = true;
      } catch {
        options.onConnection("error");
        throw new ObservationError("MCP startup failed; verify the standalone bridge and explicit configuration");
      }
    },
    async observe(originalSignal) {
      const signal = AbortSignal.any([originalSignal, lifetime.signal]);
      signal.throwIfAborted();
      if (!started || closed) throw new ObservationError("Integration is not open");
      invalidate(); const lease = observationGeneration;
      if (!available || lost) return noAccess(`${generation}:no-live`, now());
      try {
        await tools!.refresh(signal); assertLease(lease, signal);
        const status = await readStatus(signal); assertLease(lease, signal);
        if (!status.connected) { loseAccess(); return noAccess(`${generation}:no-live`, now()); }
        if (!tools!.has("live_discover")) throw new ObservationError("Required Set discovery capability is unavailable");
        const epoch = status.epoch as number;
        const args = discoveryArgs({ kind: "set" });
        const result = await tools!.call("live_discover", args, signal); assertLease(lease, signal);
        assertEpoch(payload(result).epoch, epoch);
        const page = discoveryPayload(result, "set", epoch);
        if (page.items.length !== 1) throw new ObservationError("Current Set discovery did not return one authoritative Set");
        const row = page.items[0]!;
        const identity = setIdentity(row);
        await guardEpoch(signal, epoch, lease);
        currentEpoch = epoch; currentSet = identity;
        registerRows("set", page.items, args, page.nextCursor);
        options.onConnection("connected");
        const name = typeof row.name === "string" && row.name.trim() ? row.name.slice(0, 256) : "(unnamed/unsaved)";
        const provenance = typeof status.provenance === "string" ? status.provenance : "unknown";
        const source = provenance === "real-live" && status.adapter === "remote-script" ? "Remote Script · real-live" : `unverified/synthetic fixture · ${provenance}`;
        return {
          key: JSON.stringify([generation, epoch, identity, tools!.generation]),
          label: `Current open Set: ${name} — ${source}`,
          instructions: INSTRUCTIONS, tools: definitions(),
          context: JSON.stringify({ observedAt: now().toISOString(), connectionGeneration: generation, epoch,
            adapter: status.adapter, provenance, liveVersion: status.environment && typeof status.environment === "object" ? object(status.environment).liveVersion ?? null : null,
            set: { ref: row.ref, name, tempo: row.tempo ?? null, playing: row.playing ?? null, position: row.position ?? null, loop: row.loop ?? null },
            truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            coverage: "Current open Set only. Bounded discovery; details and track counts require fresh paged reads. Names/paths are not durable identity.",
          }),
        };
      } catch (error) {
        if (lease !== observationGeneration) throw new ObservationError("Observation changed; late refresh discarded");
        refs.clear(); cursors.clear(); currentEpoch = undefined;
        throw new ObservationError(error instanceof ObservationError ? error.message : "Live observation refresh failed; old observations are not current");
      }
    },
    close() {
      if (closing) return closing;
      closed = true; available = false; lifetime.abort(); invalidate();
      for (const remove of unlisten) remove();
      closing = tools ? tools.close() : endpoint ? endpoint.close() : Promise.resolve();
      return closing;
    },
  };
}
