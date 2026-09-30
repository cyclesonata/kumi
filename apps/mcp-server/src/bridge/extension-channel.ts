import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { LIVE_REGISTRY_HASH, type LiveEvent, type LiveOperationContext, type LiveStatus } from "../live.js";
import { LOOPBACK_PROTOCOL_VERSION } from "../loopback.js";
import { validateLiveOperationRequest, validateLiveOperationResult } from "../registry.js";

/**
 * The bridge's second channel into Live: Kumi's Live extension (apps/live-extension), running in
 * Live's Extension Host. It speaks the Remote Script's wire (signed hello with the registry hash,
 * signed requests by id, signed events) without the preflight/prepare handshake: the shared secret is
 * the authority. The extension writes where it listens (`endpoint.json`) and the secret into its
 * storage directory; the bridge reads both from there.
 */
export interface ExtensionEndpoint { host: string; port: number; pid: number; extensionVersion: string; registryHash: string; apiVersion: string; startedAt: number }
export interface ExtensionChannelOptions {
  storageDirectory: string;
  /** Starts an Extension Host with Kumi's extension when none answers; resolves once it may have. */
  launch?: () => Promise<void>;
  /** Whether looking for the extension makes sense now (a real Live is connected); default always. */
  enabled?: () => boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const MAX_FRAME_BYTES = 256 * 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

function canonical(value: unknown, depth = 0): string {
  if (depth > 256) throw new Error("wire payload is too deeply nested");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("wire number is not finite"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`; }
  throw new Error("unsupported wire value");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The extension's endpoint, when its file is there and its process is running. */
export function readExtensionEndpoint(storageDirectory: string): ExtensionEndpoint | undefined {
  const path = join(storageDirectory, "endpoint.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ExtensionEndpoint>;
    if (value.host !== "127.0.0.1" || !Number.isInteger(value.port) || !Number.isInteger(value.pid) || !alive(value.pid!)) return undefined;
    return value as ExtensionEndpoint;
  } catch { return undefined; }
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout; operation: string };

export class ExtensionChannel {
  private socket?: Socket;
  private secret?: string;
  private hello?: { bridgeEpoch: string; connectionChallenge: string };
  private cached?: LiveStatus & { extension?: Record<string, unknown> };
  private sequence = 0;
  private pieces: Buffer[] = [];
  private buffered = 0;
  private connecting?: Promise<boolean>;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private readonly statusListeners = new Set<(status: LiveStatus | undefined) => void>();
  endpoint?: ExtensionEndpoint;
  /** Why the channel is down, in plain words (for status and `kumi doctor`). */
  reason = "not connected yet";

  constructor(private readonly options: ExtensionChannelOptions) {}

  /** The extension's status while connected; undefined otherwise. */
  status(): (LiveStatus & { extension?: Record<string, unknown> }) | undefined { return this.socket && !this.socket.destroyed ? this.cached : undefined; }

  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeStatus(listener: (status: LiveStatus | undefined) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }

  /** Connects (starting the extension if there's a launcher and nothing answers); true once connected. */
  connect(): Promise<boolean> {
    if (this.status()) return Promise.resolve(true);
    if (this.options.enabled && !this.options.enabled()) { this.reason = "no real Live is connected"; return Promise.resolve(false); }
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<boolean> {
    let endpoint = readExtensionEndpoint(this.options.storageDirectory);
    if (!endpoint && this.options.launch) {
      await this.options.launch();
      endpoint = readExtensionEndpoint(this.options.storageDirectory);
    }
    if (!endpoint) { this.reason = "Kumi's Live extension isn't running"; return false; }
    if (endpoint.registryHash !== LIVE_REGISTRY_HASH) { this.reason = "Kumi's Live extension is from another bridge version"; return false; }
    let secret: string;
    try { secret = readFileSync(join(this.options.storageDirectory, "secret"), "utf8").trim(); } catch { this.reason = "the extension's secret is missing"; return false; }
    if (secret.length < 32) { this.reason = "the extension's secret is too short"; return false; }
    this.secret = secret; this.endpoint = endpoint;
    try {
      await this.handshake(endpoint);
      const status = await this.request({ method: "status" }, "status") as LiveStatus & { extension?: Record<string, unknown> };
      if (status.adapter !== "extension" || status.registryHash !== LIVE_REGISTRY_HASH) throw new Error("Kumi's Live extension answered for something else");
      this.cached = status; this.reason = "connected";
      for (const listener of this.statusListeners) listener(this.cached);
      this.options.log?.(`extension channel: connected to Kumi's Live extension ${endpoint.extensionVersion} on port ${endpoint.port}`);
      return true;
    } catch (error) {
      this.reason = error instanceof Error ? error.message : "the extension didn't answer";
      this.socket?.destroy(); this.socket = undefined;
      return false;
    }
  }

  private handshake(endpoint: ExtensionEndpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: endpoint.host, port: endpoint.port });
      this.socket = socket; this.hello = undefined; this.sequence = 0; this.pieces = []; this.buffered = 0;
      socket.setNoDelay(true);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("the extension didn't greet the bridge")); }, 5_000);
      socket.on("data", (chunk: Buffer) => { try { this.onData(chunk, () => { clearTimeout(timer); resolve(); }); } catch (error) { clearTimeout(timer); socket.destroy(); reject(error as Error); } });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("close", () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = undefined; this.reason = "Kumi's Live extension closed the connection";
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Kumi's Live extension closed the connection")); }
        this.pending.clear();
        for (const listener of this.statusListeners) listener(undefined);
      });
    });
  }

  private mac(payload: Record<string, unknown>): string { return createHmac("sha256", this.secret!).update(canonical(payload)).digest("base64url"); }

  private verify(frame: Record<string, unknown>): boolean {
    const { mac, ...unsigned } = frame;
    if (typeof mac !== "string") return false;
    const expected = Buffer.from(this.mac(unsigned)); const received = Buffer.from(mac);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private onData(chunk: Buffer, greeted: () => void): void {
    this.pieces.push(chunk); this.buffered += chunk.length;
    if (chunk.indexOf(10) < 0) { if (this.buffered > MAX_FRAME_BYTES) throw new Error("the extension sent a frame beyond the bound"); return; }
    let buffer = Buffer.concat(this.pieces); this.pieces = []; this.buffered = 0;
    for (let index = buffer.indexOf(10); index >= 0; index = buffer.indexOf(10)) {
      const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      if (line.length === 0) continue;
      const frame = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      if (frame.version !== LOOPBACK_PROTOCOL_VERSION || !this.verify(frame)) throw new Error("the extension's answer isn't signed with the bridge's secret");
      if (frame.id === "hello") {
        const result = frame.result as { registryHash?: unknown } | undefined;
        if (result?.registryHash !== LIVE_REGISTRY_HASH) throw new Error("Kumi's Live extension is from another bridge version");
        this.hello = { bridgeEpoch: String(frame.bridgeEpoch), connectionChallenge: String(frame.connectionChallenge) };
        greeted(); continue;
      }
      if (!this.hello || frame.bridgeEpoch !== this.hello.bridgeEpoch || frame.connectionChallenge !== this.hello.connectionChallenge) throw new Error("the extension's answer belongs to another connection");
      if (frame.id === "event") {
        const event = (frame.result as { event?: LiveEvent } | undefined)?.event;
        if (event && typeof event.type === "string") for (const listener of this.listeners) listener(event);
        continue;
      }
      const pending = this.pending.get(String(frame.id)); if (!pending) continue;
      this.pending.delete(String(frame.id)); clearTimeout(pending.timer);
      if (frame.ok === true) {
        try { if (pending.operation !== "status") validateLiveOperationResult(pending.operation, frame.result); pending.resolve(frame.result); }
        catch (error) { pending.reject(error as Error); }
      } else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "Kumi's Live extension refused the request"));
    }
    if (buffer.length > 0) { this.pieces.push(buffer); this.buffered = buffer.length; }
  }

  private request(fields: Record<string, unknown>, operation: string, context?: LiveOperationContext): Promise<unknown> {
    const socket = this.socket; const hello = this.hello;
    if (!socket || socket.destroyed || !hello) return Promise.reject(new Error("Kumi's Live extension isn't connected"));
    if (context?.signal?.aborted) return Promise.reject(new Error("request cancelled before dispatch"));
    const timeoutMs = context?.deadlineMs !== undefined ? Math.max(1, context.deadlineMs - Date.now()) : (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const id = `ext-${++this.sequence}`;
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id, ...fields, nonce: randomBytes(18).toString("base64url"), sequence: this.sequence, bridgeEpoch: hello.bridgeEpoch, connectionChallenge: hello.connectionChallenge, deadlineMs: Date.now() + Math.min(timeoutMs, 600_000) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Kumi's Live extension didn't answer ${operation} in time`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, operation });
      socket.write(`${JSON.stringify({ ...unsigned, mac: this.mac(unsigned) })}\n`);
    });
  }

  /** One registry operation on the extension; its arguments and result are checked against the registry. */
  async invoke(operation: string, args: Record<string, unknown>, context?: LiveOperationContext): Promise<unknown> {
    if (!await this.connect()) throw new Error(`Kumi's Live extension is unavailable: ${this.reason}`);
    if (!this.cached?.operations?.includes(operation)) throw new Error(`Kumi's Live extension doesn't offer ${operation}`);
    validateLiveOperationRequest(operation, args);
    return this.request({ method: "invoke", operation, args }, operation, context);
  }

  async close(): Promise<void> {
    const socket = this.socket; this.socket = undefined;
    socket?.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("the extension channel closed")); }
    this.pending.clear();
  }
}
