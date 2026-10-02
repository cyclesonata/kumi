/**
 * The models each provider offers this producer, for choosing one, read from the provider itself:
 * a model released today appears, and a retired one goes, without a Kumi update. Kumi keeps no
 * list of its own; a provider it isn't signed in to shows its models after sign-in.
 */
import { codexTokenSource } from "../auth/openai-codex.js";
import type { CredentialStore } from "../auth/store.js";
import { KumiError } from "../core/errors.js";
import { apiKeyFor, EFFORTS, PROVIDER_INFO, USER_AGENT, type Effort, type ProviderId } from "./index.js";

export interface ModelInfo {
  /** "<provider>/<model>", as settings and KUMI_MODEL name it. */
  id: string;
  /** One of PROVIDERS, or a model server's id ("ollama"). */
  provider: string;
  model: string;
  name: string;
  description?: string;
  /** The effort levels it takes, in order; empty when it has none to choose. */
  efforts: { effort: Effort; description?: string }[];
  /** Its own effort when none is chosen. */
  defaultEffort?: Effort;
  /** False when its server says it can't use tools: it talks, but can't change the Set. */
  tools?: boolean;
  /** The most tokens it reads at once, as its server says. */
  context?: number;
  /** In memory already, so it answers without loading first. */
  loaded?: boolean;
  /** A model on the producer's own server: "on this computer", or the machine it's on. */
  where?: string;
}

interface ListOptions {
  store: CredentialStore;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const CODEX_MODELS = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
const ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models?limit=100";
const OPENAI_MODELS = "https://api.openai.com/v1/models";
const OPENCODE_MODELS: Partial<Record<ProviderId, string>> = { opencode: "https://opencode.ai/zen/v1/models", "opencode-go": "https://opencode.ai/zen/go/v1/models" };

const levels = (...efforts: Effort[]) => efforts.map((effort) => ({ effort }));
const ALL_EFFORTS = levels("low", "medium", "high", "xhigh", "max");
const OPENAI_EFFORTS = levels("low", "medium", "high");

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);

type Transport = Pick<ListOptions, "fetch" | "signal">;

async function getJson(url: string, headers: Record<string, string>, options: Transport, provider: ProviderId): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(url, { headers: { "user-agent": USER_AGENT, ...headers }, ...(options.signal ? { signal: options.signal } : {}) });
  const name = PROVIDER_INFO[provider].name;
  if (response.status === 401 || response.status === 403) throw new KumiError("auth", `${name} didn't accept this sign-in (HTTP ${response.status}).`, provider);
  if (!response.ok) throw new KumiError("provider", `${name} couldn't list its models (HTTP ${response.status}).`, provider);
  return response.json() as Promise<unknown>;
}

/**
 * What `model` from `provider` is called, and what it takes, when only its id is known: by family,
 * as the model SDKs tell them apart (GPT-6 on takes the full range; earlier reasoning models three).
 */
function fromId(provider: ProviderId, model: string, name = model): ModelInfo {
  const gpt = Number(/^gpt-(\d+)/.exec(model)?.[1]);
  const efforts = /^claude-haiku/.test(model) ? [] : /^claude-/.test(model) || gpt >= 6 ? ALL_EFFORTS : gpt >= 5 || /^o\d/.test(model) ? OPENAI_EFFORTS : [];
  return { id: `${provider}/${model}`, provider, model, name, efforts };
}

/** ChatGPT's order for a model: 0 is first, not missing; no priority goes last. */
const rank = (priority: unknown) => { const value = typeof priority === "number" ? priority : typeof priority === "string" && priority.trim() ? Number(priority) : NaN; return Number.isFinite(value) ? value : 999; };

/** The models this producer can use from `provider`, best first. Throws KumiError("auth") when not signed in. */
export async function listModels(provider: ProviderId, options: ListOptions): Promise<ModelInfo[]> {
  if (provider === "openai-codex") {
    const { access, accountId } = await codexTokenSource(options.store, options.fetch ? { fetch: options.fetch } : {})();
    const body = record(await getJson(CODEX_MODELS, { authorization: `Bearer ${access}`, "chatgpt-account-id": accountId, originator: "kumi" }, options, provider));
    const rows = (Array.isArray(body.models) ? body.models : []).map(record)
      .filter((row) => typeof row.slug === "string" && row.visibility !== "hide")
      .sort((a, b) => rank(a.priority) - rank(b.priority));
    return rows.map((row) => {
      const model = String(row.slug);
      const efforts = (Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : []).map(record)
        .filter((level) => isEffort(level.effort)).map((level) => ({ effort: level.effort as Effort, ...(text(level.description) ? { description: text(level.description)! } : {}) }));
      return { id: `${provider}/${model}`, provider, model, name: text(row.display_name, 60) ?? model, ...(text(row.description) ? { description: text(row.description)! } : {}),
        efforts, ...(isEffort(row.default_reasoning_level) ? { defaultEffort: row.default_reasoning_level } : {}) };
    });
  }
  const key = (await apiKeyFor(provider, options.store, options.env))?.key;
  if (!key) throw new KumiError("auth", `Not signed in to ${PROVIDER_INFO[provider].name}.`, provider);
  return listWithKey(provider, key, options);
}

async function listWithKey(provider: ProviderId, key: string, options: Transport): Promise<ModelInfo[]> {
  const all = options;
  if (provider === "anthropic") {
    const body = record(await getJson(ANTHROPIC_MODELS, { "x-api-key": key, "anthropic-version": "2023-06-01" }, all, provider));
    return (Array.isArray(body.data) ? body.data : []).map(record).filter((row) => typeof row.id === "string").map((row) => {
      const info = fromId(provider, String(row.id), text(row.display_name, 60) ?? String(row.id));
      // The API says which effort levels each model takes.
      const effort = record(record(row.capabilities).effort);
      if (effort.supported === false) return { ...info, efforts: [] };
      if (effort.supported === true) return { ...info, efforts: EFFORTS.filter((level) => record(effort[level]).supported === true).map((level) => ({ effort: level })) };
      return info;
    });
  }
  if (provider === "openai") {
    const body = record(await getJson(OPENAI_MODELS, { authorization: `Bearer ${key}` }, all, provider));
    return (Array.isArray(body.data) ? body.data : []).map(record)
      .filter((row) => typeof row.id === "string" && /^(gpt-|o\d)/.test(row.id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation)/.test(row.id))
      .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
      .map((row) => fromId(provider, String(row.id)));
  }
  const url = OPENCODE_MODELS[provider];
  if (!url) return [];
  const body = record(await getJson(url, { authorization: `Bearer ${key}` }, all, provider));
  // Gemini through OpenCode isn't wired up yet, so its models aren't offered.
  return (Array.isArray(body.data) ? body.data : []).map(record).filter((row) => typeof row.id === "string" && !/^gemini-/.test(row.id))
    .map((row) => fromId(provider, String(row.id)));
}

/**
 * Whether `provider` takes `key`, asked before the key is saved: "ok", "refused" (it said no), or
 * "unreachable" (no answer, so it can't be told yet).
 */
export async function checkApiKey(provider: ProviderId, key: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<"ok" | "refused" | "unreachable"> {
  try { await listWithKey(provider, key, options); return "ok"; }
  catch (error) { return error instanceof KumiError && error.kind === "auth" ? "refused" : "unreachable"; }
}
