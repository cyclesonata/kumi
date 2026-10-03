/**
 * Kumi's end of its listening devices: a UDP socket on this computer's loopback that hears every
 * device's hello (where it sits in the Set, the port it listens on) and sends it arm, write and stop,
 * each answered with a token. Several Kumis can run at once: each takes the first free port of
 * KUMI_PORTS, and a device answers whichever asked.
 */
import { randomUUID } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { decodeOscPacket, encodeOsc, type OscArg, type OscMessage } from "./osc.js";
import { EARS_VERSION, KUMI_PORTS } from "./device.js";

/** A listening device Kumi has heard from. */
export interface Tap {
  /** Its id in Live (the Live object's own). */
  id: number;
  /** Where it listens. */
  port: number;
  /** Where it sits: "live_set tracks 3 devices 2", "live_set master_track devices 0"… */
  path: string;
  version: number;
  sampleRate: number;
  /** When it last said hello (ms since the epoch). */
  seenAt: number;
  /** When it loaded in Live (ms since the epoch), from its age at that hello; undefined from an older device. */
  loadedAt?: number;
}

/** What a device said when it started recording: where the Set was then, and whether it played. */
export interface Armed { beats: number; running: boolean; sampleRate: number }
/** What a device said once it wrote its buffer. */
export interface Written { file: string; sampleRate: number; channels: number; beats: number; running: boolean }

export class EarsError extends Error {}

export interface EarsLink {
  /** The port this Kumi listens on. */
  readonly port: number;
  /** Devices heard from in the last few seconds. */
  taps(): Tap[];
  /** The first device (heard now or from now on) that `match` accepts, or undefined after `timeoutMs`. */
  waitFor(match: (tap: Tap) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<Tap | undefined>;
  /** Start a device recording, for up to `seconds`. */
  arm(tap: Tap, seconds: number, signal?: AbortSignal): Promise<Armed>;
  /** Stop a device recording, and have it write what it holds to `file`. */
  write(tap: Tap, file: string, signal?: AbortSignal): Promise<Written>;
  /** Stop a device recording (nothing written). */
  stop(tap: Tap): void;
  /** Ask a device where it is now. */
  ping(tap: Tap, signal?: AbortSignal): Promise<Tap | undefined>;
  /** Where Live's transport is, as a device hears it: its position in beats and whether it plays; undefined when it doesn't answer. */
  transport(tap: Tap, signal?: AbortSignal): Promise<{ beats: number; running: boolean } | undefined>;
  close(): Promise<void>;
}

/** How long a device's silence means it's gone: its hello comes every two seconds. */
const GONE_MS = 7_000;
const REPLY_MS = 3_000;

/** Kumi's listening socket, on the first free port of KUMI_PORTS (or `port`, for tests). */
export async function openEarsLink(options: { port?: number; ports?: readonly number[] } = {}): Promise<EarsLink> {
  const candidates = options.port !== undefined ? [options.port] : [...(options.ports ?? KUMI_PORTS)];
  let socket: Socket | undefined;
  let bound = 0;
  for (const port of candidates) {
    const attempt = createSocket({ type: "udp4", reuseAddr: false });
    const ok = await new Promise<boolean>((resolve) => {
      attempt.once("error", () => resolve(false));
      attempt.bind(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) { socket = attempt; bound = (attempt.address()).port; break; }
    attempt.close();
  }
  if (!socket) throw new EarsError(`Kumi couldn't listen for its listening devices: ports ${candidates.join(", ")} are all taken.`);
  return link(socket, bound);
}

function link(socket: Socket, port: number): EarsLink {
  const known = new Map<number, Tap>();
  const watchers = new Set<(tap: Tap) => void>();
  const replies = new Map<string, (message: OscMessage) => void>();
  let closed = false;
  // A hello (or a pong) says where a device is now; a reply carries the token of what asked.
  socket.on("message", (packet) => {
    for (const message of decodeOscPacket(packet)) {
      if (message.address === "/kumi/ears/hello") { heard(message.args, 0); continue; }
      if (message.address === "/kumi/ears/pong") { const tap = heard(message.args, 1); const answer = replies.get(String(message.args[0] ?? "")); if (tap && answer) answer(message); continue; }
      const answer = replies.get(String(message.args[0] ?? ""));
      if (answer) answer(message);
    }
  });
  socket.on("error", () => { /* a malformed packet or a closed peer: the next hello says where things are */ });
  socket.unref();
  function heard(args: (number | string)[], from: number): Tap | undefined {
    const [devicePort, id, version, sampleRate, path, age] = args.slice(from);
    if (typeof devicePort !== "number" || typeof id !== "number" || typeof path !== "string") return undefined;
    const seenAt = Date.now();
    const tap: Tap = { id, port: devicePort, path: path.trim(), version: typeof version === "number" ? version : Number(version) || 0,
      sampleRate: typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : 44_100, seenAt, ...(typeof age === "number" && age >= 0 ? { loadedAt: seenAt - age } : {}) };
    known.set(id, tap);
    for (const watcher of [...watchers]) watcher(tap);
    return tap;
  }
  function send(tap: Pick<Tap, "port">, address: string, args: readonly OscArg[]): void {
    if (closed) return;
    socket.send(encodeOsc(address, args), tap.port, "127.0.0.1");
  }
  /** Send, then wait for the reply that carries this request's token. */
  function ask(tap: Tap, address: string, args: (token: string) => readonly OscArg[], expect: string, signal?: AbortSignal): Promise<OscMessage> {
    const token = randomUUID().slice(0, 12);
    return new Promise<OscMessage>((resolve, reject) => {
      const finish = (error?: Error, message?: OscMessage) => {
        clearTimeout(timer); replies.delete(token); signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(message!);
      };
      const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new EarsError("Stopped"));
      const timer = setTimeout(() => finish(new EarsError(`Kumi's listening device on ${describe(tap.path)} didn't answer.`)), REPLY_MS);
      replies.set(token, (message) => { if (message.address === expect) finish(undefined, message); });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      send(tap, address, args(token));
    });
  }
  return {
    port,
    taps: () => [...known.values()].filter((tap) => Date.now() - tap.seenAt < GONE_MS && tap.version === EARS_VERSION),
    waitFor(match, timeoutMs, signal) {
      const now = [...known.values()].find((tap) => Date.now() - tap.seenAt < GONE_MS && tap.version === EARS_VERSION && match(tap));
      if (now) return Promise.resolve(now);
      return new Promise((resolve) => {
        const done = (tap: Tap | undefined) => { clearTimeout(timer); watchers.delete(watcher); signal?.removeEventListener("abort", stop); resolve(tap); };
        const watcher = (tap: Tap) => { if (tap.version === EARS_VERSION && match(tap)) done(tap); };
        const stop = () => done(undefined);
        const timer = setTimeout(() => done(undefined), timeoutMs);
        watchers.add(watcher);
        signal?.addEventListener("abort", stop, { once: true });
      });
    },
    async arm(tap, seconds, signal) {
      const reply = await ask(tap, "/kumi/ears/arm", (token) => [{ float: seconds }, port, token], "/kumi/ears/armed", signal);
      const [, , beats, running, sampleRate] = reply.args;
      return { beats: typeof beats === "number" ? beats : 0, running: running === 1, sampleRate: typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : tap.sampleRate };
    },
    async write(tap, file, signal) {
      const reply = await ask(tap, "/kumi/ears/write", (token) => [file, port, token], "/kumi/ears/written", signal);
      const [, , written, sampleRate, channels, beats, running] = reply.args;
      return { file: typeof written === "string" && written ? written : file, sampleRate: typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : tap.sampleRate,
        channels: typeof channels === "number" && channels > 0 ? channels : 3, beats: typeof beats === "number" ? beats : 0, running: running === 1 };
    },
    stop(tap) { send(tap, "/kumi/ears/stop", ["", port, ""]); },
    async ping(tap, signal) {
      try {
        await ask(tap, "/kumi/ears/ping", (token) => ["", port, token], "/kumi/ears/pong", signal);
        return known.get(tap.id);
      } catch { return undefined; }
    },
    async transport(tap, signal) {
      try {
        const reply = await ask(tap, "/kumi/ears/ping", (token) => ["", port, token], "/kumi/ears/pong", signal);
        // The pong: token, port, id, version, sample rate, place, age, then the position and whether Live plays.
        const [beats, running] = reply.args.slice(7);
        return typeof beats === "number" ? { beats, running: running === 1 } : undefined;
      } catch (error) { signal?.throwIfAborted(); return undefined; }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const watcher of [...watchers]) watchers.delete(watcher);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}

/** A device's place in plain words ("track 4", "Main"), for messages. */
export function describe(path: string): string {
  const track = /live_set tracks (\d+)/.exec(path); if (track) return `track ${Number(track[1]) + 1}`;
  const ret = /live_set return_tracks (\d+)/.exec(path); if (ret) return `return ${String.fromCharCode(65 + Number(ret[1]))}`;
  if (/live_set master_track/.test(path)) return "Main";
  return "a track";
}

/** Where a device sits, from its path: the kind of track, its index among them, and the device's index. */
export function placeOf(path: string): { kind: "track" | "return" | "main"; index: number; device: number } | undefined {
  const match = /^live_set (tracks|return_tracks|master_track)(?: (\d+))? devices (\d+)$/.exec(path.trim());
  if (!match) return undefined;
  const kind = match[1] === "tracks" ? "track" : match[1] === "return_tracks" ? "return" : "main";
  return { kind, index: match[2] !== undefined ? Number(match[2]) : 0, device: Number(match[3]) };
}
