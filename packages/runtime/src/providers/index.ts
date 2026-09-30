import { KUMI_VERSION } from "../version.js";
import { arch, platform, release } from "node:os";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Message, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { codexTokenSource } from "../auth/openai-codex.js";
import type { CredentialStore } from "../auth/store.js";
import { KumiError } from "../core/errors.js";
import type { ModelBinding, ModelRequest } from "../kernel/agent.js";

export const PROVIDERS = ["openai-codex", "openai", "anthropic", "opencode", "opencode-go"] as const;
export type ProviderId = typeof PROVIDERS[number];
/** Providers authenticated by API key, and the environment variable holding it. */
export const API_KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", opencode: "OPENCODE_API_KEY", "opencode-go": "OPENCODE_API_KEY" } as const;
export const USER_AGENT = `kumi/${KUMI_VERSION} (${platform()} ${release()}; ${arch()})`;

/** How hard a model thinks before answering; providers take a subset (a model lists its own). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof EFFORTS[number];

/** A provider as producers know it, and how Kumi signs in to it. */
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** "chatgpt": a ChatGPT plan, signed in through the browser; "api-key": a key the producer pastes. */
  signIn: "chatgpt" | "api-key";
  /** Where its sign-in is kept; OpenCode's two gateways share one key. */
  credential: string;
  keyEnv?: string;
  /** Where to make a key. */
  keyPage?: string;
}
export const PROVIDER_INFO: Readonly<Record<ProviderId, ProviderInfo>> = {
  "openai-codex": { id: "openai-codex", name: "ChatGPT", signIn: "chatgpt", credential: "openai-codex" },
  anthropic: { id: "anthropic", name: "Anthropic", signIn: "api-key", credential: "anthropic", keyEnv: "ANTHROPIC_API_KEY", keyPage: "platform.claude.com (API keys)" },
  openai: { id: "openai", name: "OpenAI API", signIn: "api-key", credential: "openai", keyEnv: "OPENAI_API_KEY", keyPage: "platform.openai.com/api-keys" },
  opencode: { id: "opencode", name: "OpenCode Zen", signIn: "api-key", credential: "opencode", keyEnv: "OPENCODE_API_KEY", keyPage: "opencode.ai/auth" },
  "opencode-go": { id: "opencode-go", name: "OpenCode Go", signIn: "api-key", credential: "opencode", keyEnv: "OPENCODE_API_KEY", keyPage: "opencode.ai/auth" },
};

/**
 * A provider's API key: the one the producer saved in Kumi (with /login, the most deliberate and
 * usually the latest choice; an environment variable is often a stale one), else the environment's.
 * Undefined when there's none.
 */
export async function apiKeyFor(provider: ProviderId, store: CredentialStore, env: Readonly<Record<string, string | undefined>> = {}): Promise<{ key: string; source: "env" | "saved" } | undefined> {
  const info = PROVIDER_INFO[provider];
  if (info.signIn !== "api-key") return undefined;
  const saved = await store.get(info.credential);
  if (saved?.type === "api-key") return { key: saved.key, source: "saved" };
  const fromEnv = info.keyEnv ? env[info.keyEnv] : undefined;
  return fromEnv ? { key: fromEnv, source: "env" } : undefined;
}

const MODEL_ID = /^(openai-codex|openai|anthropic|opencode|opencode-go)\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})$/;
const CODEX_URL = "https://chatgpt.com/backend-api/codex";
const OPENCODE_URL = { opencode: "https://opencode.ai/zen/v1", "opencode-go": "https://opencode.ai/zen/go/v1" } as const;
const CACHE: SharedV4ProviderOptions = { anthropic: { cacheControl: { type: "ephemeral" } } };

export function parseModelId(value: string): { provider: ProviderId; model: string } | undefined {
  const match = MODEL_ID.exec(value);
  return match ? { provider: match[1] as ProviderId, model: match[2]! } : undefined;
}

export interface ResolveModelOptions {
  /** "<provider>/<model>", e.g. "openai-codex/gpt-6-astra". */
  model: string;
  store: CredentialStore;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  /** Left out, the model's own default. */
  effort?: Effort;
}

/** Build a binding for a configured model. Fails before any request when credentials are missing. */
export async function resolveModel(options: ResolveModelOptions): Promise<ModelBinding> {
  const parsed = parseModelId(options.model);
  if (!parsed) throw new KumiError("config", `KUMI_MODEL must be <provider>/<model> with provider one of ${PROVIDERS.join(", ")}.`);
  const { provider, model } = parsed;
  const base = options.fetch ?? fetch;
  // Identify Kumi honestly on every provider request.
  const identified: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", `${USER_AGENT} ${headers.get("user-agent") ?? ""}`.trim());
    return base(input, { ...init, headers });
  };
  const bind = (languageModel: LanguageModelV4, prepare: (request: ModelRequest) => LanguageModelV4CallOptions): ModelBinding =>
    ({ id: options.model, model: languageModel, prepare });
  // OpenAI's wire format names effort reasoningEffort; Anthropic's names it effort (see anthropicRequest).
  const openaiEffort: Record<string, string> = options.effort ? { reasoningEffort: options.effort } : {};

  if (provider === "openai-codex") {
    const token = codexTokenSource(options.store, { fetch: base });
    await token();
    const codex = createOpenAI({
      // Placeholder so the SDK never falls back to OPENAI_API_KEY; the OAuth token is set per request.
      apiKey: "kumi-oauth", baseURL: CODEX_URL,
      fetch: async (input, init) => {
        const { access, accountId } = await token();
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${access}`);
        headers.set("chatgpt-account-id", accountId);
        headers.set("originator", "kumi");
        headers.set("openai-beta", "responses=experimental");
        return identified(input, { ...init, headers });
      },
    });
    return bind(codex.responses(model), (request) => ({ ...responsesRequest(request, { textVerbosity: "low", ...openaiEffort }), headers: { "session-id": request.sessionId } }));
  }
  const info = PROVIDER_INFO[provider];
  const apiKey = (await apiKeyFor(provider, options.store, options.env))?.key;
  if (!apiKey) throw new KumiError("auth", `Not signed in to ${info.name}: add its API key with /login (or set ${info.keyEnv}).`, provider);
  if (provider === "openai") return bind(createOpenAI({ apiKey, fetch: identified }).responses(model), (request) => responsesRequest(request, openaiEffort));
  if (provider === "anthropic") return bind(createAnthropic({ apiKey, fetch: identified }).messages(model), (request) => anthropicRequest(request, options.effort));

  // OpenCode Zen/Go serve each model family on its native wire format.
  const baseURL = OPENCODE_URL[provider];
  const session = (request: ModelRequest) => ({ "x-opencode-session": request.sessionId });
  if (/^(gpt-|grok-|muse-)/.test(model)) {
    return bind(createOpenAI({ apiKey, baseURL, fetch: identified }).responses(model), (request) => ({ ...responsesRequest(request, openaiEffort), headers: session(request) }));
  }
  if (/^claude-/.test(model)) {
    return bind(createAnthropic({ authToken: apiKey, baseURL, fetch: identified }).messages(model), (request) => ({ ...anthropicRequest(request, options.effort), headers: session(request) }));
  }
  if (/^gemini-/.test(model)) throw new KumiError("config", "Gemini models through OpenCode are not supported yet.");
  return bind(createOpenAICompatible({ name: provider, apiKey, baseURL, fetch: identified, includeUsage: true }).chatModel(model), (request) => ({
    prompt: [{ role: "system", content: request.instructions }, ...wordsOnly(request.messages)], ...toolOptions(request), headers: session(request),
  }));
}

function toolOptions({ tools }: ModelRequest): Pick<LanguageModelV4CallOptions, "tools" | "toolChoice"> {
  return tools.length ? { tools, toolChoice: { type: "auto" } } : {};
}

type ToolPart = Extract<LanguageModelV4Message, { role: "tool" }>["content"][number];
/** Each tool result's images changed by `change`; messages without any stay as they are. */
function mapImages(messages: LanguageModelV4Message[], change: (part: Extract<ToolPart, { type: "tool-result" }>) => ToolPart): LanguageModelV4Message[] {
  return messages.map((message) => (message.role !== "tool" || !message.content.some((part) => part.type === "tool-result" && part.output.type === "content") ? message
    : { ...message, content: message.content.map((part) => (part.type === "tool-result" && part.output.type === "content" ? change(part) : part)) }));
}

/** OpenAI-compatible chat carries only words in a tool result: each image becomes a line saying so. */
function wordsOnly(messages: LanguageModelV4Message[]): LanguageModelV4Message[] {
  return mapImages(messages, (part) => ({ ...part, output: { type: "text", value: part.output.type !== "content" ? "" : part.output.value
    .map((item) => (item.type === "text" ? item.text : item.type === "file" ? "[An image this model can't be shown.]" : "")).filter(Boolean).join("\n") } }));
}

/** Frames of software have small print: OpenAI reads each image at full detail. */
function inDetail(messages: LanguageModelV4Message[]): LanguageModelV4Message[] {
  return mapImages(messages, (part) => (part.output.type !== "content" ? part : { ...part, output: { ...part.output, value: part.output.value
    .map((item) => (item.type === "file" ? { ...item, providerOptions: { ...item.providerOptions, openai: { ...item.providerOptions?.openai, imageDetail: "high" } } } : item)) } }));
}

/** OpenAI Responses: stateless (store=false), so encrypted reasoning is replayed from Kumi's own history. */
function responsesRequest(request: ModelRequest, extra: Record<string, string> = {}): LanguageModelV4CallOptions {
  return {
    prompt: inDetail(request.messages), ...toolOptions(request),
    providerOptions: { openai: { instructions: request.instructions, store: false, promptCacheKey: request.sessionId, ...extra } },
  };
}

/** Anthropic: cache the stable instructions/tools prefix and the growing conversation. */
function anthropicRequest(request: ModelRequest, effort?: Effort): LanguageModelV4CallOptions {
  const messages: LanguageModelV4Message[] = [...request.messages];
  const last = messages.at(-1);
  if (last) messages[messages.length - 1] = { ...last, providerOptions: { ...last.providerOptions, ...CACHE } } as LanguageModelV4Message;
  return { prompt: [{ role: "system", content: request.instructions, providerOptions: CACHE }, ...messages], ...toolOptions(request),
    ...(effort ? { providerOptions: { anthropic: { effort } } } : {}) };
}
