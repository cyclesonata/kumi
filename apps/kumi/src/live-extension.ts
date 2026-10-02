/**
 * Kumi's Live extension (apps/live-extension; the bridge package carries it as live-extension/). Live
 * runs every extension in its Extensions folder when it opens, so Kumi puts its own there with the
 * bridge. It renders tracks without playing them, writes MIDI clips in the Arrangement, and adds
 * "Ask Kumi about this" to Live's right-click menu. Live 12.4 or later; with Live's Developer Mode on
 * (Settings → Extensions), Live starts no extensions itself and the bridge starts Kumi's.
 */
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** Live names an extension's folder `<author>.<name>` in lower case. */
export const KUMI_EXTENSION_ID = "kumi.kumi";

/**
 * Live's Extensions folder: KUMI_LIVE_EXTENSIONS_DIR, else where Live keeps it: macOS's Application
 * Support (seen on Live 12.4), and its Windows counterpart, %LOCALAPPDATA%\Ableton, where Live keeps its
 * database too. Found from the environment it's given only: without HOME (LOCALAPPDATA on Windows)
 * there, it's undefined, so a partial environment (a test's) never reaches the producer's own Live.
 * Undefined where there's no Live.
 */
export function liveExtensionsDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.KUMI_LIVE_EXTENSIONS_DIR) return env.KUMI_LIVE_EXTENSIONS_DIR;
  if (platform === "darwin" && env.HOME) return join(env.HOME, "Library", "Application Support", "Ableton", "Extensions");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Ableton", "Extensions");
  return undefined;
}

/** Where Kumi 1.6.0 and before put its extension on Windows, %APPDATA%\Ableton, which Live doesn't read. */
export function formerExtensionsDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" && !env.KUMI_LIVE_EXTENSIONS_DIR && env.APPDATA ? join(env.APPDATA, "Ableton", "Extensions") : undefined;
}

/** Takes Kumi's extension out of the folder Kumi used to put it in, and that folder too once nothing else is in it. */
export function removeFormerExtension(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const folder = formerExtensionsDir(env, platform);
  if (!folder || !existsSync(join(folder, KUMI_EXTENSION_ID))) return false;
  removeExtension(folder);
  for (const left of [folder, join(dirname(folder), "Extensions Data")]) {
    try { if (existsSync(left) && readdirSync(left).length === 0) rmSync(left, { recursive: true, force: true }); } catch { /* someone's own: stays */ }
  }
  return true;
}

/** Where Kumi's extension keeps its endpoint and secret while Live runs it. */
export const extensionDataDir = (extensionsDir: string) => join(dirname(extensionsDir), "Extensions Data", KUMI_EXTENSION_ID);

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The extension a bridge package carries (or this repository's, beside its bridge), when it's complete. */
export function extensionSource(bridgeRoot: string): string | undefined {
  return [join(bridgeRoot, "live-extension"), join(bridgeRoot, "..", "live-extension")]
    .find((folder) => existsSync(join(folder, "manifest.json")) && existsSync(join(folder, "dist", "extension.js")));
}

export interface ExtensionCopy { path: string; version: string; digest: string }

/** An extension folder's version and the digest of its code. */
export function readExtension(folder: string): ExtensionCopy | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { version?: unknown };
    return { path: folder, version: typeof manifest.version === "string" ? manifest.version : "?", digest: digest(join(folder, "dist", "extension.js")) };
  } catch { return undefined; }
}

/** Kumi's extension as it is in Live's Extensions folder. */
export const installedExtension = (extensionsDir: string) => readExtension(join(extensionsDir, KUMI_EXTENSION_ID));

/**
 * Puts the extension in Live's Extensions folder, replacing an older copy whole (it's assembled
 * beside the folder first, where Live doesn't look). Refused when Live's own folder (the one that
 * holds Extensions) isn't there: Live isn't installed, or has never been opened.
 */
export function installExtension(source: string, extensionsDir: string): { path: string; version: string; changed: boolean; replaced: boolean } {
  const target = join(extensionsDir, KUMI_EXTENSION_ID);
  const wanted = readExtension(source);
  if (!wanted) throw new Error("Kumi's copy of its Live extension is incomplete");
  const current = readExtension(target);
  if (current?.digest === wanted.digest && current.version === wanted.version) return { path: target, version: wanted.version, changed: false, replaced: false };
  if (!existsSync(dirname(extensionsDir))) throw new Error(`Live's folder isn't there (${dirname(extensionsDir)}); open Live once`);
  mkdirSync(extensionsDir, { recursive: true });
  const staging = join(dirname(extensionsDir), `.kumi-extension-${process.pid}`);
  const retired = `${staging}-old`;
  rmSync(staging, { recursive: true, force: true }); rmSync(retired, { recursive: true, force: true });
  try {
    mkdirSync(join(staging, "dist"), { recursive: true });
    copyFileSync(join(source, "manifest.json"), join(staging, "manifest.json"));
    copyFileSync(join(source, "dist", "extension.js"), join(staging, "dist", "extension.js"));
    if (existsSync(join(source, "package.json"))) copyFileSync(join(source, "package.json"), join(staging, "package.json"));
    else writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "kumi", version: wanted.version, private: true, main: "dist/extension.js" }, null, 2)}\n`);
    if (existsSync(target)) renameSync(target, retired);
    renameSync(staging, target);
  } catch (error) {
    if (!existsSync(target) && existsSync(retired)) renameSync(retired, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(retired, { recursive: true, force: true });
  return { path: target, version: wanted.version, changed: true, replaced: current !== undefined };
}

/** Takes Kumi's extension out of Live: its folder and its data. Whether there was any. */
export function removeExtension(extensionsDir: string): boolean {
  const code = join(extensionsDir, KUMI_EXTENSION_ID); const data = extensionDataDir(extensionsDir);
  const had = existsSync(code) || existsSync(data);
  rmSync(code, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  return had;
}

export interface RunningExtension { folder: string; port: number; pid: number }

/** The extension whose endpoint is in `folder`, while its process lives. */
export function runningExtension(folder: string): RunningExtension | undefined {
  try {
    const endpoint = JSON.parse(readFileSync(join(folder, "endpoint.json"), "utf8")) as { host?: unknown; port?: unknown; pid?: unknown };
    if (endpoint.host !== "127.0.0.1" || !Number.isInteger(endpoint.port) || !Number.isInteger(endpoint.pid)) return undefined;
    try { process.kill(endpoint.pid as number, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined; }
    return { folder, port: endpoint.port as number, pid: endpoint.pid as number };
  } catch { return undefined; }
}

/** Whether the extension greets a connection (its first line is a signed hello), within `ms`. */
export function extensionAnswers(port: number, ms = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    const done = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), ms);
    socket.on("data", (chunk) => {
      text += String(chunk);
      const end = text.indexOf("\n"); if (end < 0) return;
      try { const hello = JSON.parse(text.slice(0, end)) as { id?: unknown; ok?: unknown }; done(hello.id === "hello" && hello.ok === true); } catch { done(false); }
    });
    socket.on("error", () => done(false));
  });
}
