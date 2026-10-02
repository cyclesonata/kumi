import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { EFFORTS, LOCAL_PROVIDERS, localServers, parseLocalModelId, parseModelId, PROVIDER_INFO, PROVIDERS, type Effort, type ProviderId, type ServerSetting } from "@kumi/runtime";
import { KUMI, KUMI_START } from "@kumi/runtime";

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
  | { mode: "update"; rollback: boolean; check: boolean }
  | { mode: "uninstall"; all: boolean; yes: boolean }
  | { mode: "login-choose"; authFile: string; piAuthFile: string; settingsFile: string }
  | (InferenceConfig & { mode: "inference-only"; bridgeMissing?: true })
  | (InferenceConfig & { mode: "live"; bridgeConfig: string });

function absoluteFile(env: Env, variable: string, fallback: string): string {
  const file = env[variable] ?? fallback;
  if ((env[variable] !== undefined && !env[variable]) || !isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file)) {
    throw new Error(`${variable} must be an absolute file path without control characters.`);
  }
  return file;
}
/** Where Kumi keeps what it keeps: KUMI_HOME (an installed Kumi's folder, set by its launcher), else ~/.kumi. */
export const kumiDir = (env: Env = process.env) => env.KUMI_HOME || join(homedir(), ".kumi");
export const loadAuthFile = (env: Env = process.env) => absoluteFile(env, "KUMI_AUTH_FILE", join(kumiDir(env), "auth.json"));
export const loadSettingsFile = (env: Env = process.env) => absoluteFile(env, "KUMI_SETTINGS_FILE", join(kumiDir(env), "settings.json"));
/** What Kumi remembers about the producer, in any project (each Set's notes are in its project folder). */
export const loadMemoryFile = (env: Env = process.env) => absoluteFile(env, "KUMI_MEMORY_FILE", join(kumiDir(env), "memory.json"));
/** What Kumi learned building things the producer liked (techniques), in any project. */
export const loadTechniquesFile = (env: Env = process.env) => absoluteFile(env, "KUMI_TECHNIQUES_FILE", join(kumiDir(env), "techniques.json"));
export const loadRestoreFile = (env: Env = process.env) => absoluteFile(env, "KUMI_RESTORE_FILE", join(kumiDir(env), "audition-restore.json"));
export const loadGoalsDir = (env: Env = process.env) => absoluteFile(env, "KUMI_GOALS_DIR", join(kumiDir(env), "goals"));
export const loadPlaybookFile = (env: Env = process.env) => absoluteFile(env, "KUMI_PLAYBOOK_FILE", join(kumiDir(env), "playbook.json"));
/** What Kumi couldn't do for lack of a tool, logged on this computer for Kumi's developers (not a memory). */
export const loadGapsFile = (env: Env = process.env) => absoluteFile(env, "KUMI_GAPS_FILE", join(kumiDir(env), "gaps.jsonl"));
/** The producer's recipes, one file each. */
export const loadRecipesDir = (env: Env = process.env) => absoluteFile(env, "KUMI_RECIPES_DIR", join(kumiDir(env), "recipes"));
/** Videos Kumi watched (their words, frames and sound), kept so watching again is quick. */
export const loadVideosDir = (env: Env = process.env) => absoluteFile(env, "KUMI_VIDEOS_DIR", join(kumiDir(env), "videos"));
/** Programs Kumi fetches for itself (yt-dlp, a speech model). */
export const loadToolsDir = (env: Env = process.env) => absoluteFile(env, "KUMI_TOOLS_DIR", join(kumiDir(env), "tools"));
/** What the producer typed, for the up arrow (secrets kept out). */
export const loadInputHistoryFile = (env: Env = process.env) => absoluteFile(env, "KUMI_INPUT_HISTORY_FILE", join(kumiDir(env), "input-history"));
/** Where Kumi keeps each saved Set's last-seen state, for catching up next time. */
export const loadProjectsDir = (env: Env = process.env) => absoluteFile(env, "KUMI_PROJECTS_DIR", join(kumiDir(env), "projects"));

/** Non-secret preferences: the chosen model and how hard it thinks. */
export interface Settings { model?: string; effort?: Effort; /** The tab the right pane's lower half showed last. */ panelTab?: string;
  /** false: Kumi doesn't look for a newer version when it starts (`kumi update --check` and /update still do). */ updateCheck?: false;
  /** OpenAI-compatible model servers the producer runs (llama.cpp's server, vLLM, Jan, …), beside Ollama and LM Studio, which Kumi finds by itself. */
  modelServers?: ServerSetting[] }

/** The model servers named in settings.json that Kumi can use: a name, an http(s) address, and a key if the server wants one. */
function serverSettings(value: unknown): ServerSetting[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((entry): ServerSetting[] => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = typeof item.name === "string" ? item.name.trim() : "";
    let url: URL | undefined;
    try { url = typeof item.baseURL === "string" ? new URL(item.baseURL.trim()) : undefined; } catch { url = undefined; }
    if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name) || !url || (url.protocol !== "http:" && url.protocol !== "https:")) return [];
    const apiKey = typeof item.apiKey === "string" && /^[\x21-\x7e]{1,4096}$/.test(item.apiKey) ? item.apiKey : undefined;
    return [{ name, baseURL: url.href, ...(apiKey ? { apiKey } : {}) }];
  });
}

/** The settings file; a missing or unreadable file, or an unknown value, means none. */
export function readSettings(file: string): Settings {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown; effort?: unknown; panelTab?: unknown; updateCheck?: unknown; modelServers?: unknown };
    const modelServers = serverSettings(value.modelServers);
    return { ...(typeof value.model === "string" && validModel(value.model, modelServers) ? { model: value.model } : {}),
      ...((EFFORTS as readonly unknown[]).includes(value.effort) ? { effort: value.effort as Effort } : {}),
      ...(typeof value.panelTab === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value.panelTab) ? { panelTab: value.panelTab } : {}),
      ...(value.updateCheck === false ? { updateCheck: false as const } : {}), ...(modelServers.length ? { modelServers } : {}) };
  } catch { return {}; }
}

export function writeSettings(file: string, next: Settings): void {
  // The pane's tab and the update check are kept when a caller (choosing a model) doesn't say; the
  // model servers the producer named, exactly as they wrote them.
  const before = readSettings(file);
  const panelTab = "panelTab" in next ? next.panelTab : before.panelTab;
  const updateCheck = "updateCheck" in next ? next.updateCheck : before.updateCheck;
  let modelServers: unknown = next.modelServers;
  if (!("modelServers" in next)) { try { modelServers = (JSON.parse(readFileSync(file, "utf8")) as { modelServers?: unknown }).modelServers; } catch { modelServers = undefined; } }
  const settings = { ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}), ...(panelTab ? { panelTab } : {}), ...(updateCheck === false ? { updateCheck } : {}),
    ...(modelServers !== undefined ? { modelServers } : {}) };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** A provider's model, or one on a model server: Ollama's, LM Studio's, or one named in settings.json. */
export function validModel(model: string | undefined, servers: readonly ServerSetting[] = []): model is string {
  return typeof model === "string" && model.length <= 256 && Boolean(parseModelId(model) ?? parseLocalModelId(model, localServers(servers)));
}

/** Where models come from, for messages: the providers, then the servers on this computer. */
const SOURCES = `${[...PROVIDERS, ...LOCAL_PROVIDERS].join(", ")} (or a server in settings.json)`;

export function loadInferenceConfig(env: Env = process.env): InferenceConfig {
  if (env.KUMI_MODEL !== undefined && !validModel(env.KUMI_MODEL, readSettings(loadSettingsFile(env)).modelServers)) {
    throw new Error(`KUMI_MODEL must be <provider>/<model> with provider one of ${SOURCES}.`);
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
      // &amp; last, so "&amp;quot;" (a literal &quot; in the path) stays "&quot;".
      const value = (field: string) => new RegExp(`<${field} Value="([^"]*)"`).exec(block)?.[1]?.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
  if (args[0] === "update") {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== "--rollback" && args[1] !== "--check")) throw new Error("Use: update [--check | --rollback].");
    return { mode: "update", rollback: args[1] === "--rollback", check: args[1] === "--check" };
  }
  if (args[0] === "uninstall") {
    const flags = args.slice(1);
    if (flags.some((flag) => flag !== "--all" && flag !== "--yes")) throw new Error("Use: uninstall [--all] [--yes].");
    return { mode: "uninstall", all: flags.includes("--all"), yes: flags.includes("--yes") };
  }
  if (args[0] === "bridge") {
    const flags = args.slice(1);
    if (flags.some((flag) => flag !== "--yes" && flag !== "--allow-dirty")) throw new Error("Use: bridge [--yes] [--allow-dirty].");
    return { mode: "bridge", yes: flags.includes("--yes"), allowDirty: flags.includes("--allow-dirty") };
  }
  if (args[0] === "model" && args.length <= 2) {
    if (args[1] !== undefined && !validModel(args[1], readSettings(loadSettingsFile(env)).modelServers)) throw new Error(`Use: model <provider>/<model>, with provider one of ${SOURCES}.`);
    return { mode: "model", settingsFile: loadSettingsFile(env), ...(args[1] ? { model: args[1] } : {}) };
  }
  // `login` alone asks which way to sign in: a producer shouldn't need to know provider names.
  if (args.length === 1 && args[0] === "login") return { mode: "login-choose", authFile: loadAuthFile(env), piAuthFile: join(homedir(), ".pi", "agent", "auth.json"), settingsFile: loadSettingsFile(env) };
  if (args[0] === "login" || args[0] === "logout") {
    // A model server on this computer needs no sign-in.
    if (args[1] === "ollama" || args[1] === "lmstudio") throw new Error(`${args[1] === "ollama" ? "Ollama" : "LM Studio"} needs no sign-in: while it's open, its models are in /model, or choose one with: ${KUMI} model ${args[1]}/<model>`);
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
    throw new Error(`Use: ${KUMI_START} [--bridge-config /absolute/path.json | --inference-only], or doctor, auth, login, logout, model; --help must be used alone.`);
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
