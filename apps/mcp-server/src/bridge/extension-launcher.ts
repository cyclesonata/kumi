import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExtensionEndpoint } from "./extension-channel.js";

/**
 * Starting Kumi's Live extension without installing anything into Live: Live 12.4 ships its Extension
 * Host (a Node and a native module), which connects to the running Live when started with an
 * extension. Only one Extension Host connects to a Live at a time, so every bridge shares one: the
 * first starts it (detached, so it outlives that bridge) and the others find its endpoint file. It
 * stops by itself when Live goes.
 */
export interface ExtensionHostBinary { node: string; module: string }

const MODULE = "ExtensionHostNodeModule.node";

function hostIn(directory: string): ExtensionHostBinary | undefined {
  const node = join(directory, process.platform === "win32" ? "node.exe" : "node"); const module = join(directory, MODULE);
  return existsSync(module) && existsSync(node) ? { node, module } : undefined;
}

/** The running Live's application (macOS: "/Applications/Ableton Live 12 Beta.app"), if Live is running. */
function runningLiveApp(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const listing = spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" });
  const line = (listing.stdout ?? "").split("\n").find((entry) => /\.app\/Contents\/MacOS\/Live$/.test(entry.trim()));
  return line ? line.trim().replace(/\/Contents\/MacOS\/Live$/, "") : undefined;
}

/** Live's Extension Host: from `liveApp` when given, else the running Live, else the usual install places. */
export function findExtensionHost(liveApp?: string): ExtensionHostBinary | undefined {
  const candidates: string[] = [];
  const add = (path: string | undefined) => { if (path) candidates.push(path.endsWith(".app") ? join(path, "Contents", "Helpers", "ExtensionHost") : path.endsWith(".exe") ? join(dirname(path), "ExtensionHost") : path); };
  add(liveApp); add(runningLiveApp());
  if (process.platform === "darwin") {
    for (const name of existsSync("/Applications") ? readdirSync("/Applications") : []) if (/^Ableton Live 12.*\.app$/.test(name)) add(join("/Applications", name));
  } else if (process.platform === "win32") {
    const root = join(process.env.ProgramData ?? "C:\\ProgramData", "Ableton");
    for (const name of existsSync(root) ? readdirSync(root) : []) if (/^Live 12/.test(name)) add(join(root, name, "Program", "ExtensionHost"));
  }
  for (const candidate of candidates) { const found = hostIn(candidate); if (found) return found; }
  return undefined;
}

const isExtension = (directory: string) => existsSync(join(directory, "manifest.json")) && existsSync(join(directory, "package.json")) && existsSync(join(directory, "dist", "extension.js"));

/** Kumi's extension as the bridge carries it: staged beside the package, or in the repository's apps/live-extension. */
export function findExtensionBundle(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "..", "..", "live-extension"), join(here, "..", "..", "..", "..", "live-extension")].find(isExtension);
}

/** A pause that never keeps the bridge's process alive on its own. */
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

export interface LaunchOptions { storageDirectory: string; extension?: string; liveApp?: string; waitMs?: number; log?: (line: string) => void }

function ensureSecret(storageDirectory: string): void {
  const path = join(storageDirectory, "secret");
  if (existsSync(path) && readFileSync(path, "utf8").trim().length >= 32) return;
  writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}

/** A lock so two bridges starting at once don't both start an Extension Host; a stale lock (30 s) is taken over. */
function takeLock(storageDirectory: string): (() => void) | undefined {
  const path = join(storageDirectory, "launch.lock");
  try { if (Date.now() - statSync(path).mtimeMs > 30_000) rmSync(path, { force: true }); } catch { /* no lock */ }
  try { closeSync(openSync(path, "wx", 0o600)); return () => rmSync(path, { force: true }); } catch { return undefined; }
}

/**
 * Starts Live's Extension Host with Kumi's extension, unless one already answers, and waits for its
 * endpoint. Resolves either way; the channel then connects or says why it couldn't.
 */
export async function launchExtension(options: LaunchOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  mkdirSync(options.storageDirectory, { recursive: true, mode: 0o700 });
  if (readExtensionEndpoint(options.storageDirectory)) return;
  const extension = options.extension ?? findExtensionBundle();
  const host = findExtensionHost(options.liveApp);
  if (!extension || !isExtension(extension)) { log("extension channel: Kumi's Live extension isn't with this bridge"); return; }
  if (!host) { log("extension channel: this Live has no Extension Host (Live 12.4 or later has one)"); return; }
  const unlock = takeLock(options.storageDirectory);
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  if (!unlock) {
    // Another bridge is starting it: wait for its endpoint.
    while (Date.now() < deadline && !readExtensionEndpoint(options.storageDirectory)) await pause(100);
    return;
  }
  try {
    ensureSecret(options.storageDirectory);
    const temp = join(options.storageDirectory, "tmp"); mkdirSync(temp, { recursive: true, mode: 0o700 });
    const config = { extensions: [{ path: extension.replace(/\\/g, "/"), storageDirectory: options.storageDirectory.replace(/\\/g, "/"), tempDirectory: temp.replace(/\\/g, "/") }] };
    const logFile = openSync(join(options.storageDirectory, "extension-host.log"), "a", 0o600);
    // The Extension Host waits for Live indefinitely; if Kumi's extension hasn't started within 20 s
    // (another Extension Host holds Live, or Live quit), it ends itself rather than wait on.
    const script = `setTimeout(() => { if (!globalThis.__kumiLiveExtensionActive) process.exit(3); }, 20000); require(${JSON.stringify(host.module.replace(/\\/g, "/"))}).initialize(${JSON.stringify(config)});`;
    const child = spawn(host.node, ["-e", script], { detached: true, stdio: ["ignore", logFile, logFile], windowsHide: true });
    closeSync(logFile);
    child.unref();
    log(`extension channel: started Live's Extension Host (pid ${child.pid}) with ${extension}`);
    while (Date.now() < deadline) {
      const endpoint = readExtensionEndpoint(options.storageDirectory);
      if (endpoint?.pid === child.pid) return;
      if (child.exitCode !== null) { log(`extension channel: the Extension Host stopped (${child.exitCode})`); return; }
      await pause(100);
    }
    // It never reached Live (another Extension Host holds Live, or Live isn't running): don't leave it waiting.
    log("extension channel: the Extension Host didn't reach Live in time; stopping it");
    try { if (child.pid) process.kill(child.pid); } catch { /* already gone */ }
  } finally { unlock(); }
}
