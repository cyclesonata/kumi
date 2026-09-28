/**
 * `npm run kumi -- doctor`: checks what Kumi needs, one line each, and says exactly what to run
 * when something is off. It changes nothing and prints no secrets.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { API_KEY_ENV, OPENAI_CODEX, openCredentialStore, parseModelId } from "@kumi/runtime";
import { findBridgeConfig, loadAuthFile, loadProjectsDir, loadSettingsFile, readSettings, SUPPORTED_NODE_MAJORS } from "./config.js";
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
  const model = env.KUMI_MODEL ?? readSettings(loadSettingsFile(env)).model;
  if (!model) return { status: "fix", text: "No model chosen", next: "npm run kumi -- login openai-codex (or: npm run kumi -- model <provider>/<model>)" };
  const parsed = parseModelId(model);
  if (!parsed) return { status: "fix", text: `The model "${model.slice(0, 80)}" isn't one Kumi knows`, next: "npm run kumi -- model <provider>/<model>" };
  if (parsed.provider === OPENAI_CODEX) {
    const credential = await openCredentialStore(loadAuthFile(env)).get(OPENAI_CODEX).catch(() => undefined);
    return credential ? { status: "ok", text: `Signed in to ChatGPT · model ${model}` }
      : { status: "fix", text: `Not signed in to ChatGPT (model ${model})`, next: "npm run kumi -- login openai-codex" };
  }
  const variable = (API_KEY_ENV as Record<string, string>)[parsed.provider];
  return variable && env[variable] ? { status: "ok", text: `${parsed.provider} API key from ${variable} · model ${model}` }
    : { status: "fix", text: `No API key for ${parsed.provider} (model ${model})`, next: variable ? `Set ${variable} in your environment` : "npm run kumi -- model <provider>/<model>" };
}

interface BridgeServer { command?: string; entry?: string; version?: string }
function readBridgeServer(configPath: string): BridgeServer {
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
    checks.push({ status: "fix", text: "The Ableton bridge isn't installed, so Kumi can't see Live", next: "See docs/en/KUMI_POC.md, Connect to Live" });
  } else {
    let server: BridgeServer = {};
    try { server = readBridgeServer(configPath); } catch { /* reported below */ }
    const version = server.version ? ` ${server.version}` : "";
    checks.push({ status: "ok", text: `Ableton bridge${version} (${tilde(configPath)})` });
    if (server.version && io.bundledBridgeVersion && newer(io.bundledBridgeVersion, server.version)) {
      checks.push({ status: "fix", text: `The installed bridge (${server.version}) is older than this Kumi's (${io.bundledBridgeVersion})`, next: "Upgrade it: docs/en/DELIVERY.md, Upgrade" });
    }
    // Kumi starts this repository's bridge with its own Node; the configuration's command is how
    // other MCP apps start it, so problems there are notes.
    if (!server.command) checks.push({ status: "note", text: "The bridge configuration names no Node for other MCP apps", next: "Run the bridge activation again: docs/en/KUMI_POC.md, Connect to Live" });
    else {
      let runnable = true;
      try { statSync(server.command); accessSync(server.command, constants.X_OK); } catch { runnable = false; }
      if (!runnable) checks.push({ status: "note", text: `Other MCP apps would start the bridge with a Node that's missing (${tilde(server.command)})`, next: "Run the bridge upgrade again with Node 24: docs/en/DELIVERY.md, Upgrade" });
      else {
        const bridgeNode = await (io.nodeVersionOf ?? nodeVersion)(server.command);
        if (bridgeNode && !SUPPORTED_NODE_MAJORS.includes(major(bridgeNode))) {
          checks.push({ status: "note", text: `Other MCP apps would start the bridge with Node.js ${bridgeNode.replace(/^v/, "")}, which it doesn't support`, next: "Install Node 24 LTS, then run the bridge upgrade again: docs/en/DELIVERY.md, Upgrade" });
        }
        if (/[\\/](_npx|\.npm[\\/]_npx|tmp|Temp)[\\/]/i.test(server.command)) {
          checks.push({ status: "note", text: "Other MCP apps would start the bridge with a Node from a temporary folder, which can disappear", next: "After installing Node 24 LTS, run the bridge upgrade again with it: docs/en/DELIVERY.md, Upgrade" });
        }
      }
    }
    const live = await (io.probeLive ?? (async () => ({ started: false })))(configPath).catch(() => ({ started: false } as LiveProbe));
    if (!live.started) {
      checks.push(node.status === "fix" ? { status: "note", text: "The bridge didn't start; it needs Node 22 or 24 too" }
        : { status: "fix", text: "The bridge didn't start", next: "Make sure it's built and up to date (npm run setup; docs/en/DELIVERY.md, Upgrade), then run: npm run kumi -- doctor" });
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
  const lines = ["Kumi doctor", ""];
  for (const check of checks) {
    lines.push(`  ${check.status.padEnd(5)} ${check.text}`);
    if (check.next) lines.push(`        → ${check.next}`);
  }
  const fixes = checks.filter((check) => check.status === "fix").length;
  lines.push("", fixes ? `${fixes} ${fixes === 1 ? "thing" : "things"} to fix (see →).` : "Everything Kumi needs is in place.");
  io.out.write(`${lines.join("\n")}\n`);
  return fixes ? 1 : 0;
}
