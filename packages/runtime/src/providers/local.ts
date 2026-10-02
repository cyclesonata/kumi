/**
 * Models served on the producer's own computer: Ollama, LM Studio, and any OpenAI-compatible server
 * named in settings.json (llama.cpp's server, vLLM, Jan, …). They're found by asking, with no
 * sign-in, and each server's models, and what each can do, come from the server itself.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { KumiError } from "../core/errors.js";
import type { ModelBinding, ModelRequest } from "../kernel/agent.js";
import { budgetFor, BYTES_PER_TOKEN } from "../kernel/budget.js";
import { cleanDetail } from "../kernel/failure.js";
import { mendingFetch } from "./compat.js";
import { EFFORTS, PROVIDERS, USER_AGENT, wordsOnly, type Effort } from "./index.js";
import type { ModelInfo } from "./models.js";
import { ollamaChat } from "./ollama.js";

type Env = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;

export type LocalKind = "ollama" | "lmstudio" | "openai-compatible";

/** A server of models the producer runs: one Kumi looks for by itself, or one named in settings.json. */
export interface LocalServer {
  /** As model ids name it: "ollama", "lmstudio", or a server's name from settings.json as one word ("llama-cpp"). */
  id: string;
  kind: LocalKind;
  /** As the producer knows it: "Ollama", "LM Studio", or the name they gave it. */
  name: string;
  /** Ollama's own address; for the others, their OpenAI-compatible one (ending in /v1). */
  baseURL: string;
  apiKey?: string;
  /** "on this computer", or the machine it's on. */
  where: string;
}

/** A server named in settings.json. */
export interface ServerSetting { name: string; baseURL: string; apiKey?: string }

/** The servers Kumi looks for by itself. */
export const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const;

const OLLAMA_PORT = 11434;
const LMSTUDIO_URL = "http://127.0.0.1:1234/v1";
const HERE = "on this computer";
/** How long a server has to say it's there; one that isn't running refuses at once. */
const PROBE_MS = 1_500;
/** And to list its models, reading each one's details. */
const LIST_MS = 10_000;

/**
 * The context a local model gets. Kumi's request is large: its instructions and tools alone are
 * about 85 KB with Live's full set of tools, some 25-30k tokens. Beside them Kumi wants room for the
 * conversation (the producer's words, Live's reads, the answers so far) and for each answer,
 * thinking included. Sizes go up in steps, so a slightly larger request doesn't load the model again.
 */
const ROOM = 48 * 1024;
const ANSWER = 8_192;
const STEP = 8_192;

/** The context Kumi asks for, for a request whose instructions and tools take `fixed` bytes: up to what the model reads at most. */
export function contextFor(fixed: number, most?: number): number {
  const wanted = Math.ceil((Math.ceil((fixed + ROOM) / BYTES_PER_TOKEN) + ANSWER) / STEP) * STEP;
  return most && most > 0 ? Math.min(wanted, most) : wanted;
}
/** A window that can't hold the instructions and tools (even at a generous 4 bytes a token) and a short answer. */
const tooSmall = (window: number, fixed: number) => window < Math.ceil(fixed / 4) + 2_048;
/** A model already loaded with this much is used as it is: all Kumi would ask for, or room for some conversation. */
const enough = (window: number, fixed: number, most?: number) => window >= Math.min(contextFor(fixed, most), Math.ceil((fixed + 16 * 1024) / BYTES_PER_TOKEN) + ANSWER);

const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const rows = (value: unknown): Json[] => (Array.isArray(value) ? value.flatMap((item): Json[] => { const row = object(item); return row ? [row] : []; }) : []);
const text = (value: unknown, max = 40) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);
const words = (...items: unknown[]) => items.flatMap((item) => text(item) ?? []);
const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);
const tokens = (value: number) => value.toLocaleString("en-US");

/** The servers to look for: Ollama (where OLLAMA_HOST says), LM Studio, then each one named in settings.json. */
export function localServers(settings: readonly ServerSetting[] = [], env: Env = {}): LocalServer[] {
  const servers = [
    server("ollama", "ollama", "Ollama", ollamaAddress(env.OLLAMA_HOST)),
    server("lmstudio", "lmstudio", "LM Studio", LMSTUDIO_URL, env.LM_API_TOKEN),
  ];
  const taken = new Set<string>([...PROVIDERS, ...LOCAL_PROVIDERS]);
  for (const setting of settings) {
    const word = setting.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
    let id = word;
    for (let n = 2; taken.has(id); n++) id = `${word}-${n}`;
    taken.add(id);
    servers.push(server(id, "openai-compatible", setting.name, compatibleAddress(setting.baseURL), setting.apiKey));
  }
  return servers;
}

function server(id: string, kind: LocalKind, name: string, baseURL: string, apiKey?: string): LocalServer {
  const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, "");
  const where = /^(localhost|127(\.\d{1,3}){3}|::1)$/i.test(host) ? HERE : `on ${host}`;
  return { id, kind, name, baseURL, ...(apiKey ? { apiKey } : {}), where };
}

/** Ollama's address as Ollama reads OLLAMA_HOST: a host, host and port, or URL; port 11434 unless given; listening everywhere means here. */
function ollamaAddress(host: string | undefined): string {
  const value = host?.trim();
  if (value) {
    try {
      const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
      const url = new URL(scheme.test(value) ? value : `http://${value}`);
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
      if (url.hostname === "[::]") url.hostname = "[::1]";
      if (!url.port && !/^[^/]*:\d+(\/|$)/.test(value.replace(scheme, "")) && url.protocol === "http:") url.port = String(OLLAMA_PORT);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch { /* not an address: Ollama's own default, below */ }
  }
  return `http://127.0.0.1:${OLLAMA_PORT}`;
}

/** A server's OpenAI-compatible address: as given, with /v1 when it names only the server. */
function compatibleAddress(baseURL: string): string {
  const url = new URL(baseURL);
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/v1"}`;
}

/** The model ids of servers: "ollama/qwen3:8b", "lmstudio/qwen/qwen3-8b" (a model's own name can hold slashes). */
const LOCAL_ID = /^([a-z0-9][a-z0-9-]{0,39})\/([^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]{0,254}[^\s\x00-\x1f\x7f])?)$/;
export function parseLocalModelId(value: string, servers: readonly LocalServer[]): { server: LocalServer; model: string } | undefined {
  const match = LOCAL_ID.exec(value);
  const found = match ? servers.find((item) => item.id === match[1]) : undefined;
  return found ? { server: found, model: match![2]! } : undefined;
}

/** How to start a server that isn't answering, said where the producer is. */
export function startHint(server: LocalServer): string {
  if (server.where !== HERE) return `Check that ${server.name} is running ${server.where.slice(3)} and can be reached from here`;
  if (server.kind === "ollama") return "Open Ollama, or run: ollama serve";
  if (server.kind === "lmstudio") return "Open LM Studio and start its server (Developer tab), or run: lms server start";
  return `Start it, or check its address (${server.baseURL}) in ~/.kumi/settings.json`;
}

/** Whether Ollama or LM Studio is installed here, so that "not running" is worth saying: from where each installs. */
export function localInstalled(kind: LocalKind, env: Env = process.env): boolean {
  const home = homedir();
  const onPath = (name: string) => (env.PATH ?? "").split(delimiter).some((dir) => dir && (existsSync(join(dir, name)) || existsSync(join(dir, `${name}.exe`))));
  if (kind === "ollama") {
    return onPath("ollama") || existsSync("/Applications/Ollama.app") || existsSync(join(home, "Applications", "Ollama.app"))
      || Boolean(env.LOCALAPPDATA && existsSync(join(env.LOCALAPPDATA, "Programs", "Ollama")));
  }
  if (kind === "lmstudio") return existsSync(join(home, ".lmstudio")) || existsSync("/Applications/LM Studio.app") || onPath("lms");
  return false;
}

interface Transport { fetch?: typeof fetch; signal?: AbortSignal }

/** A GET (or, with a body, a POST) answered in JSON. A refusal is an APICallError with the server's words; no answer, the fetch's own error. */
async function json(url: string, server: LocalServer, options: Transport, body?: unknown, ms?: number): Promise<unknown> {
  const signal = ms ? AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(ms)]) : options.signal;
  const response = await (options.fetch ?? fetch)(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "user-agent": USER_AGENT, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(server.apiKey ? { authorization: `Bearer ${server.apiKey}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  const answer = await response.text();
  const refused = (message: string) => new APICallError({ message, url, requestBodyValues: body ?? {}, statusCode: response.status, responseBody: answer.slice(0, 4_000), isRetryable: false });
  if (!response.ok) throw refused(`HTTP ${response.status}`);
  try { return JSON.parse(answer) as unknown; } catch { throw refused("The server's answer wasn't JSON."); }
}

/** Whether `server` is there: it answers the question its kind answers (or wants a key, so it's running). */
export async function probeLocal(server: LocalServer, options: Transport = {}): Promise<boolean> {
  try { await json(server.kind === "ollama" ? `${server.baseURL}/api/version` : `${server.baseURL}/models`, server, options, undefined, PROBE_MS); return true; }
  catch (error) { return APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403); }
}

/** What a server says about one of its models: what Kumi asks of it, and what /model shows. */
interface Facts {
  model: string;
  name: string;
  /** False when the server says it can't use tools; unknown, it's offered them. */
  tools?: boolean;
  /** It thinks before answering (Ollama), and the levels and default its server reports. */
  thinks?: boolean;
  levels: Effort[];
  thinkDefault?: boolean | string;
  vision?: boolean;
  /** The most tokens it reads at once. */
  most?: number;
  /** The window its server gives it, when that's the server's to set (an older LM Studio, a server named in settings.json). */
  served?: number;
  /** LM Studio's loaded copies of it, each with the context it was loaded with. */
  loaded: { id: string; context?: number }[];
  /** In memory already. */
  inMemory?: boolean;
  details: string[];
}

function ollamaFacts(name: string, details: Json, show: Json, inMemory: boolean): Facts | undefined {
  const capabilities = Array.isArray(show.capabilities) ? show.capabilities.filter((item): item is string => typeof item === "string") : undefined;
  // Embedding and image models don't chat.
  if (capabilities && !capabilities.includes("completion")) return undefined;
  const info = object(show.model_info) ?? {};
  const architecture = text(info["general.architecture"]);
  const most = (architecture ? count(info[`${architecture}.context_length`]) : undefined) ?? count(Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1]);
  const thinking = object(show.thinking) ?? {};
  const shown = object(show.details) ?? {};
  return {
    model: name, name, levels: (Array.isArray(thinking.values) ? thinking.values : []).filter(isEffort),
    ...(capabilities ? { tools: capabilities.includes("tools"), thinks: capabilities.includes("thinking"), vision: capabilities.includes("vision") } : {}),
    ...(typeof thinking.default === "boolean" || typeof thinking.default === "string" ? { thinkDefault: thinking.default } : {}),
    ...(most ? { most } : {}), loaded: [], ...(inMemory ? { inMemory } : {}),
    details: words(details.parameter_size ?? shown.parameter_size, details.quantization_level ?? shown.quantization_level),
  };
}

/** Ollama's models, in its order, each with what /api/show says it can do. */
async function ollamaList(server: LocalServer, options: Transport): Promise<Facts[]> {
  const tags = object(await json(`${server.baseURL}/api/tags`, server, options)) ?? {};
  const running = await json(`${server.baseURL}/api/ps`, server, options)
    .then((body) => new Set(rows(object(body)?.models).map((row) => text(row.name ?? row.model, 300) ?? "")), () => new Set<string>());
  const listed = rows(tags.models).flatMap((row) => { const name = text(row.name ?? row.model, 300); return name ? [{ name, details: object(row.details) ?? {} }] : []; });
  const facts: (Facts | undefined)[] = [];
  // A few at a time: each is read from disk.
  for (let at = 0; at < listed.length; at += 8) {
    facts.push(...await Promise.all(listed.slice(at, at + 8).map(async (row) => {
      const show = object(await json(`${server.baseURL}/api/show`, server, options, { model: row.name }).catch(() => undefined)) ?? {};
      return ollamaFacts(row.name, row.details, show, running.has(row.name));
    })));
  }
  return facts.filter((item): item is Facts => Boolean(item));
}

/** The server answered, but not this question (an older version): the next way of asking is tried. */
const otherwise = (error: unknown) => APICallError.isInstance(error) && error.statusCode !== undefined && error.statusCode !== 401 && error.statusCode !== 403;

/**
 * LM Studio's models: from its own REST API where it has one (it reports tool use and reasoning,
 * and loads a model with the context Kumi needs), from its older one, or from the OpenAI list.
 */
async function lmStudioList(server: LocalServer, options: Transport): Promise<{ facts: Facts[]; managed: boolean }> {
  const origin = new URL(server.baseURL).origin;
  const ask = (url: string) => json(url, server, options).then(object, (error: unknown) => { if (otherwise(error)) return undefined; throw error; });
  const current = await ask(`${origin}/api/v1/models`);
  if (current && Array.isArray(current.models)) {
    return { managed: true, facts: rows(current.models).flatMap((row): Facts[] => {
      if (row.type !== "llm" || typeof row.key !== "string") return [];
      const capabilities = object(row.capabilities) ?? {};
      const reasoning = object(capabilities.reasoning) ?? {};
      const loaded = rows(row.loaded_instances).flatMap((copy) => {
        const context = count(object(copy.config)?.context_length);
        return typeof copy.id === "string" ? [{ id: copy.id, ...(context ? { context } : {}) }] : [];
      });
      const most = count(row.max_context_length);
      return [{ model: row.key, name: text(row.display_name, 60) ?? row.key, levels: (Array.isArray(reasoning.allowed_options) ? reasoning.allowed_options : []).filter(isEffort),
        ...(typeof capabilities.trained_for_tool_use === "boolean" ? { tools: capabilities.trained_for_tool_use } : {}),
        ...(typeof reasoning.default === "string" ? { thinkDefault: reasoning.default } : {}), ...(capabilities.vision === true ? { vision: true } : {}),
        ...(most ? { most } : {}), loaded, ...(loaded.length ? { inMemory: true } : {}), details: words(row.params_string, object(row.quantization)?.name) }];
    }) };
  }
  const older = await ask(`${origin}/api/v0/models`);
  if (older && Array.isArray(older.data)) {
    return { managed: false, facts: rows(older.data).flatMap((row): Facts[] => {
      if ((row.type !== "llm" && row.type !== "vlm") || typeof row.id !== "string") return [];
      const capabilities = Array.isArray(row.capabilities) ? row.capabilities : undefined;
      const most = count(row.max_context_length); const served = count(row.loaded_context_length);
      return [{ model: row.id, name: row.id, levels: [], ...(capabilities ? { tools: capabilities.includes("tool_use") } : {}), ...(row.type === "vlm" ? { vision: true } : {}),
        ...(most ? { most } : {}), ...(served ? { served } : {}), loaded: [], ...(row.state === "loaded" ? { inMemory: true } : {}), details: words(row.quantization) }];
    }) };
  }
  return { managed: false, facts: await compatibleList(server, options) };
}

/** An OpenAI-compatible server's models, with the window it gives them where it says (llama.cpp's server, vLLM). */
async function compatibleList(server: LocalServer, options: Transport): Promise<Facts[]> {
  const body = object(await json(`${server.baseURL}/models`, server, options)) ?? {};
  const listed = rows(body.data).filter((row) => typeof row.id === "string" && !/embed/i.test(row.id));
  const started = listed.some((row) => row.owned_by === "llamacpp")
    ? await json(`${new URL(server.baseURL).origin}/props`, server, options).then((props) => count(object(object(props)?.default_generation_settings)?.n_ctx), () => undefined) : undefined;
  return listed.map((row) => {
    const served = started ?? count(row.max_model_len) ?? count(row.context_length) ?? count(row.max_context_length);
    return { model: String(row.id), name: String(row.id), levels: [], ...(served ? { served } : {}), loaded: [], details: [] };
  });
}

async function listFacts(server: LocalServer, options: Transport): Promise<Facts[]> {
  if (server.kind === "ollama") return ollamaList(server, options);
  if (server.kind === "lmstudio") return (await lmStudioList(server, options)).facts;
  return compatibleList(server, options);
}

function infoOf(server: LocalServer, facts: Facts): ModelInfo {
  const description = [...facts.details, ...(facts.inMemory ? ["loaded"] : []), ...(facts.tools === false ? ["can't change the Set"] : [])].join(" · ");
  const context = facts.served ?? facts.most;
  return { id: `${server.id}/${facts.model}`, provider: server.id, model: facts.model, name: facts.name, ...(description ? { description } : {}),
    efforts: facts.levels.map((effort) => ({ effort })), ...(isEffort(facts.thinkDefault) ? { defaultEffort: facts.thinkDefault } : {}),
    ...(facts.tools !== undefined ? { tools: facts.tools } : {}), ...(context ? { context } : {}), ...(facts.inMemory ? { loaded: true } : {}), where: server.where };
}

/** The models `server` offers, in its order. Throws a KumiError saying what's wrong (not running, a key it refused). */
export async function listLocalModels(server: LocalServer, options: Transport = {}): Promise<ModelInfo[]> {
  const transport = { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(LIST_MS)]) };
  try { return (await listFacts(server, transport)).map((facts) => infoOf(server, facts)); }
  catch (error) {
    if (unanswered(error)) throw failure(server, error, "request");
    const status = APICallError.isInstance(error) ? error.statusCode : undefined;
    if (status === 401 || status === 403) throw failure(server, error, "request");
    throw new KumiError("provider", `${server.name} couldn't list its models${status ? ` (HTTP ${status})` : ""}; check that ${server.baseURL} is the server's address.`, server.id);
  }
}

/** A model Kumi talks to on the producer's server, and what to tell them about it once (it can't change the Set). */
export interface LocalBinding extends ModelBinding {
  readonly note: string | undefined;
  /** Settles once the server has said what the model can do (or didn't answer in time), so the note is known if there is one. */
  readonly asked: Promise<void>;
}

export interface LocalModelOptions {
  fetch?: typeof fetch;
  /** Left out, the model's own. */
  effort?: Effort;
  /** What the producer should hear, learned while the model is used (it can't use tools; LM Studio loaded it again with more room). */
  onNote?: (note: string) => void;
}

/** Said to a model that can't use tools, after Kumi's instructions. */
const NO_TOOLS = "This model can't use tools here: you see the Set only as it's described above, and can't read more of it or change anything. When asked for a change, say so plainly, and that /model chooses a model that can make it.";

/**
 * A model on `server`, ready to call. Nothing need be running yet: what the model can do is asked
 * now, briefly, and otherwise with the first answer, so Kumi starts while Ollama is closed and works
 * as soon as it's open.
 */
export function resolveLocalModel(server: LocalServer, model: string, options: LocalModelOptions = {}): LocalBinding {
  const base = options.fetch ?? fetch;
  // Identify Kumi honestly on every request, as with every provider.
  const identified: typeof fetch = (input, init) => { const headers = new Headers(init?.headers); headers.set("user-agent", USER_AGENT); return base(input, { ...init, headers }); };
  let facts: Facts | undefined;
  let note: string | undefined;
  /** The context the model is loaded with or asked for (it only grows), and what a server said its window is. */
  let window: number | undefined;
  let learned: number | undefined;
  /** The last request's instructions and tools, in bytes. */
  let fixed = 0;
  /** LM Studio's copy of the model that Kumi uses, by its id there. */
  let instance: string | undefined;
  /** Less of the window for the conversation after it outgrew it once (a model whose words take more tokens than most). */
  let squeezed = 1;
  /** Whether the window is the model's own most (Kumi sets the context) or its server's to set. */
  const kumiSets = () => server.kind === "ollama" || instance !== undefined;

  const tell = (said: string, quiet: boolean) => { if (note === said) return; note = said; if (!quiet) options.onNote?.(said); };
  /** What the server says about the model; one that can't use tools brings a note naming one of the server's that can. */
  async function learn(signal: AbortSignal | undefined, quiet: boolean): Promise<Facts> {
    const transport = { fetch: identified, ...(signal ? { signal } : {}) };
    let found: Facts | undefined;
    if (server.kind === "ollama") {
      found = ollamaFacts(model, {}, object(await json(`${server.baseURL}/api/show`, server, transport, { model })) ?? {}, false);
      if (!found) throw new KumiError("model", `${model} on Ollama doesn't chat (it embeds, or makes pictures): choose another model with /model.`, server.id);
    } else {
      const listed = server.kind === "lmstudio" ? (await lmStudioList(server, transport)).facts : await compatibleList(server, transport);
      found = listed.find((item) => item.model === model) ?? listed.find((item) => item.loaded.some((copy) => copy.id === model));
      if (!found && server.kind === "lmstudio") throw new KumiError("model", missing(server, model), server.id);
      // A server named in settings.json may serve whatever it's asked for (llama.cpp's serves one model under any name).
      found ??= { model, name: model, levels: [], loaded: [], details: [] };
    }
    facts = found;
    if (found.tools === false) {
      const others = await listFacts(server, transport).catch(() => undefined);
      const able = others?.find((item) => item.tools === true && item.inMemory) ?? others?.find((item) => item.tools === true);
      const instead = able ? `${able.name} on ${server.name} can: /model chooses it.`
        : others ? `None of ${server.name}'s models can; ${server.kind === "ollama" ? "pull" : "get"} one that can use tools, then choose it with /model.`
        : "/model chooses one that can.";
      tell(`${found.name} can't use tools, so Kumi can talk with it about your Set but can't change anything. ${instead}`, quiet);
    }
    return found;
  }

  /** A request as it goes: the model's facts known, tools left out when it can't use them, and loaded with room. */
  async function readied(callOptions: LanguageModelV4CallOptions): Promise<{ options: LanguageModelV4CallOptions; model: string }> {
    const signal = callOptions.abortSignal;
    await asked;
    const known = facts ?? await learn(signal, false);
    let request = callOptions;
    if (known.tools === false) {
      request = { ...callOptions, prompt: callOptions.prompt.map((message, index) => (index === 0 && message.role === "system" ? { ...message, content: `${message.content}\n\n${NO_TOOLS}` } : message)) };
      delete request.tools; delete request.toolChoice;
    }
    const system = request.prompt[0]?.role === "system" ? request.prompt[0].content : "";
    fixed = Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(request.tools ?? []));
    if (server.kind === "ollama") window = Math.max(window ?? 0, contextFor(fixed, known.most));
    else if (server.kind === "lmstudio") await loadWithRoom(known, signal);
    const room = kumiSets() ? window : known.served ?? learned;
    if (room && tooSmall(room, fixed)) throw new KumiError("model", small(room), server.id);
    return { options: request, model: instance ?? known.model };
  }

  /**
   * LM Studio with its own REST API: the model loaded with the context Kumi needs. A copy loaded with
   * enough is used as it is; one loaded with too little for Kumi's request is loaded again.
   */
  async function loadWithRoom(known: Facts, signal: AbortSignal | undefined): Promise<void> {
    const transport = { fetch: identified, ...(signal ? { signal } : {}) };
    const listed = await lmStudioList(server, transport);
    if (!listed.managed) { instance = undefined; return; }
    const current = listed.facts.find((item) => item.model === known.model) ?? known;
    const copy = current.loaded.find((item) => item.context === undefined || enough(item.context, fixed, current.most));
    if (copy) { instance = copy.id; window = copy.context ?? contextFor(fixed, current.most); return; }
    const wanted = contextFor(fixed, current.most);
    if (tooSmall(wanted, fixed)) { instance = known.model; window = wanted; return; }
    const origin = new URL(server.baseURL).origin;
    for (const old of current.loaded) await json(`${origin}/api/v1/models/unload`, server, transport, { instance_id: old.id }).catch(() => undefined);
    let loaded: Json;
    try { loaded = object(await json(`${origin}/api/v1/models/load`, server, transport, { model: known.model, context_length: wanted, echo_load_config: true })) ?? {}; }
    catch (error) {
      // An LM Studio that lists but doesn't load this way loads the model itself when asked.
      if (APICallError.isInstance(error) && (error.statusCode === 404 || error.statusCode === 405)) { instance = undefined; return; }
      throw error;
    }
    instance = text(loaded.instance_id, 300) ?? known.model;
    window = count(object(loaded.load_config)?.context_length) ?? wanted;
    const before = current.loaded[0]?.context;
    if (before) tell(`LM Studio had ${current.name} loaded with room for ${tokens(before)} tokens, too few for Kumi; Kumi loaded it again with room for ${tokens(window)}.`, false);
  }

  /** The window is too small for Kumi's request, said with the fix where the producer can make it. */
  function small(room: number): string {
    const need = `about ${tokens(Math.max(1000, Math.round(fixed / 4 / 1000) * 1000))}`;
    const name = facts?.name ?? model;
    if (kumiSets()) return `${name} reads at most ${tokens(room)} tokens at once, too few for Kumi's instructions and tools (${need}): choose a model that reads more with /model.`;
    const target = tokens(contextFor(fixed, facts?.most));
    if (server.kind === "lmstudio") return `LM Studio gives ${name} room for ${tokens(room)} tokens, too few for Kumi's instructions and tools (${need}): load it in LM Studio with a context length of ${target} or more, or choose another model with /model.`;
    return `${server.name} gives ${name} room for ${tokens(room)} tokens, too few for Kumi's instructions and tools (${need}): start it with a context of ${target} tokens or more, or choose another model with /model.`;
  }

  const fail = (error: unknown, phase: "request" | "answer"): KumiError => failure(server, error, phase, {
    model: facts?.name ?? model, ...(window ? { window } : {}),
    outgrown: (room) => {
      if (!kumiSets()) learned = room;
      if (tooSmall(room, fixed)) return small(room);
      squeezed *= 0.8;
      return undefined;
    },
  });
  const effortOf = () => (options.effort && facts?.levels.includes(options.effort) ? options.effort : undefined);

  const languageModel: LanguageModelV4 = server.kind === "ollama"
    ? ollamaChat({ baseURL: server.baseURL, model, fetch: identified, failure: fail,
      async shape(callOptions) {
        let prepared: { options: LanguageModelV4CallOptions };
        try { prepared = await readied(callOptions); } catch (error) { if (callOptions.abortSignal?.aborted) throw error; throw fail(error, "request"); }
        const think = effortOf() ?? (facts!.thinks ? facts!.thinkDefault ?? true : undefined);
        return { numCtx: window!, ...(think !== undefined ? { think } : {}), options: prepared.options, images: facts!.vision === true };
      } })
    : compatibleModel(server, model, identified, async (callOptions) => {
      try {
        const prepared = await readied(callOptions);
        const level = effortOf();
        return level ? { ...prepared, options: { ...prepared.options, providerOptions: { ...prepared.options.providerOptions, [server.id]: { reasoningEffort: level } } } } : prepared;
      } catch (error) { if (callOptions.abortSignal?.aborted) throw error; throw fail(error, "request"); }
    }, fail);

  // Asked now, in the background, so a choice can say what the model can't do without Kumi waiting to
  // start; a server that doesn't answer is asked again with the first answer.
  const asked = learn(AbortSignal.timeout(PROBE_MS), true).then(() => undefined, () => undefined);
  return {
    id: `${server.id}/${model}`, model: languageModel, asked,
    get note() { return note; },
    prepare(request: ModelRequest): LanguageModelV4CallOptions {
      return { prompt: [{ role: "system", content: request.instructions }, ...(server.kind === "ollama" ? request.messages : wordsOnly(request.messages))],
        ...(request.tools.length ? { tools: request.tools, toolChoice: { type: "auto" as const } } : {}) };
    },
    budget(size) {
      // The window as known: what the model is loaded with, what its server said, or what Kumi will ask for.
      const room = kumiSets() ? window ?? contextFor(size, facts?.most) : facts?.served ?? learned ?? contextFor(size, facts?.most);
      return budgetFor(Math.floor(room * squeezed), size, ANSWER);
    },
  };
}

/** An OpenAI-compatible model whose requests are readied first, and whose failures are told plainly. */
function compatibleModel(server: LocalServer, model: string, fetcher: typeof fetch, readied: (callOptions: LanguageModelV4CallOptions) => Promise<{ options: LanguageModelV4CallOptions; model: string }>,
  fail: (error: unknown, phase: "request" | "answer") => KumiError): LanguageModelV4 {
  const provider = createOpenAICompatible({ name: server.id, baseURL: server.baseURL, ...(server.apiKey ? { apiKey: server.apiKey } : {}), fetch: mendingFetch(fetcher), includeUsage: true });
  return {
    specificationVersion: "v4", provider: server.id, modelId: model, supportedUrls: {},
    doGenerate() { return Promise.reject(new Error("Kumi streams every answer.")); },
    async doStream(callOptions) {
      const prepared = await readied(callOptions);
      try {
        const result = await provider.chatModel(prepared.model).doStream(prepared.options);
        return { ...result, stream: guarded(result.stream, callOptions.abortSignal, fail) };
      } catch (error) { if (callOptions.abortSignal?.aborted) throw error; throw fail(error, "request"); }
    },
  };
}

/** A stream whose failures are told in plain words: an error it reports, or the connection dropping partway. */
function guarded(stream: ReadableStream<LanguageModelV4StreamPart>, signal: AbortSignal | undefined, fail: (error: unknown, phase: "answer") => KumiError): ReadableStream<LanguageModelV4StreamPart> {
  const reader = stream.getReader();
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value.type === "error" ? { type: "error", error: fail(value.error, "answer") } : value);
      } catch (error) {
        if (signal?.aborted) { controller.error(error); return; }
        controller.enqueue({ type: "error", error: fail(error, "answer") });
        controller.close();
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

const NETWORK = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_\w+)$/;
/** No answer at all: nothing listening, the machine unreachable, or the connection dropped. */
function unanswered(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.statusCode === undefined;
  for (let cause = error, depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK.test(code)) return true;
    if (cause instanceof TypeError && /fetch failed|terminated|other side closed|socket/i.test(cause.message)) return true;
    if (cause instanceof Error && cause.name === "TimeoutError") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** The server's own words about a failure, wherever it put them. */
function serverWords(error: unknown): string {
  const raw = APICallError.isInstance(error) ? error.responseBody ?? "" : "";
  let said = "";
  if (raw) {
    try {
      const body = object(JSON.parse(raw)) ?? {};
      const found = [object(body.error)?.message, body.error, body.message, body.detail].find((item) => typeof item === "string" && item.trim());
      if (typeof found === "string") said = found;
    } catch { said = raw; }
  }
  if (!said) said = error instanceof Error ? error.message : typeof error === "string" ? error : text(object(error)?.message, 1_000) ?? "";
  return cleanDetail(/^HTTP \d+$/.test(said) ? "" : said);
}

const missing = (server: LocalServer, model: string) => server.kind === "ollama"
  ? `Ollama doesn't have ${model}: run \`ollama pull ${model}\`, or choose one you have with /model.`
  : server.kind === "lmstudio" ? `LM Studio doesn't have ${model}: download it in LM Studio, or choose one you have with /model.`
  : `${server.name} doesn't serve ${model}; choose one it does with /model.`;

const CONTEXT = /context (?:length|size|window|limit)|n_ctx|maximum context|too long|too many tokens|tokens to keep|exceeds? (?:the )?(?:available|maximum|context)/i;

/**
 * A local server's failure in the producer's words, with the fix: start it, get the model, a smaller
 * model, more context. `phase` says whether the answer had begun.
 */
function failure(server: LocalServer, error: unknown, phase: "request" | "answer",
  about: { model?: string; window?: number; outgrown?: (room: number) => string | undefined } = {}): KumiError {
  if (error instanceof KumiError) return error;
  const name = server.name; const model = about.model ?? "the model";
  const again = server.where === HERE && server.kind !== "openai-compatible" ? "if it closed, open it again, then send your message again" : "send your message again";
  if (unanswered(error)) {
    if (phase === "answer") return new KumiError("network", `${name} stopped answering partway${server.kind === "ollama" ? " (it may have quit, or run out of memory)" : ""}: ${again}.`, server.id);
    if (server.where !== HERE) return new KumiError("network", `Kumi can't reach ${name} at ${server.baseURL}: check that it's running ${server.where.slice(3)}, then send your message again.`, server.id);
    if (server.kind === "ollama") return new KumiError("network", "Ollama isn't running: open it, or run `ollama serve`, then send your message again.", server.id);
    if (server.kind === "lmstudio") return new KumiError("network", "LM Studio's server isn't running: open LM Studio and start it in the Developer tab, or run `lms server start`, then send your message again.", server.id);
    return new KumiError("network", `${name} isn't answering at ${server.baseURL}: start it, then send your message again.`, server.id);
  }
  const status = APICallError.isInstance(error) ? error.statusCode : undefined;
  const said = serverWords(error);
  const detail = said ? ` (${said})` : "";
  if (status === 401 || status === 403) {
    return new KumiError("auth", `${name} didn't accept ${server.apiKey ? "the key Kumi has for it" : "a request without a key"} (HTTP ${status}): set its apiKey in ~/.kumi/settings.json.`, server.id);
  }
  if (/memory|\boom\b|cudamalloc|unable to allocate|failed to allocate|signal: killed/i.test(said)) {
    const room = about.window ? ` with the room Kumi needs (${tokens(about.window)} tokens)` : "";
    return new KumiError("model", `${name} couldn't fit ${model} in this computer's memory${room}: choose a smaller model with /model, or close other apps and send your message again${detail}.`, server.id);
  }
  if (/does not support tools|tools? (?:is |are )?not supported|--jinja/i.test(said)) {
    return new KumiError("model", /--jinja/.test(said) ? `${name} needs --jinja to use tools: start it with --jinja, or choose another model with /model.`
      : `${model} can't use tools, so Kumi can't change your Set with it: choose another model with /model.`, server.id);
  }
  if (CONTEXT.test(said)) {
    const raw = `${APICallError.isInstance(error) ? error.responseBody ?? "" : ""} ${said}`;
    const reported = [/"n_ctx"\s*:\s*(\d+)/, /context length of only (\d+)/i, /maximum context length is (\d+)/i, /context (?:size|length|window)(?: is| of)? (\d+)/i]
      .map((pattern) => pattern.exec(raw)?.[1]).find(Boolean);
    const room = reported ? Number(reported) : about.window;
    const fix = room ? about.outgrown?.(room) : undefined;
    if (fix) return new KumiError("model", fix, server.id);
    return new KumiError("request", `The conversation outgrew the room ${name} gives ${model}${room ? ` (${tokens(room)} tokens)` : ""}; Kumi keeps it shorter from now on, so send your message again.`, server.id);
  }
  if (status === 404 || /not found|try pulling|no such model|does not exist|unknown model/i.test(said)) return new KumiError("model", missing(server, model), server.id);
  if (phase === "answer") return new KumiError("network", `${name} stopped answering partway${detail}: ${again}.`, server.id);
  if (status !== undefined && status >= 500) return new KumiError("provider", `${name} had trouble answering (HTTP ${status})${detail}; send your message again.`, server.id);
  return new KumiError("request", `${name} turned the request down${status ? ` (HTTP ${status})` : ""}${detail}.`, server.id);
}
