/**
 * `npm run kumi -- doctor`: checks what Kumi needs, one line each, and says exactly what to run
 * when something is off. It changes nothing and prints no secrets.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { apiKeyFor, ffmpegHint, findFfmpeg, findWhisper, OPENAI_CODEX, openCredentialStore, parseModelId, PROVIDER_INFO, whisperHint, type ProviderId } from "@kumi/runtime";
import { findBridgeConfig, loadAuthFile, loadProjectsDir, loadSettingsFile, loadToolsDir, readSettings, SUPPORTED_NODE_MAJORS } from "./config.js";
import { OFFER_ORDER } from "./models.js";
import { detectColorDepth } from "./tui/style.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface Check {
  status: "ok" | "note" | "fix";
  text: string;
  /** What to run or do, for "note" and "fix". */
  next?: string;
}

/** What Live looks like through the bridge, from a short connection. */
export interface LiveProbe {
  started: boolean;
  connected?: boolean;
  liveVersion?: string;
  set?: string;
  realLive?: boolean;
}

export interface DoctorIo {
  out: Writable;
  env: Env;
  nodeVersion?: string;
  terminal?: { isTTY: boolean; columns?: number; rows?: number };
  /** Start the bridge briefly and ask Live how it is. */
  probeLive?: (bridgeConfig: string) => Promise<LiveProbe>;
  /** `node --version` of the bridge's own Node. */
  nodeVersionOf?: (command: string) => Promise<string | undefined>;
  /** This repository's bridge version, to compare with the installed one. */
  bundledBridgeVersion?: string;
  /** Where ffmpeg and whisper.cpp are, for watching videos; looked up (nothing fetched) when left out. */
  videoPrograms?: () => Promise<{ ffmpeg?: string | undefined; whisper?: string | undefined }>;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const major = (version: string) => Number(version.replace(/^v/, "").split(".")[0]);
const newer = (left: string, right: string) => {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
};

function nodeCheck(version: string): Check {
  return SUPPORTED_NODE_MAJORS.includes(major(version))
    ? { status: "ok", text: `Node.js ${version.replace(/^v/, "")}` }
    : { status: "fix", text: `Node.js ${version.replace(/^v/, "")} isn't supported (Kumi needs 22 or 24)`, next: "Install Node 24 LTS from https://nodejs.org, then run: npm run setup" };
}

async function signInCheck(env: Env): Promise<Check> {
  const store = openCredentialStore(loadAuthFile(env));
  const signedIn = async (provider: ProviderId) => PROVIDER_INFO[provider].signIn === "chatgpt"
    ? (await store.get(OPENAI_CODEX).catch(() => undefined))?.type === "oauth"
    : Boolean(await apiKeyFor(provider, store, env).catch(() => undefined));
  const model = env.KUMI_MODEL ?? readSettings(loadSettingsFile(env)).model;
  if (!model) {
    for (const provider of OFFER_ORDER) {
      if (await signedIn(provider)) return { status: "ok", text: `Signed in to ${PROVIDER_INFO[provider].name} · Kumi starts with its first model (/model changes it)` };
    }
    return { status: "fix", text: "Not signed in to a provider", next: "npm run kumi -- login openai-codex (a ChatGPT plan), or login anthropic, openai or opencode with an API key" };
  }
  const parsed = parseModelId(model);
  if (!parsed) return { status: "fix", text: `The model "${model.slice(0, 80)}" isn't one Kumi knows`, next: "Choose one with /model in Kumi" };
  const info = PROVIDER_INFO[parsed.provider];
  if (!(await signedIn(parsed.provider))) return { status: "fix", text: `Not signed in to ${info.name} (model ${model})`, next: `npm run kumi -- login ${parsed.provider}` };
  if (info.signIn === "chatgpt") return { status: "ok", text: `Signed in to ChatGPT · model ${model}` };
  const key = await apiKeyFor(parsed.provider, store, env).catch(() => undefined);
  return { status: "ok", text: `${parsed.provider} API key ${key?.source === "env" ? `from ${info.keyEnv}` : "saved in Kumi"} · model ${model}` };
}

export interface BridgeServer { command?: string; entry?: string; version?: string }
/** The installed bridge's server: its Node, its entry, and the package's version. */
export function readBridgeServer(configPath: string): BridgeServer {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { server?: { command?: unknown; args?: unknown } };
  const command = typeof config.server?.command === "string" ? config.server.command : undefined;
  const entry = Array.isArray(config.server?.args) && typeof config.server.args[0] === "string" ? config.server.args[0] : undefined;
  let version: string | undefined;
  // The entry is <package>/dist/src/cli.js; the package's own version sits two folders up.
  try { if (entry) version = (JSON.parse(readFileSync(join(dirname(entry), "..", "..", "package.json"), "utf8")) as { version?: string }).version; } catch { version = undefined; }
  return { ...(command ? { command } : {}), ...(entry ? { entry } : {}), ...(version ? { version } : {}) };
}

export async function doctorChecks(io: DoctorIo): Promise<Check[]> {
  const { env } = io;
  const node = nodeCheck(io.nodeVersion ?? process.version);
  const checks: Check[] = [node, await signInCheck(env)];
  const configPath = findBridgeConfig(env);
  if (!configPath) {
    checks.push({ status: "fix", text: "The Ableton bridge isn't installed, so Kumi can't see Live", next: "Quit Live, then run: npm run kumi -- bridge" });
  } else {
    let server: BridgeServer = {};
    try { server = readBridgeServer(configPath); } catch { /* reported below */ }
    const version = server.version ? ` ${server.version}` : "";
    checks.push({ status: "ok", text: `Ableton bridge${version} (${tilde(configPath)})` });
    if (server.version && io.bundledBridgeVersion && newer(io.bundledBridgeVersion, server.version)) {
      checks.push({ status: "fix", text: `The installed bridge (${server.version}) is older than this Kumi's (${io.bundledBridgeVersion})`, next: "Quit Live, then run: npm run kumi -- bridge" });
    }
    // Kumi starts this repository's bridge with its own Node; the configuration's command is how
    // other MCP apps start it, so problems there are notes. Only an install or an upgrade to a
    // newer bridge rewrites it (repair and activation keep it), hence "the next upgrade".
    const later = "Kumi isn't affected. Install Node 24 LTS (nodejs.org); the next npm run kumi -- bridge records it";
    if (!server.command) checks.push({ status: "note", text: "The bridge configuration names no Node for other MCP apps", next: later });
    else {
      let runnable = true;
      try { statSync(server.command); accessSync(server.command, constants.X_OK); } catch { runnable = false; }
      if (!runnable) checks.push({ status: "note", text: `Other MCP apps would start the bridge with a Node that's missing (${tilde(server.command)})`, next: later });
      else {
        const bridgeNode = await (io.nodeVersionOf ?? nodeVersion)(server.command);
        if (bridgeNode && !SUPPORTED_NODE_MAJORS.includes(major(bridgeNode))) {
          checks.push({ status: "note", text: `Other MCP apps would start the bridge with Node.js ${bridgeNode.replace(/^v/, "")}, which it doesn't support`, next: later });
        }
        if (/[\\/](_npx|\.npm[\\/]_npx|tmp|Temp)[\\/]/i.test(server.command)) {
          checks.push({ status: "note", text: "Other MCP apps would start the bridge with a Node from a temporary folder, which can disappear", next: later });
        }
      }
    }
    const live = await (io.probeLive ?? (async () => ({ started: false })))(configPath).catch(() => ({ started: false } as LiveProbe));
    if (!live.started) {
      // Kumi's bridge stops at its handshake when Live's Remote Script doesn't answer: an older one
      // (said above), or Live not open, not using it, or held by a dialog.
      const current = Boolean(server.version && io.bundledBridgeVersion && !newer(io.bundledBridgeVersion, server.version));
      checks.push(node.status === "fix" ? { status: "note", text: "The bridge didn't start; it needs Node 22 or 24 too" }
        : current ? { status: "fix", text: "Kumi's bridge couldn't reach Live", next: "Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI); if Live is showing a dialog, answer it first. Then: npm run kumi -- doctor" }
        : { status: "fix", text: "The bridge didn't start", next: "Build it (npm run setup), and bring Live's part up to date: quit Live, then run npm run kumi -- bridge. Then: npm run kumi -- doctor" });
    }
    else if (!live.connected) checks.push({ status: "fix", text: "Live isn't connected", next: "Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI)" });
    else {
      const where = [live.liveVersion ? `Live ${live.liveVersion}` : "Live", "connected", live.set ? `· ${live.set}` : ""].filter(Boolean).join(" ");
      checks.push(live.realLive === false ? { status: "note", text: `${where} (a simulator, not real Live)` } : { status: "ok", text: where });
    }
  }
  try {
    const projects = loadProjectsDir(env);
    let writable = true;
    try { accessSync(projects, constants.W_OK); } catch { try { accessSync(dirname(projects), constants.W_OK); } catch { writable = false; } }
    checks.push(writable ? { status: "ok", text: `Remembers Sets in ${tilde(projects)}` } : { status: "note", text: `Can't write ${tilde(projects)}, so Kumi won't catch you up on Sets`, next: "Check that folder's permissions, or set KUMI_PROJECTS_DIR" });
  } catch { /* an invalid KUMI_PROJECTS_DIR is reported when Kumi starts */ }
  // Watching videos: yt-dlp comes by itself when first needed; ffmpeg and whisper.cpp are the producer's.
  const programs = await (io.videoPrograms ?? (async () => ({ ffmpeg: await findFfmpeg({ env, toolsDir: loadToolsDir(env), installedOnly: true }), whisper: await findWhisper({ env, toolsDir: loadToolsDir(env), installedOnly: true }) })))().catch(() => ({ ffmpeg: undefined, whisper: undefined }));
  if (!programs.ffmpeg) checks.push({ status: "note", text: "Kumi reads a video's words but can't see its frames without ffmpeg", next: `Install it: ${ffmpegHint()}` });
  else if (!programs.whisper) checks.push({ status: "note", text: "Watches videos; one without captions needs whisper.cpp for its words", next: `Install it: ${whisperHint()}` });
  else checks.push({ status: "ok", text: "Watches videos: frames with ffmpeg, speech with whisper.cpp" });
  const terminal = io.terminal ?? { isTTY: Boolean(process.stdout.isTTY), ...(process.stdout.columns ? { columns: process.stdout.columns } : {}), ...(process.stdout.rows ? { rows: process.stdout.rows } : {}) };
  if (!terminal.isTTY) checks.push({ status: "note", text: "Not a terminal window here, so Kumi uses plain lines" });
  else {
    const depth = detectColorDepth(env);
    const colour = depth === "truecolor" ? "24-bit colour" : depth === "256" ? "256 colours" : depth === "16" ? "16 colours" : "no colour";
    const size = `${terminal.columns ?? 80}×${terminal.rows ?? 24}`;
    const small = (terminal.columns ?? 80) < 60 || (terminal.rows ?? 24) < 16;
    checks.push(small ? { status: "note", text: `Terminal ${size} is small for Kumi's full screen`, next: "Make the window bigger" } : { status: "ok", text: `Terminal ${size}, ${colour}${env.KUMI_UI === "plain" ? ", plain lines (KUMI_UI=plain)" : ""}` });
  }
  return checks;
}

function nodeVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 5_000, env: { PATH: dirname(command) } }, (error, stdout) => resolve(error ? undefined : String(stdout).trim().slice(0, 32) || undefined));
  });
}

export async function runDoctor(io: DoctorIo): Promise<number> {
  const checks = await doctorChecks(io);
  io.out.write(formatDoctor(checks));
  return checks.some((check) => check.status === "fix") ? 1 : 0;
}

/** The doctor's lines, as it prints them. */
export function formatDoctor(checks: readonly Check[]): string {
  const lines = ["Kumi doctor", ""];
  for (const check of checks) {
    lines.push(`  ${check.status.padEnd(5)} ${check.text}`);
    if (check.next) lines.push(`        → ${check.next}`);
  }
  const fixes = checks.filter((check) => check.status === "fix").length;
  lines.push("", fixes ? `${fixes} ${fixes === 1 ? "thing" : "things"} to fix (see →).` : "Everything Kumi needs is in place.");
  return `${lines.join("\n")}\n`;
}
