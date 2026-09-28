import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema,
  type CallToolResult, type Implementation, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../core/contracts.js";

// SDK 1.30.1 starts an unawaited close on initialize failure, and its stdio
// close clears pid before exit. Share ONE close promise and retain owned identity.
class OwnedStdioTransport extends StdioClientTransport {
  ownedPid: number | null = null;
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
   * Ask the bridge to expose exactly these tools; it refuses every other one, so playback,
   * recording, audio capture and file tools stay off even if Kumi's own checks were bypassed.
   * Without it the bridge runs read-only.
   */
  allowTools?: readonly string[];
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
    env: environment, stderr: "pipe", cwd: fileURLToPath(new URL("../../../../../", import.meta.url)), maxBufferSize: 2 * 1024 * 1024,
  });
  const client = new Client({ name: "kumi", version: "0.0.1" }, { capabilities: {} });
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
  client.onerror = () => { disconnectedOnce(); void close().catch(() => {}); };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    for (const listener of [...catalogListeners]) listener();
  });
  function requireReady(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!ready || closing) throw new Error("MCP is disconnected; use /new to establish a fresh connection");
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
        } catch { throw new Error(signal.aborted ? "MCP request cancelled" : "MCP request failed or timed out"); }
      },
      onCatalogChanged(listener) { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; },
      onDisconnect(listener) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
      stderrStatus: () => ({ bytes: stderrBytes, truncated: stderrTruncated }),
      close,
    };
  } catch {
    ownedPid = transport.ownedPid;
    await close();
    throw new Error("MCP connection failed; check the built bridge, config and Live setup");
  }
}
