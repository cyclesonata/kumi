import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { parseModelId, PROVIDERS } from "@kumi/runtime";

type Env = Readonly<Record<string, string | undefined>>;

export const SUPPORTED_NODE_MAJORS = [22, 24];
/** Chosen after a ChatGPT sign-in when no model is set; change with `npm run kumi -- model`. */
export const DEFAULT_CODEX_MODEL = "openai-codex/gpt-6-astra";

export interface InferenceConfig {
  model: string;
  /** Kumi's own owner-only credential store; never sent to prompts or the MCP child. */
  authFile: string;
}

export type LoginMethod = "browser" | "device" | "import-pi";
export type AppConfig =
  | { mode: "help" }
  | { mode: "auth"; authFile: string; settingsFile: string }
  | { mode: "login"; method: LoginMethod; authFile: string; piAuthFile: string; settingsFile: string }
  | { mode: "logout"; authFile: string }
  | { mode: "model"; settingsFile: string; model?: string }
  | (InferenceConfig & { mode: "inference-only"; bridgeMissing?: true })
  | (InferenceConfig & { mode: "live"; bridgeConfig: string });

function absoluteFile(env: Env, variable: string, fallback: string): string {
  const file = env[variable] ?? fallback;
  if ((env[variable] !== undefined && !env[variable]) || !isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file)) {
    throw new Error(`${variable} must be an absolute file path without control characters.`);
  }
  return file;
}
export const loadAuthFile = (env: Env = process.env) => absoluteFile(env, "KUMI_AUTH_FILE", join(homedir(), ".kumi", "auth.json"));
export const loadSettingsFile = (env: Env = process.env) => absoluteFile(env, "KUMI_SETTINGS_FILE", join(homedir(), ".kumi", "settings.json"));

/** Non-secret preferences such as the chosen model; a missing or unreadable file means none. */
export function readSettings(file: string): { model?: string } {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown };
    return typeof value.model === "string" ? { model: value.model } : {};
  } catch { return {}; }
}

export function writeSettings(file: string, settings: { model?: string }): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function validModel(model: string | undefined): model is string {
  return typeof model === "string" && model.length <= 256 && Boolean(parseModelId(model));
}

export function loadInferenceConfig(env: Env = process.env): InferenceConfig {
  if (env.KUMI_MODEL !== undefined && !validModel(env.KUMI_MODEL)) {
    throw new Error(`KUMI_MODEL must be <provider>/<model> with provider one of ${PROVIDERS.join(", ")}.`);
  }
  const model = env.KUMI_MODEL ?? readSettings(loadSettingsFile(env)).model;
  if (!validModel(model)) throw new Error("Choose a model first: npm run kumi -- model <provider>/<model> (or set KUMI_MODEL).");
  return { model, authFile: loadAuthFile(env) };
}

/** The bridge configuration Live itself uses, named by the installed Remote Script's reference file. */
export function findBridgeConfig(env: Env = process.env): string | undefined {
  const scripts = env.KUMI_REMOTE_SCRIPTS_DIR
    ?? join(homedir(), process.platform === "win32" ? "Documents" : "Music", "Ableton", "User Library", "Remote Scripts");
  try {
    const { config } = JSON.parse(readFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), "utf8")) as { config?: unknown };
    return typeof config === "string" && isAbsolute(config) && statSync(config).isFile() ? config : undefined;
  } catch { return undefined; }
}

const LOGIN_METHODS: Record<string, LoginMethod> = { "": "browser", "--device": "device", "--from-pi": "import-pi" };

export function loadConfig(args: readonly string[], env: Env = process.env): AppConfig {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  if (args.length === 1 && args[0] === "auth") return { mode: "auth", authFile: loadAuthFile(env), settingsFile: loadSettingsFile(env) };
  if (args[0] === "model" && args.length <= 2) {
    if (args[1] !== undefined && !validModel(args[1])) throw new Error(`Use: model <provider>/<model>, with provider one of ${PROVIDERS.join(", ")}.`);
    return { mode: "model", settingsFile: loadSettingsFile(env), ...(args[1] ? { model: args[1] } : {}) };
  }
  if (args[0] === "login" || args[0] === "logout") {
    if (args[1] !== "openai-codex") {
      throw new Error("Only openai-codex has a sign-in; API-key providers read OPENAI_API_KEY, ANTHROPIC_API_KEY or OPENCODE_API_KEY.");
    }
    if (args[0] === "logout" && args.length === 2) return { mode: "logout", authFile: loadAuthFile(env) };
    const method = args[0] === "login" && args.length <= 3 ? LOGIN_METHODS[args[2] ?? ""] : undefined;
    if (!method) throw new Error("Use: login openai-codex [--device | --from-pi], or logout openai-codex.");
    return { mode: "login", method, authFile: loadAuthFile(env), piAuthFile: join(homedir(), ".pi", "agent", "auth.json"), settingsFile: loadSettingsFile(env) };
  }
  if (args.length === 1 && args[0] === "--inference-only") {
    return { mode: "inference-only", ...loadInferenceConfig(env) };
  }
  if (args.length === 0) {
    const bridgeConfig = findBridgeConfig(env);
    // Without an installed bridge Kumi still starts; the terminal says how to connect Live.
    return bridgeConfig ? { mode: "live", bridgeConfig, ...loadInferenceConfig(env) }
      : { mode: "inference-only", bridgeMissing: true, ...loadInferenceConfig(env) };
  }
  if (args.length !== 2 || args[0] !== "--bridge-config" || !args[1] || args[1].startsWith("-")) {
    throw new Error("Use: npm run kumi [--bridge-config /absolute/path.json | --inference-only], or auth, login, logout, model; --help must be used alone.");
  }
  const bridgeConfig = args[1];
  if (!isAbsolute(bridgeConfig)) throw new Error("--bridge-config requires an absolute path.");
  try {
    if (!statSync(bridgeConfig).isFile()) throw new Error("not a file");
    accessSync(bridgeConfig, constants.R_OK);
  } catch {
    throw new Error("Bridge configuration must be an existing readable file; its contents are validated by the MCP server.");
  }
  return { mode: "live", bridgeConfig, ...loadInferenceConfig(env) };
}

/** Bound diagnostic text; do not serialize arbitrary errors, causes, or request objects. */
export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : "Unexpected failure";
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  message = stripVTControlCharacters(message).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  message = message.replace(
    /(\b(?:authorization|x-api-key|api[_-]?key|token)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"';,}]+/gi,
    "$1[redacted]",
  );
  return message.length <= 1024 ? message : `${message.slice(0, 1021)}...`;
}
