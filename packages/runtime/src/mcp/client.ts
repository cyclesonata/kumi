import { KUMI_VERSION } from "../version.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ErrorCode, McpError, ListToolsResultSchema, ToolListChangedNotificationSchema,
  type CallToolResult, type Implementation, type JSONRPCMessage, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JsonObject } from "../core/contracts.js";

/** The most one message from the bridge may hold: a big Set's reads come in pages well under it. */
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * The bridge's messages, read in linear time: the SDK's own buffer joins everything so far with each
 * chunk the pipe delivers, which for a message of megabytes is quadratic. Over the limit, the message
 * is refused (and the link closes, as the SDK's does).
 */
class LinearReadBuffer {
  private pieces: Buffer[] = []; private size = 0;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    if (this.size + chunk.length > this.limit) { this.clear(); throw new Error(`ReadBuffer exceeded maximum size of ${this.limit} bytes`); }
    this.pieces.push(chunk); this.size += chunk.length;
  }
  readMessage(): JSONRPCMessage | null {
    for (let index = 0; index < this.pieces.length; index++) {
      const at = this.pieces[index]!.indexOf(10);
      if (at < 0) continue;
      const head = Buffer.concat([...this.pieces.slice(0, index), this.pieces[index]!.subarray(0, at)]);
      const rest = this.pieces[index]!.subarray(at + 1);
      this.pieces = [...(rest.length ? [rest] : []), ...this.pieces.slice(index + 1)];
      this.size = this.pieces.reduce((sum, piece) => sum + piece.length, 0);
      return deserializeMessage(head.toString("utf8").replace(/\r$/, ""));
    }
    return null;
  }
  clear(): void { this.pieces = []; this.size = 0; }
}

// SDK 1.30.1 starts an unawaited close on initialize failure, and its stdio
// close clears pid before exit. Share ONE close promise and retain owned identity.
class OwnedStdioTransport extends StdioClientTransport {
  ownedPid: number | null = null;
  constructor(...parameters: ConstructorParameters<typeof StdioClientTransport>) {
    super(...parameters);
    (this as unknown as { _readBuffer: LinearReadBuffer })._readBuffer = new LinearReadBuffer(MAX_BRIDGE_MESSAGE_BYTES);
  }
  private shutdown: Promise<void> | undefined;
  override async start() { await super.start(); this.ownedPid = this.pid; }
  override close(): Promise<void> {
    this.ownedPid ??= this.pid;
    return this.shutdown ??= Promise.resolve().then(() => super.close());
  }
}

export const bridgeEntry = fileURLToPath(new URL("../../../../../apps/mcp-server/dist/src/cli.js", import.meta.url));
export interface McpEndpoint {
  readonly pid: number | null;
  readonly serverInfo: Implementation | undefined;
  list(cursor: string | undefined, signal: AbortSignal): Promise<ListToolsResult>;
  call(name: string, args: JsonObject, signal: AbortSignal): Promise<CallToolResult>;
  onCatalogChanged(listener: () => void): () => void;
  onDisconnect(listener: () => void): () => void;
  /** What happens in Live as it happens (the bridge's notifications/live_event, once subscribed; pointed events always). */
  onLiveEvent?(listener: (event: JsonObject) => void): () => void;
  stderrStatus(): { bytes: number; truncated: boolean };
  close(): Promise<void>;
}
interface Options {
  signal: AbortSignal;
  bridgeConfig?: string;
  /** Host-only injection for protocol tests. The CLI never accepts executable/entry overrides. */
  entry?: string;
  args?: string[];
  /** Per request. */
  timeoutMs?: number;
  /** Starting the child and the MCP handshake; defaults to the request timeout. */
  connectTimeoutMs?: number;
  onDispatch?: (name: string) => void;
  /**
   * Ask the bridge to expose exactly these tools (the ones Kumi's reads, changes and actions use);
   * it refuses every other one, so audio capture, files, projects and realtime control stay off
   * even if Kumi's own checks were bypassed. Without it the bridge runs read-only.
   */
  allowTools?: readonly string[];
  /** Where the bridge runs; the repository root by default, where it finds the protocol registry. */
  cwd?: string;
}

export async function connectMcp(options: Options): Promise<McpEndpoint> {
  options.signal.throwIfAborted();
  const timeout = options.timeoutMs ?? 15_000;
  const connectTimeout = options.connectTimeoutMs ?? timeout;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(connectTimeout) || connectTimeout < 1) throw new Error("Invalid MCP timeout");
  const entry = options.entry ?? bridgeEntry;
  const environment: Record<string, string> = {
    // Override the SDK's automatic defaults; no model keys, auth paths, NODE_OPTIONS or loader hooks.
    HOME: process.env.HOME ?? "", LOGNAME: "", USER: "", SHELL: "", TERM: "dumb", PATH: dirname(process.execPath),
    ...(options.allowTools?.length
      ? { ABLETON_MCP_TOOL_POLICY: "full", ABLETON_MCP_TOOL_ALLOW: [...new Set(options.allowTools)].sort().join(",") }
      : { ABLETON_MCP_TOOL_POLICY: "read-only" }),
  };
  // Windows runtime variables are not inference credentials. No complete process.env inheritance.
  for (const key of ["SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP"]) if (process.env[key]) environment[key] = process.env[key]!;
  const transport = new OwnedStdioTransport({ command: process.execPath,
    args: [entry, ...(options.bridgeConfig ? ["--config", options.bridgeConfig] : []), ...(options.args ?? [])],
    // The standalone bridge resolves protocol assets from the repository root.
    env: environment, stderr: "pipe", cwd: options.cwd ?? fileURLToPath(new URL("../../../../../", import.meta.url)), maxBufferSize: MAX_BRIDGE_MESSAGE_BYTES,
  });
  const client = new Client({ name: "kumi", version: KUMI_VERSION }, { capabilities: {} });
  const catalogListeners = new Set<() => void>();
  const disconnectListeners = new Set<() => void>();
  let ready = false;
  let disconnected = false;
  let closing: Promise<void> | undefined;
  let ownedPid: number | null = null;
  let stderrBytes = 0;
  let stderrTruncated = false;
  // Drain early output to avoid child backpressure, retaining only bounded byte-count metadata.
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTruncated ||= stderrBytes + chunk.length > 64 * 1024;
    stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.length);
  });
  const disconnectedOnce = () => {
    ready = false;
    if (disconnected) return;
    disconnected = true;
    for (const listener of [...disconnectListeners]) listener();
  };
  client.onclose = disconnectedOnce;
  // An answer (or progress) for a request Kumi stopped waiting for can cross the cancel on its way:
  // Live quitting mid-request does this. The connection is fine; anything else ends it.
  client.onerror = (error) => {
    if (/^Received a (response for an unknown message ID|progress notification for an unknown token)/.test(error?.message ?? "")) return;
    disconnectedOnce(); void close().catch(() => {});
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    for (const listener of [...catalogListeners]) listener();
  });
  // Live's events: a method the SDK has no schema for, so it comes through the fallback handler.
  const liveEventListeners = new Set<(event: JsonObject) => void>();
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "notifications/live_event" || !notification.params || typeof notification.params !== "object") return;
    for (const listener of [...liveEventListeners]) { try { listener(notification.params as JsonObject); } catch { /* a listener failure must not affect the link */ } }
  };
  function requireReady(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!ready || closing) throw new Error("Kumi's link to Live is down; it reconnects when Live is back.");
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      ready = false;
      await client.close(); // SDK alone owns stdin close → SIGTERM → SIGKILL for this child.
      disconnectedOnce();
      if (ownedPid) {
        for (let attempt = 0; attempt < 20; attempt++) {
          try { process.kill(ownedPid, 0); } catch { return; }
          await delay(10);
        }
        throw new Error("Owned MCP child exit could not be verified");
      }
    });
    return closing;
  }
  try {
    await client.connect(transport, { signal: options.signal, timeout: connectTimeout, maxTotalTimeout: connectTimeout });
    ownedPid = transport.ownedPid;
    options.signal.throwIfAborted();
    if (disconnected) throw new Error("MCP disconnected during initialization");
    ready = true;
    return {
      get pid() { return ownedPid; },
      get serverInfo() { return client.getServerVersion(); },
      async list(cursor, signal) {
        requireReady(signal);
        try {
          return ListToolsResultSchema.parse(await client.listTools(cursor === undefined ? {} : { cursor }, { signal, timeout, maxTotalTimeout: timeout }));
        } catch { throw new Error(signal.aborted ? "MCP request cancelled" : "MCP request failed or timed out"); }
      },
      async call(name, args, signal) {
        requireReady(signal);
        options.onDispatch?.(name);
        try {
          // SDK v1 cancellation belongs in the THIRD argument, after the result schema.
          return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal, timeout, maxTotalTimeout: timeout }));
        } catch (error) {
          // The bridge's own word on bad arguments ("trackRef is required") helps the caller correct them.
          if (!signal.aborted && error instanceof McpError && error.code === ErrorCode.InvalidParams) {
            const reason = error.message.replace(/^(?:MCP error -?\d+:\s*)+/, "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
            return { isError: true, content: [{ type: "text", text: `The bridge rejected the arguments: ${reason}` }] };
          }
          throw new Error(signal.aborted ? "MCP request cancelled" : "MCP request failed or timed out");
        }
      },
      onCatalogChanged(listener) { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; },
      onDisconnect(listener) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
      onLiveEvent(listener) { liveEventListeners.add(listener); return () => { liveEventListeners.delete(listener); }; },
      stderrStatus: () => ({ bytes: stderrBytes, truncated: stderrTruncated }),
      close,
    };
  } catch {
    ownedPid = transport.ownedPid;
    await close();
    throw new Error("MCP connection failed; check the built bridge, config and Live setup");
  }
}
