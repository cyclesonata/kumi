import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { EFFORTS, parseModelId, PROVIDER_INFO, PROVIDERS, type Effort, type ProviderId } from "@kumi/runtime";

type Env = Readonly<Record<string, string | undefined>>;

export const SUPPORTED_NODE_MAJORS = [22, 24];

export interface InferenceConfig {
  /** Unset until one is chosen (Kumi then offers /model). */
  model?: string;
  /** Kumi's own owner-only credential store; never sent to prompts or the MCP child. */
  authFile: string;
}

/** ChatGPT signs in through the browser (or a code, or Pi's sign-in); other providers take a key. */
export type LoginMethod = "browser" | "device" | "import-pi" | "key";
export type AppConfig =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "bridge"; yes: boolean; allowDirty: boolean }
  | { mode: "auth"; authFile: string; settingsFile: string }
  | { mode: "login"; provider: ProviderId; method: LoginMethod; authFile: string; piAuthFile: string; settingsFile: string }
  | { mode: "logout"; provider: ProviderId; authFile: string }
  | { mode: "model"; settingsFile: string; model?: string }
  | { mode: "doctor" }
  | { mode: "report" }
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
/** What Kumi remembers about the producer, in any project (each Set's notes are in its project folder). */
export const loadMemoryFile = (env: Env = process.env) => absoluteFile(env, "KUMI_MEMORY_FILE", join(homedir(), ".kumi", "memory.json"));
/** What Kumi learned building things the producer liked (techniques), in any project. */
export const loadTechniquesFile = (env: Env = process.env) => absoluteFile(env, "KUMI_TECHNIQUES_FILE", join(homedir(), ".kumi", "techniques.json"));
/** What Kumi couldn't do for lack of a tool, logged on this computer for Kumi's developers (not a memory). */
export const loadGapsFile = (env: Env = process.env) => absoluteFile(env, "KUMI_GAPS_FILE", join(homedir(), ".kumi", "gaps.jsonl"));
/** The producer's recipes, one file each. */
export const loadRecipesDir = (env: Env = process.env) => absoluteFile(env, "KUMI_RECIPES_DIR", join(homedir(), ".kumi", "recipes"));
/** Videos Kumi watched (their words, frames and sound), kept so watching again is quick. */
export const loadVideosDir = (env: Env = process.env) => absoluteFile(env, "KUMI_VIDEOS_DIR", join(homedir(), ".kumi", "videos"));
/** Programs Kumi fetches for itself (yt-dlp, a speech model). */
export const loadToolsDir = (env: Env = process.env) => absoluteFile(env, "KUMI_TOOLS_DIR", join(homedir(), ".kumi", "tools"));
/** What the producer typed, for the up arrow (secrets kept out). */
export const loadInputHistoryFile = (env: Env = process.env) => absoluteFile(env, "KUMI_INPUT_HISTORY_FILE", join(homedir(), ".kumi", "input-history"));
/** Where Kumi keeps each saved Set's last-seen state, for catching up next time. */
export const loadProjectsDir = (env: Env = process.env) => absoluteFile(env, "KUMI_PROJECTS_DIR", join(homedir(), ".kumi", "projects"));

/** Non-secret preferences: the chosen model and how hard it thinks. */
export interface Settings { model?: string; effort?: Effort }

/** The settings file; a missing or unreadable file, or an unknown value, means none. */
export function readSettings(file: string): Settings {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown; effort?: unknown };
    return { ...(typeof value.model === "string" && validModel(value.model) ? { model: value.model } : {}),
      ...((EFFORTS as readonly unknown[]).includes(value.effort) ? { effort: value.effort as Effort } : {}) };
  } catch { return {}; }
}

export function writeSettings(file: string, next: Settings): void {
  const settings = { ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) };
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
  return { ...(model ? { model } : {}), authFile: loadAuthFile(env) };
}

/**
 * Where Live keeps the User Library, as its newest preferences say (Library.cfg names the folder
 * that holds it, and its name): a library the producer moved, or Documents redirected to OneDrive,
 * is found where it is. Undefined when Live's preferences don't say.
 */
export function liveUserLibrary(env: Env = process.env): string | undefined {
  const home = env.HOME ?? homedir();
  const preferences = process.platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Ableton") : join(home, "Library", "Preferences", "Ableton");
  try {
    const configs = readdirSync(preferences).filter((name) => name.startsWith("Live "))
      .map((name) => join(preferences, name, ...(process.platform === "win32" ? ["Preferences"] : []), "Library.cfg"))
      .filter((file) => existsSync(file)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const file of configs) {
      const block = /<UserLibrary>([\s\S]*?)<\/UserLibrary>/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
      const value = (field: string) => new RegExp(`<${field} Value="([^"]*)"`).exec(block)?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const folder = value("ProjectPath"); const name = value("ProjectName") || "User Library";
      if (folder && isAbsolute(folder)) return join(folder, name);
    }
  } catch { /* no preferences to read */ }
  return undefined;
}

/** Live's Remote Scripts folder: KUMI_REMOTE_SCRIPTS_DIR, else in the User Library Live's preferences name, else where Live keeps it by default. */
export function remoteScriptsDir(env: Env = process.env): string {
  if (env.KUMI_REMOTE_SCRIPTS_DIR) return env.KUMI_REMOTE_SCRIPTS_DIR;
  const library = liveUserLibrary(env);
  if (library) return join(library, "Remote Scripts");
  const home = homedir();
  const documents = process.platform === "win32" ? [join(home, "OneDrive", "Documents"), join(home, "Documents")].find((folder) => existsSync(join(folder, "Ableton"))) ?? join(home, "Documents") : join(home, "Music");
  return join(documents, "Ableton", "User Library", "Remote Scripts");
}

/** The bridge configuration Live itself uses, named by the installed Remote Script's reference file. */
export function findBridgeConfig(env: Env = process.env): string | undefined {
  const scripts = remoteScriptsDir(env);
  try {
    const { config } = JSON.parse(readFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), "utf8")) as { config?: unknown };
    return typeof config === "string" && isAbsolute(config) && statSync(config).isFile() ? config : undefined;
  } catch { return undefined; }
}

const LOGIN_METHODS: Record<string, LoginMethod> = { "": "browser", "--device": "device", "--from-pi": "import-pi" };

export function loadConfig(args: readonly string[], env: Env = process.env): AppConfig {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) return { mode: "version" };
  if (args.length === 1 && args[0] === "auth") return { mode: "auth", authFile: loadAuthFile(env), settingsFile: loadSettingsFile(env) };
  if (args.length === 1 && args[0] === "doctor") return { mode: "doctor" };
  if (args.length === 1 && args[0] === "report") return { mode: "report" };
  if (args[0] === "bridge") {
    const flags = args.slice(1);
    if (flags.some((flag) => flag !== "--yes" && flag !== "--allow-dirty")) throw new Error("Use: bridge [--yes] [--allow-dirty].");
    return { mode: "bridge", yes: flags.includes("--yes"), allowDirty: flags.includes("--allow-dirty") };
  }
  if (args[0] === "model" && args.length <= 2) {
    if (args[1] !== undefined && !validModel(args[1])) throw new Error(`Use: model <provider>/<model>, with provider one of ${PROVIDERS.join(", ")}.`);
    return { mode: "model", settingsFile: loadSettingsFile(env), ...(args[1] ? { model: args[1] } : {}) };
  }
  if (args[0] === "login" || args[0] === "logout") {
    if (!(PROVIDERS as readonly (string | undefined)[]).includes(args[1])) throw new Error(`Use: ${args[0]} <provider>, with provider one of ${PROVIDERS.join(", ")}.`);
    const provider = args[1] as ProviderId;
    if (args[0] === "logout") {
      if (args.length !== 2) throw new Error(`Use: logout ${provider}.`);
      return { mode: "logout", provider, authFile: loadAuthFile(env) };
    }
    // A key is asked for, never taken as an argument, so it stays out of shell history.
    const chatgpt = PROVIDER_INFO[provider].signIn === "chatgpt";
    const method = chatgpt ? (args.length <= 3 ? LOGIN_METHODS[args[2] ?? ""] : undefined) : args.length === 2 ? "key" : undefined;
    if (!method) throw new Error(chatgpt ? "Use: login openai-codex [--device | --from-pi]." : `Use: login ${provider}; Kumi asks for the API key, so it stays out of your shell history.`);
    return { mode: "login", provider, method, authFile: loadAuthFile(env), piAuthFile: join(homedir(), ".pi", "agent", "auth.json"), settingsFile: loadSettingsFile(env) };
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
    throw new Error("Use: npm run kumi [--bridge-config /absolute/path.json | --inference-only], or doctor, auth, login, logout, model; --help must be used alone.");
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
