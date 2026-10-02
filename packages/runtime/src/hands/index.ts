/**
 * Kumi's hands: what Live's scripting can't do, done the way the producer would, through Live's own
 * menus and keys (group, freeze, flatten, bounce, consolidate, convert to MIDI, separate stems, save,
 * export). A small helper program for each OS stays running beside Kumi and answers in milliseconds:
 * on a Mac a Swift program using Accessibility, on Windows a PowerShell one using UI Automation.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { HANDS_VERSION, MAC_SOURCE } from "./mac.js";
import { WINDOWS_SOURCE } from "./windows.js";

/** A menu item of Live's: its place ("Edit", "Group Tracks"), whether it's enabled now, and its key. */
export interface MenuItem { path: string[]; enabled: boolean; key?: string; modifiers?: number }
export interface HandsReply { ok: boolean; error?: string; ms?: number; [field: string]: unknown }

export class HandsError extends Error {
  constructor(message: string, readonly kind: "untrusted" | "no-live" | "unavailable" | "failed" = "failed") { super(message); }
}

export interface Hands {
  /** Whether Kumi may drive Live's interface (macOS asks once, in System Settings); `prompt` shows macOS's own request. */
  trusted(prompt?: boolean): Promise<boolean>;
  /** Live's menus as they are now. */
  menus(signal?: AbortSignal): Promise<MenuItem[]>;
  /** Press a menu item, by its titles ("Edit", "Group Tracks"); `front` brings Live forward for it and gives the front back. */
  menu(path: readonly string[], options?: { front?: boolean; signal?: AbortSignal }): Promise<HandsReply>;
  /** Press keys in Live ("cmd+g", "shift+down"), one combination after another. */
  keys(combos: readonly string[], options?: { signal?: AbortSignal; gapMs?: number }): Promise<HandsReply>;
  /** Live's dialog, if one is up: its words and buttons. */
  dialog(signal?: AbortSignal): Promise<{ open: boolean; title?: string; words?: string[]; buttons?: string[] }>;
  /** Press a button of Live's dialog by its title. */
  answer(button: string, signal?: AbortSignal): Promise<HandsReply>;
  /** Live's windows (a plug-in's window among them), by title. */
  windows(signal?: AbortSignal): Promise<{ title: string; subrole: string }[]>;
  close(): void;
}

/** Where Kumi keeps programs it builds or fetches for itself. */
const toolsDir = () => process.env.KUMI_TOOLS_DIR ?? join(process.env.KUMI_HOME ?? join(homedir(), ".kumi"), "tools");

/**
 * The Mac helper: a build Kumi's release carries (beside the runtime), one Kumi built before, or one it
 * builds now from its source (Xcode's command line tools have swiftc). Undefined when none can be had.
 */
export async function macHelper(options: { onBuild?: (message: string) => void; /** false: only one that's there already. */ build?: boolean } = {}): Promise<string | undefined> {
  if (process.env.KUMI_HANDS) return process.env.KUMI_HANDS;
  const digest = createHash("sha256").update(MAC_SOURCE).digest("hex").slice(0, 12);
  // A release carries it built (universal, signed) in packages/runtime/hands; this file is dist/src/hands/index.js.
  const carried = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hands", `kumi-hands-${digest}`);
  if (existsSync(carried)) {
    try { accessSync(carried, constants.X_OK); } catch { try { chmodSync(carried, 0o755); } catch { /* run it anyway */ } }
    return carried;
  }
  const folder = join(toolsDir(), "hands");
  const built = join(folder, `kumi-hands-${digest}`);
  if (existsSync(built)) return built;
  if (options.build === false || spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0) return undefined;
  options.onBuild?.("Getting Kumi's hands ready, once (a few seconds)…");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const source = join(folder, `KumiHands-${digest}.swift`);
  await writeFile(source, MAC_SOURCE);
  const temporary = `${built}.${process.pid}`;
  const compiled = await new Promise<number>((resolve) => {
    const child = spawn("xcrun", ["swiftc", "-O", "-o", temporary, source], { stdio: "ignore" });
    child.once("error", () => resolve(1)); child.once("exit", (code) => resolve(code ?? 1));
  });
  await rm(source, { force: true });
  if (compiled !== 0 || !existsSync(temporary)) { await rm(temporary, { force: true }); return undefined; }
  await rename(temporary, built);
  return built;
}

/** Whether a Mac could build the helper (Xcode's command line tools are there). */
export const canBuildHands = () => process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

/** Kumi's hands for this computer; undefined where it has none (Linux, or a Mac without the helper). */
export async function openHands(options: { onBuild?: (message: string) => void; timeoutMs?: number; build?: boolean } = {}): Promise<Hands | undefined> {
  if (process.platform === "darwin") {
    const helper = await macHelper(options);
    return helper ? persistent(helper, [], options.timeoutMs) : undefined;
  }
  if (process.platform === "win32") {
    // From a file: a script this long and quoted doesn't survive a command line.
    const digest = createHash("sha256").update(WINDOWS_SOURCE).digest("hex").slice(0, 12);
    const folder = join(toolsDir(), "hands");
    const script = join(folder, `kumi-hands-${digest}.ps1`);
    if (!existsSync(script)) { await mkdir(folder, { recursive: true }); await writeFile(script, WINDOWS_SOURCE); }
    return persistent("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], options.timeoutMs ?? 8_000);
  }
  return undefined;
}

/** A helper kept running, one request a line; started again if it ends. */
function persistent(command: string, args: string[], timeoutMs = 4_000): Hands {
  let child: ChildProcessWithoutNullStreams | undefined;
  let next = 1;
  const waiting = new Map<number, (reply: HandsReply) => void>();
  const start = () => {
    if (child && child.exitCode === null && !child.killed) return child;
    const started = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    started.unref();
    (started.stdout as unknown as { unref?: () => void }).unref?.();
    (started.stdin as unknown as { unref?: () => void }).unref?.();
    createInterface({ input: started.stdout }).on("line", (line) => {
      let reply: HandsReply & { id?: number };
      try { reply = JSON.parse(line) as HandsReply & { id?: number }; } catch { return; }
      const answer = typeof reply.id === "number" ? waiting.get(reply.id) : undefined;
      if (answer) { waiting.delete(reply.id!); answer(reply); }
    });
    started.stderr.resume();
    started.once("exit", () => { for (const [, answer] of waiting) answer({ ok: false, error: "helper-ended" }); waiting.clear(); child = undefined; });
    started.once("error", () => { for (const [, answer] of waiting) answer({ ok: false, error: "helper-failed" }); waiting.clear(); child = undefined; });
    child = started;
    return started;
  };
  const ask = (op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal, wait = timeoutMs): Promise<HandsReply> => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new HandsError("Live didn't answer in time; is a dialog open in Live?")); }, wait);
    const aborted = () => { clearTimeout(timer); waiting.delete(id); reject(signal?.reason instanceof Error ? signal.reason : new HandsError("Stopped")); };
    signal?.addEventListener("abort", aborted, { once: true });
    waiting.set(id, (reply) => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve(reply); });
    try { start().stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`); }
    catch { clearTimeout(timer); waiting.delete(id); reject(new HandsError("Kumi's hands couldn't start.", "unavailable")); }
  });
  /** A reply that failed for a reason the producer can fix, in their words. */
  const checked = (reply: HandsReply): HandsReply => {
    if (reply.ok) return reply;
    if (reply.error === "untrusted") throw new HandsError(process.platform === "darwin"
      ? "Kumi needs Accessibility access to use Live's menus: System Settings › Privacy & Security › Accessibility, then turn on the app Kumi runs in (your terminal). Then ask again."
      : "Windows refused Kumi's access to Live's window.", "untrusted");
    if (reply.error === "no-live") throw new HandsError("Live isn't running.", "no-live");
    return reply;
  };
  return {
    async trusted(prompt = false) { const reply = await ask("trusted", { prompt }); return reply.trusted === true; },
    async menus(signal) {
      const reply = checked(await ask("menus", {}, signal));
      return Array.isArray(reply.items) ? (reply.items as MenuItem[]) : [];
    },
    async menu(path, options = {}) { return checked(await ask("menu", { path, front: options.front ?? true }, options.signal)); },
    async keys(combos, options = {}) { return checked(await ask("keys", { keys: combos, ...(options.gapMs !== undefined ? { gapMs: options.gapMs } : {}) }, options.signal)); },
    async dialog(signal) {
      const reply = checked(await ask("dialog", {}, signal));
      return { open: reply.open === true, ...(typeof reply.title === "string" ? { title: reply.title } : {}),
        ...(Array.isArray(reply.words) ? { words: reply.words as string[] } : {}), ...(Array.isArray(reply.buttons) ? { buttons: reply.buttons as string[] } : {}) };
    },
    async answer(button, signal) { return checked(await ask("answer", { button }, signal)); },
    async windows(signal) {
      const reply = checked(await ask("windows", {}, signal));
      return Array.isArray(reply.windows) ? (reply.windows as { title: string; subrole: string }[]) : [];
    },
    close() { child?.stdin.end(); child?.kill(); child = undefined; },
  };
}

export { HANDS_VERSION };
