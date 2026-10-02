/**
 * `npm run kumi -- bridge`: install the Ableton bridge Kumi ships with, or bring an older one up to
 * date, through the bridge's own lifecycle (a plan first, then apply, with its checks, receipts and
 * rollback). Kumi never touches Live here: it asks the producer to quit Live before, and to open it
 * after, then waits to see Live connect.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { findBridgeConfig, kumiDir, remoteScriptsDir } from "./config.js";
import { readBridgeServer } from "./doctor.js";
import { extensionSource, installExtension, liveExtensionsDir } from "./live-extension.js";
import { EARS_NAME, installEars, KUMI, KUMI_REPAIR, KUMI_START } from "@kumi/runtime";

type Env = Readonly<Record<string, string | undefined>>;
export interface Ran { code: number; stdout: string; stderr: string }

export interface BridgeSetupIo {
  out: Writable;
  env: Env;
  input?: Readable & { isTTY?: boolean };
  /** Skip the "is Live closed?" question (the producer said so already). */
  yes?: boolean;
  /** For a bridge built from a checkout with uncommitted changes (developers). */
  allowDirty?: boolean;
  /** How long to wait for Live after installing; 0 doesn't wait. */
  waitMs?: number;
  // For tests: what runs programs, whether Live is running, the question, the clock.
  run?: (command: string, args: readonly string[], cwd?: string) => Promise<Ran>;
  liveRunning?: () => Promise<boolean>;
  confirm?: (question: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** The bridge's folder in this repository. */
  bridgeDir?: string;
  /** Where Kumi keeps the bridge packages it installs. */
  home?: string;
  /** An installed Kumi's bridge, packed and installed when its release was built (bridge/prepared.json). */
  prepared?: string;
}

const BRIDGE_DIR = fileURLToPath(new URL("../../../mcp-server/", import.meta.url));
/** An installed Kumi carries its bridge ready to install: packed, with its package installed, when the release was built. */
const PREPARED = fileURLToPath(new URL("../../../../bridge/", import.meta.url));

interface Prepared { artifact: string; sha256: string; root: string }
/** The release's prepared bridge, when this Kumi was installed from one: no npm needed to install it. */
function preparedBridge(dir: string): Prepared | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "prepared.json"), "utf8")) as { artifact?: unknown; sha256?: unknown };
    if (typeof manifest.artifact !== "string" || typeof manifest.sha256 !== "string" || basename(manifest.artifact) !== manifest.artifact) return undefined;
    const root = join(dir, "package", "node_modules", "@ableton-mcp", "mcp-server");
    return existsSync(join(dir, manifest.artifact)) && existsSync(join(root, "dist", "src", "lifecycle-cli.js")) ? { artifact: manifest.artifact, sha256: manifest.sha256, root } : undefined;
  } catch { return undefined; }
}
const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

export function runProgram(command: string, args: readonly string[], cwd?: string): Promise<Ran> {
  // npm is npm.cmd on Windows, which only starts through a shell; the shell gets one command line,
  // so paths with spaces (a user folder like "C:\Users\Jo Smith") are quoted.
  const shell = process.platform === "win32" && command === "npm";
  const line = shell ? args.map((arg) => (/[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg)) : [...args];
  return new Promise((resolve) => {
    execFile(command, line, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, shell }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Whether Live is running: on macOS its process is "Live"; on Windows, "Ableton Live … .exe". */
export async function isLiveRunning(run: NonNullable<BridgeSetupIo["run"]>): Promise<boolean> {
  if (process.platform === "darwin") return (await run("pgrep", ["-x", "Live"])).code === 0;
  if (process.platform === "win32") return /Ableton Live/i.test((await run("tasklist", ["/FI", "IMAGENAME eq Ableton Live*", "/NH"])).stdout);
  return false;
}

async function ask(io: BridgeSetupIo, question: string): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!io.input?.isTTY) return false;
  const reader = createInterface({ input: io.input, output: io.out });
  try { return /^y(es)?$/i.test((await reader.question(`${question} [y/N] `)).trim()); } finally { reader.close(); }
}

/** The lifecycle's JSON answer (on stdout, or its refusal on stderr), or what went wrong in words. */
function lifecycleAnswer(ran: Ran): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const json = (text: string) => { try { return JSON.parse(text.trim().split("\n").filter(Boolean).at(-1) ?? "") as Record<string, unknown>; } catch { return undefined; } };
  const value = json(ran.stdout) ?? json(ran.stderr);
  if (!value) return { ok: false, reason: (ran.stderr || ran.stdout).trim().split("\n").at(-1)?.slice(0, 300) || "the bridge's installer failed" };
  if (String(value.version ?? "").includes("error") || ran.code !== 0) return { ok: false, reason: String(value.reason ?? "the bridge's installer refused").slice(0, 400) };
  return { ok: true, value };
}

const activated = (value: Record<string, unknown>) => {
  const verification = (value.verification ?? {}) as Record<string, unknown>;
  const receipt = verification.receipt as Record<string, unknown> | undefined;
  // activate answers "completed" once it has reached Live through the new bridge ("activation-required" until then).
  return (value.state === "completed" && verification.liveConnected === true) || value.state === "activated" || receipt?.effectiveStatus === "activated";
};

/**
 * Puts Kumi's extension in Live's Extensions folder, from the first of `bridgeRoots` that carries one
 * (an older bridge carries none). Never fatal: the bridge works without it.
 */
function placeExtension(io: BridgeSetupIo, say: (line?: string) => void, bridgeRoots: readonly string[], liveOpen: boolean): void {
  const folder = liveExtensionsDir(io.env);
  const source = bridgeRoots.map(extensionSource).find(Boolean);
  if (!folder || !source) return;
  try {
    const placed = installExtension(source, folder);
    if (!placed.changed) return;
    const next = liveOpen ? " It starts the next time you open Live." : "";
    say(placed.replaced ? `Updated Kumi's extension in Live.${next}` : `Added Kumi's extension to Live: it renders tracks without playing them, writes MIDI clips in the Arrangement, and adds "Ask Kumi about this" to Live's right-click menu.${next}`);
  } catch (error) {
    say(`Kumi couldn't add its extension to Live (${error instanceof Error ? error.message : "unknown error"}); everything else works. Run ${KUMI} bridge again to retry.`);
  }
}

/**
 * Puts Kumi's listening device in the User Library's Kumi folder (beside the Remote Scripts folder), so Live's
 * Browser lists it before Kumi first needs it. Never fatal: Kumi writes it again when it needs it.
 */
async function placeEars(say: (line?: string) => void, scripts: string): Promise<void> {
  const library = dirname(scripts);
  if (basename(scripts) !== "Remote Scripts" || !existsSync(library)) return;
  try {
    const placed = await installEars(library);
    if (placed.written) say(`Added Kumi's listening device to your User Library (Kumi › ${EARS_NAME}): Kumi puts it on a track when it needs to hear it, and takes it away after.`);
  } catch { /* Kumi writes it when it first listens */ }
}

/** The package folder a bridge configuration's entry (<package>/dist/src/cli.js) belongs to. */
const packageRootOf = (entry: string | undefined) => (entry ? dirname(dirname(dirname(entry))) : undefined);

export async function setupBridge(io: BridgeSetupIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const run = io.run ?? runProgram;
  const bridgeDir = io.bridgeDir ?? BRIDGE_DIR;
  const scripts = remoteScriptsDir(io.env);
  let bundled: string;
  try { bundled = (JSON.parse(readFileSync(join(bridgeDir, "package.json"), "utf8")) as { version: string }).version; }
  catch { say(`Kumi's copy of the bridge is missing. Run ${KUMI_REPAIR}.`); return 1; }
  if (!existsSync(join(bridgeDir, "dist", "src", "lifecycle-cli.js"))) { say(`The bridge isn't built yet. Run ${KUMI_REPAIR}.`); return 1; }

  const config = findBridgeConfig(io.env);
  const state = config ? dirname(config) : join(io.home ?? kumiDir(io.env), "bridge", "state");
  let installed: string | undefined; let installedRoot: string | undefined;
  try { const server = config ? readBridgeServer(config) : undefined; installed = server?.version; installedRoot = packageRootOf(server?.entry); } catch { installed = undefined; }
  const lifecycle = (root: string, action: string, extra: readonly string[] = []) => run(process.execPath, [join(root, "dist", "src", "lifecycle-cli.js"), action,
    "--remote-scripts-dir", scripts, "--state-dir", state, "--package-root", root, ...extra, ...(io.allowDirty ? ["--allow-dirty-private-build"] : [])]);

  // Up to date: say so, and whether Live has been seen through it.
  if (config && installed === bundled) {
    say(`The Ableton bridge ${bundled} is installed, the same as Kumi's.`);
    // A bridge installed before Kumi had an extension gets it now; Live loads it when it next opens.
    placeExtension(io, say, [installedRoot, bridgeDir].filter((root): root is string => Boolean(root)), await (io.liveRunning ?? (() => isLiveRunning(run)))());
    await placeEars(say, scripts);
    return 0;
  }
  say(config ? `Kumi's bridge is ${bundled}; the one Live uses is ${installed ?? "older"}. Updating it takes a minute.` : `Kumi will install the Ableton bridge ${bundled}: the Remote Script Live loads, and the local server Kumi talks to.`);
  if (await (io.liveRunning ?? (() => isLiveRunning(run)))()) {
    say(`Live is open. Save your work, quit Live, then run this again: ${KUMI} bridge`);
    return 1;
  }
  if (!io.yes && !await ask(io, "Is Live closed, with your work saved?")) { say(`Nothing was changed. Quit Live, then run: ${KUMI} bridge`); return 1; }
  // The Remote Script goes in the User Library's Remote Scripts folder, which Live doesn't always make.
  if (!existsSync(scripts)) {
    if (basename(scripts) !== "Remote Scripts" || !existsSync(dirname(scripts))) {
      say(`Kumi couldn't find Live's User Library (it looked for ${tilde(dirname(scripts))}). Open Live once so it makes one, or set KUMI_REMOTE_SCRIPTS_DIR to your User Library's Remote Scripts folder (Live's Settings → Library shows where it is).`);
      return 1;
    }
    mkdirSync(scripts);
  }

  // The bridge's own package, as a tarball the lifecycle verifies byte for byte. It goes in a folder of
  // its own under ~/.kumi/bridge, so updating or removing Kumi later doesn't pull it out from under Live.
  const folder = join(io.home ?? kumiDir(io.env), "bridge", `${bundled}-${Date.now()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const ready = preparedBridge(io.prepared ?? PREPARED);
  let artifact: string; let sha: string;
  if (ready) {
    say("Copying the bridge…");
    artifact = join(folder, ready.artifact);
    copyFileSync(join(io.prepared ?? PREPARED, ready.artifact), artifact);
    sha = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    if (sha !== ready.sha256) { say(`Kumi's copy of the bridge is damaged. Run ${KUMI_REPAIR}.`); return 1; }
    cpSync(join(io.prepared ?? PREPARED, "package", "node_modules"), join(folder, "node_modules"), { recursive: true });
  } else {
    say("Packing the bridge…");
    const packed = await run("npm", ["pack", "--pack-destination", folder, "--silent"], bridgeDir);
    const name = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (packed.code !== 0 || !name) { say(`Packing the bridge failed: ${(packed.stderr || packed.stdout).trim().split("\n").at(-1) ?? "npm pack failed"}`); return 1; }
    artifact = join(folder, name);
    sha = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    say("Installing its package…");
    const installedPackage = await run("npm", ["install", "--prefix", folder, "--ignore-scripts", "--no-audit", "--no-fund", artifact], folder);
    if (installedPackage.code !== 0) { say(`Installing the bridge's package failed: ${(installedPackage.stderr || installedPackage.stdout).trim().split("\n").at(-1) ?? "npm install failed"}`); return 1; }
  }
  const root = join(folder, "node_modules", "@ableton-mcp", "mcp-server");

  // The lifecycle plans first (it changes nothing), then applies; either refusal is said as it is.
  const action = config ? "upgrade" : "install";
  const artifactArgs = ["--artifact", artifact, "--artifact-sha256", sha];
  const plan = lifecycleAnswer(await lifecycle(root, action, artifactArgs));
  if (!plan.ok) {
    say(`The bridge's installer refused: ${plan.reason}`);
    if (/dirty/i.test(plan.reason)) say("This checkout has uncommitted changes; to install it anyway (developers only), add --allow-dirty.");
    return 1;
  }
  say(action === "upgrade" ? "Updating Live's Remote Script and the bridge…" : "Installing Live's Remote Script and the bridge…");
  const applied = lifecycleAnswer(await lifecycle(root, action, [...artifactArgs, "--apply", "--confirm-live-stopped"]));
  if (!applied.ok) { say(`The bridge's installer stopped, and put back what was there: ${applied.reason}`); return 1; }
  say(`Done: the Ableton bridge ${bundled} is installed (${tilde(scripts)}).`);
  placeExtension(io, say, [root], false);
  await placeEars(say, scripts);
  say("");
  say(config ? "Now open Live. Kumi connects on its own." : "Now open Live, and in Settings → Link, Tempo & MIDI choose AbletonMcpBridge as a Control Surface. Kumi connects on its own.");

  // Watch for Live, and record that the bridge reaches it (the lifecycle's read-only activation).
  const waitMs = io.waitMs ?? 10 * 60_000;
  if (waitMs <= 0) return 0;
  say("Waiting for Live… (Ctrl-C stops waiting; nothing else depends on it)");
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, Math.ceil(waitMs / 3_000));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const check = lifecycleAnswer(await lifecycle(root, "activate"));
    if (check.ok && activated(check.value)) { say(`Live is connected through the new bridge. Run: ${KUMI_START}`); return 0; }
    if (attempt < attempts - 1) await sleep(3_000);
  }
  say(`Live didn't connect yet; Kumi will connect when it does. If it doesn't, run: ${KUMI} doctor`);
  return 0;
}
