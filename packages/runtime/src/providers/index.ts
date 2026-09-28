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
export const USER_AGENT = `kumi/0.0.1 (${platform()} ${release()}; ${arch()})`;

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
    return bind(codex.responses(model), (request) => ({ ...responsesRequest(request, { textVerbosity: "low" }), headers: { "session-id": request.sessionId } }));
  }
  const apiKey = options.env?.[API_KEY_ENV[provider]];
  if (!apiKey) throw new KumiError("auth", `${provider} needs an API key in ${API_KEY_ENV[provider]}.`);
  if (provider === "openai") return bind(createOpenAI({ apiKey, fetch: identified }).responses(model), (request) => responsesRequest(request));
  if (provider === "anthropic") return bind(createAnthropic({ apiKey, fetch: identified }).messages(model), anthropicRequest);

  // OpenCode Zen/Go serve each model family on its native wire format.
  const baseURL = OPENCODE_URL[provider];
  const session = (request: ModelRequest) => ({ "x-opencode-session": request.sessionId });
  if (/^(gpt-|grok-|muse-)/.test(model)) {
    return bind(createOpenAI({ apiKey, baseURL, fetch: identified }).responses(model), (request) => ({ ...responsesRequest(request), headers: session(request) }));
  }
  if (/^claude-/.test(model)) {
    return bind(createAnthropic({ authToken: apiKey, baseURL, fetch: identified }).messages(model), (request) => ({ ...anthropicRequest(request), headers: session(request) }));
  }
  if (/^gemini-/.test(model)) throw new KumiError("config", "Gemini models through OpenCode are not supported yet.");
  return bind(createOpenAICompatible({ name: provider, apiKey, baseURL, fetch: identified, includeUsage: true }).chatModel(model), (request) => ({
    prompt: [{ role: "system", content: request.instructions }, ...request.messages], ...toolOptions(request), headers: session(request),
  }));
}

function toolOptions({ tools }: ModelRequest): Pick<LanguageModelV4CallOptions, "tools" | "toolChoice"> {
  return tools.length ? { tools, toolChoice: { type: "auto" } } : {};
}

/** OpenAI Responses: stateless (store=false), so encrypted reasoning is replayed from Kumi's own history. */
function responsesRequest(request: ModelRequest, extra: Record<string, string> = {}): LanguageModelV4CallOptions {
  return {
    prompt: request.messages, ...toolOptions(request),
    providerOptions: { openai: { instructions: request.instructions, store: false, promptCacheKey: request.sessionId, ...extra } },
  };
}

/** Anthropic: cache the stable instructions/tools prefix and the growing conversation. */
function anthropicRequest(request: ModelRequest): LanguageModelV4CallOptions {
  const messages: LanguageModelV4Message[] = [...request.messages];
  const last = messages.at(-1);
  if (last) messages[messages.length - 1] = { ...last, providerOptions: { ...last.providerOptions, ...CACHE } } as LanguageModelV4Message;
  return { prompt: [{ role: "system", content: request.instructions, providerOptions: CACHE }, ...messages], ...toolOptions(request) };
}
