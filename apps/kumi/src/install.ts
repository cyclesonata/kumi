/**
 * An installed Kumi (the installer's launcher sets KUMI_INSTALLED and KUMI_HOME): updating it from
 * the latest GitHub release, going back to the one before, and removing it. The installer lays it out
 * as KUMI_HOME/app (Kumi), app.previous (the one before the last update), node (Kumi's own Node) and
 * bin (the `kumi` launcher). The producer's own files (settings, sign-ins, conversations, notes) sit
 * beside them in KUMI_HOME and stay unless they ask for everything to go.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { Readable as ReadableStream } from "node:stream";
import { pipeline } from "node:stream/promises";
import { KUMI, KUMI_VERSION } from "@kumi/runtime";
import { isLiveRunning, runProgram, type Ran } from "./bridge-setup.js";
import { findBridgeConfig, remoteScriptsDir } from "./config.js";
import { readBridgeServer } from "./doctor.js";

type Env = Readonly<Record<string, string | undefined>>;
type Run = (command: string, args: readonly string[], cwd?: string) => Promise<Ran>;

/** Where the installer put Kumi. */
export const kumiHome = (env: Env = process.env) => env.KUMI_HOME || join(homedir(), ".kumi");

/** Where releases are downloaded from: the latest GitHub release, unless KUMI_RELEASES says otherwise (tests, mirrors). */
export const releaseBase = (env: Env = process.env) => (env.KUMI_RELEASES || "https://github.com/user1303836/kumi/releases/latest/download").replace(/\/+$/, "");

/** What a release says about itself (kumi-release.json, next to the bundle). */
export interface ReleaseManifest { kumi: string; bundle: string; sha256: string; node: string; bridge?: string }

/** Whether version `left` ("1.0.2") is newer than `right`. */
export function newerVersion(left: string, right: string): boolean {
  const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0); const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}

/** The latest release's manifest; undefined when there's no network or it doesn't make sense. */
export async function fetchManifest(env: Env = process.env, fetcher: typeof fetch = fetch): Promise<ReleaseManifest | undefined> {
  try {
    const response = await fetcher(`${releaseBase(env)}/kumi-release.json`, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!response.ok) return undefined;
    const value = await response.json() as Partial<ReleaseManifest>;
    const ok = (text: unknown, pattern: RegExp) => typeof text === "string" && pattern.test(text);
    if (!ok(value.kumi, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/) || !ok(value.bundle, /^[\w.-]+\.tar\.gz$/) || !ok(value.sha256, /^[0-9a-f]{64}$/) || !ok(value.node, /^\d+\.\d+\.\d+$/)) return undefined;
    return value as ReleaseManifest;
  } catch { return undefined; }
}

async function download(url: string, file: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10 * 60_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`the download failed (${response.status})`);
  await pipeline(ReadableStream.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(file));
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface InstalledIo {
  out: Writable;
  env: Env;
  input?: Readable & { isTTY?: boolean };
  run?: Run;
  fetcher?: typeof fetch;
  liveRunning?: () => Promise<boolean>;
  confirm?: (question: string) => Promise<boolean>;
  /** Runs the new Kumi's `kumi bridge`, talking to the producer directly. */
  updateBridge?: (app: string) => Promise<number>;
}

function kumiBridge(home: string, app: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(app, "apps", "kumi", "bin", "kumi.mjs"), "bridge"], { cwd: home, stdio: "inherit", env: { ...process.env, KUMI_INSTALLED: "1", KUMI_HOME: home } });
    child.on("error", () => resolve(1)); child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function ask(io: InstalledIo, question: string): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!io.input?.isTTY) return false;
  const reader = createInterface({ input: io.input, output: io.out });
  try { return /^y(es)?$/i.test((await reader.question(`${question} [y/N] `)).trim()); } finally { reader.close(); }
}

const bridgeVersion = (app: string) => { try { return (JSON.parse(readFileSync(join(app, "apps", "mcp-server", "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } };

/** After Kumi changes, the bridge in Live when it's older than the Kumi now installed. */
async function bridgeAfter(io: InstalledIo, home: string, app: string): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const config = findBridgeConfig(io.env);
  if (!config) { say(`To connect Live, quit Live, then run: ${KUMI} bridge`); return 0; }
  let installed: string | undefined;
  try { installed = readBridgeServer(config).version; } catch { installed = undefined; }
  const bundled = bridgeVersion(app);
  if (!installed || !bundled || !newerVersion(bundled, installed)) { say("The bridge in Live is up to date."); return 0; }
  say(`The bridge in Live is ${installed}; this Kumi's is ${bundled}.`);
  if (await (io.liveRunning ?? (() => isLiveRunning(io.run ?? runProgram)))().catch(() => false)) { say(`Quit Live (save your work first), then run: ${KUMI} bridge`); return 0; }
  return (io.updateBridge ?? ((path) => kumiBridge(home, path)))(app);
}

/** Swap two folders in one step each way, putting things back if the second step fails. */
function swapIn(fresh: string, app: string, previous: string): void {
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, previous);
  try { renameSync(fresh, app); } catch (error) { if (existsSync(previous) && !existsSync(app)) renameSync(previous, app); throw error; }
}

/** `kumi update` for an installed Kumi: the latest release, checked, unpacked beside this one, then swapped in. */
export async function updateInstalled(io: InstalledIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const app = join(home, "app"); const fetcher = io.fetcher ?? fetch; const run = io.run ?? runProgram;
  say("Looking for a newer Kumi…");
  const manifest = await fetchManifest(io.env, fetcher);
  if (!manifest) { say("Couldn't reach Kumi's releases; check the network, then run update again."); return 1; }
  if (!newerVersion(manifest.kumi, KUMI_VERSION)) { say(`Kumi is up to date (${KUMI_VERSION}).`); return bridgeAfter(io, home, app); }
  // A release that needs a newer Node than the one Kumi brought: the installer brings both.
  if (Number(manifest.node.split(".")[0]) !== Number(process.versions.node.split(".")[0])) {
    say(`Kumi ${manifest.kumi} needs Node ${manifest.node.split(".")[0]}. Run the installer again, which brings it (github.com/user1303836/kumi).`);
    return 1;
  }
  const downloads = join(home, "downloads"); await mkdir(downloads, { recursive: true });
  const bundle = join(downloads, manifest.bundle); const fresh = join(home, "app.new");
  try {
    say(`Downloading Kumi ${manifest.kumi}…`);
    await download(`${releaseBase(io.env)}/${manifest.bundle}`, bundle, fetcher);
    if (sha256(bundle) !== manifest.sha256) { say("The download didn't match its checksum, so nothing was changed. Try again in a moment."); return 1; }
    rmSync(fresh, { recursive: true, force: true }); await mkdir(fresh, { recursive: true });
    const unpacked = await run("tar", ["-xzf", bundle, "-C", fresh]);
    if (unpacked.code !== 0) { say(`Unpacking it failed: ${(unpacked.stderr || unpacked.stdout).trim().split("\n").at(-1) ?? "tar failed"}`); return 1; }
    // The new Kumi has to start before it replaces this one.
    const probe = await run(process.execPath, [join(fresh, "apps", "kumi", "bin", "kumi.mjs"), "--version"]);
    if (probe.code !== 0 || !probe.stdout.includes(manifest.kumi)) { say("The new Kumi didn't start, so this one stays. Try again, or run the installer again."); return 1; }
    try { swapIn(fresh, app, join(home, "app.previous")); }
    catch { say(process.platform === "win32" ? "Windows kept Kumi's folder busy; close every Kumi window, then run update again." : "Couldn't put the new Kumi in place, so this one stays."); return 1; }
  } finally {
    rmSync(fresh, { recursive: true, force: true }); rmSync(bundle, { force: true });
  }
  say(`Kumi is now ${manifest.kumi} (${KUMI} update --rollback goes back to ${KUMI_VERSION}).`);
  return bridgeAfter(io, home, app);
}

/** `kumi update --rollback`: back to the Kumi before the last update. */
export async function rollbackInstalled(io: InstalledIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const app = join(home, "app"); const previous = join(home, "app.previous"); const hold = join(home, "app.rollback");
  if (!existsSync(join(previous, "apps", "kumi", "bin", "kumi.mjs"))) { say("There's no earlier Kumi to go back to."); return 1; }
  let version = "the one before";
  try { version = (JSON.parse(readFileSync(join(previous, "package.json"), "utf8")) as { version: string }).version; } catch { /* as said */ }
  try { rmSync(hold, { recursive: true, force: true }); renameSync(app, hold); renameSync(previous, app); renameSync(hold, previous); }
  catch { if (!existsSync(app) && existsSync(hold)) renameSync(hold, app); say("Couldn't switch back; close every Kumi window and try again."); return 1; }
  say(`Kumi is back to ${version}. ${KUMI} update --rollback again returns to ${KUMI_VERSION}.`);
  return bridgeAfter(io, home, app);
}

/** The lines the installer added to shell startup files, marked so they can be found again. */
export const PATH_MARKER = "# Added by the Kumi installer";

function removePathLines(io: InstalledIo): void {
  if (process.platform === "win32") return;
  for (const file of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", join(".config", "fish", "conf.d", "kumi.fish")].map((name) => join(homedir(), name))) {
    try {
      const text = readFileSync(file, "utf8");
      if (!text.includes(PATH_MARKER)) continue;
      if (file.endsWith("kumi.fish")) { rmSync(file, { force: true }); continue; }
      const lines = text.split("\n"); const kept: string[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (lines[index] === PATH_MARKER) { index++; continue; }   // the marker, and the PATH line under it
        kept.push(lines[index]!);
      }
      writeFileSync(file, kept.join("\n"));
      io.out.write(`Took Kumi out of ${file.replace(homedir(), "~")}.\n`);
    } catch { /* not there */ }
  }
}

/** Windows keeps the user's PATH in the registry: take Kumi's folder out of it. */
async function removeWindowsPath(run: Run, home: string): Promise<void> {
  if (process.platform !== "win32") return;
  const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p) { $n=($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne '${join(home, "bin").replace(/'/g, "''")}') }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User') }`;
  await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]).catch(() => undefined);
}

/** The bridge's own uninstall, from the package Live uses, when Live is closed. */
async function removeBridge(io: InstalledIo, run: Run): Promise<void> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const config = findBridgeConfig(io.env);
  if (!config) return;
  if (!await ask(io, "Remove the Ableton bridge from Live too?")) { say("The bridge stays in Live; Live keeps loading it until you remove AbletonMcpBridge from its Remote Scripts folder."); return; }
  if (await (io.liveRunning ?? (() => isLiveRunning(run)))().catch(() => false)) { say("Live is open, so the bridge stays. Quit Live, then remove the AbletonMcpBridge folder from Live's Remote Scripts folder."); return; }
  let entry: string | undefined;
  try { entry = readBridgeServer(config).entry; } catch { entry = undefined; }
  const root = entry ? join(entry, "..", "..", "..") : undefined;
  const lifecycle = root ? join(root, "dist", "src", "lifecycle-cli.js") : undefined;
  if (!lifecycle || !existsSync(lifecycle)) { say("Kumi couldn't find the bridge's own uninstaller; remove AbletonMcpBridge from Live's Remote Scripts folder by hand."); return; }
  const state = join(config, "..");
  const ran = await run(process.execPath, [lifecycle, "uninstall", "--remote-scripts-dir", remoteScriptsDir(io.env), "--state-dir", state, "--package-root", root!, "--apply", "--confirm-live-stopped"]);
  say(ran.code === 0 ? "The bridge is out of Live." : "The bridge's uninstaller refused; remove AbletonMcpBridge from Live's Remote Scripts folder by hand.");
}

/** `kumi uninstall [--all] [--yes]`: Kumi, its Node and its launcher go; the producer's own files stay unless --all. */
export async function uninstallInstalled(io: InstalledIo, options: { all: boolean; yes: boolean }): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const run = io.run ?? runProgram;
  const keeps = options.all ? "Everything in it goes too: your conversations, notes, recipes and sign-ins." : "Your conversations, notes, recipes and sign-ins stay (add --all to remove them too).";
  if (!options.yes && !await ask(io, `Remove Kumi from ${home.replace(homedir(), "~")}? ${keeps}`)) { say("Nothing was removed."); return 1; }
  await removeBridge(io, run);
  removePathLines(io);
  await removeWindowsPath(run, home);
  const parts = options.all ? [home] : ["app", "app.previous", "app.new", "node", "bin", "downloads", "bridge"].map((name) => join(home, name));
  if (process.platform === "win32") {
    // Windows won't delete the Node this is running on: a moment after Kumi exits, cmd does it.
    const list = parts.map((path) => `rmdir /s /q "${path}"`).join(" & ");
    // `timeout` quits at once without a console window, so ping is the pause.
    spawn("cmd.exe", ["/d", "/c", `ping -n 4 127.0.0.1 >nul & ${list}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else for (const path of parts) rmSync(path, { recursive: true, force: true });
  say(options.all ? "Kumi is removed, with everything it kept." : `Kumi is removed. Your files are still in ${home.replace(homedir(), "~")}; delete that folder to remove them too.`);
  say("Open a new terminal window so the `kumi` command is gone there too.");
  return 0;
}

/** A newer release's version, asked of GitHub at most once a day. */
export async function newerRelease(cacheFile: string, env: Env = process.env, now = Date.now()): Promise<string | undefined> {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { checkedAt?: unknown; latest?: unknown };
    if (typeof cached.checkedAt === "number" && now - cached.checkedAt < 24 * 60 * 60_000 && now >= cached.checkedAt) {
      return typeof cached.latest === "string" && newerVersion(cached.latest, KUMI_VERSION) ? cached.latest : undefined;
    }
  } catch { /* not checked yet */ }
  const manifest = await fetchManifest(env);
  if (!manifest) return undefined;
  try { writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, latest: manifest.kumi }), { mode: 0o600 }); } catch { /* next time */ }
  return newerVersion(manifest.kumi, KUMI_VERSION) ? manifest.kumi : undefined;
}
