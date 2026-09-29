/**
 * Which model Kumi talks to, how hard it thinks, and the sign-ins behind them: what /model,
 * /effort, /login and /logout change. Models come from each provider's own list, so new ones
 * appear by themselves. Keys are checked with their provider before they're kept, and kept only
 * in Kumi's owner-only credential file.
 */
import {
  apiKeyFor, checkApiKey, EFFORTS, KumiError, listModels, loginCodexBrowser, loginCodexDevice, OPENAI_CODEX, parseModelId, PROVIDER_INFO, PROVIDERS, resolveModel,
  type CredentialStore, type Effort, type ModelBinding, type ModelInfo, type ProviderId,
} from "@kumi/runtime";
import { readSettings, writeSettings, type Settings } from "./config.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Providers in the order Kumi offers them: a ChatGPT plan first, then keys. */
export const OFFER_ORDER: readonly ProviderId[] = ["openai-codex", "anthropic", "openai", "opencode", "opencode-go"];

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  signIn: "chatgpt" | "api-key";
  signedIn: boolean;
  /** Where the sign-in comes from: an environment variable can't be signed out of from Kumi. */
  via?: "chatgpt" | "saved key" | "environment";
  keyPage?: string;
  keyEnv?: string;
}

export interface CurrentModel {
  model?: string;
  provider?: ProviderId;
  /** Its name from the provider's list, once read. */
  name?: string;
  effort?: Effort;
  /** What the model does when no effort is chosen, and what it takes. */
  defaultEffort?: Effort;
  efforts: ModelInfo["efforts"];
  /** KUMI_MODEL set in the environment: choices last until Kumi closes. */
  pinned: boolean;
}

export interface ModelControl {
  current(): CurrentModel;
  providers(): Promise<ProviderStatus[]>;
  /**
   * With no model chosen: the first model its provider lists, from the first provider signed in,
   * chosen and returned. Undefined when none is signed in or no list could be read.
   */
  chooseDefault(): Promise<ModelInfo | undefined>;
  /** The provider's models, from its own list (read once per session, then kept). */
  models(provider: ProviderId, refresh?: boolean): Promise<ModelInfo[]>;
  /** Use `model` from the next answer on. Throws KumiError("auth") when its provider isn't signed in. */
  choose(model: string): Promise<void>;
  /** Undefined: the model's own default. */
  setEffort(effort: Effort | undefined): Promise<void>;
  /** Check the key with the provider, and keep it unless the provider refused it. */
  saveKey(provider: ProviderId, key: string, signal?: AbortSignal): Promise<"ok" | "refused" | "unreachable">;
  signInChatGPT(io: { signal: AbortSignal; onUrl(url: string): void } | { signal: AbortSignal; device: true; onCode(prompt: { url: string; code: string }): void }): Promise<void>;
  /** False when there was nothing to sign out of (or it comes from the environment). */
  signOut(provider: ProviderId): Promise<boolean>;
  /** The chosen model, ready to call; a KumiError says what's missing (a model, a sign-in). */
  binding(): Promise<ModelBinding>;
}

export function createModelControl(options: {
  store: CredentialStore;
  settingsFile: string;
  env: Env;
  /** Called after a change that the next answer should pick up (the session builds a new kernel). */
  changed(): Promise<void>;
  fetch?: typeof fetch;
}): ModelControl {
  const { store, settingsFile, env } = options;
  const pinned = Boolean(env.KUMI_MODEL);
  const settings = (): Settings => readSettings(settingsFile);
  let model = env.KUMI_MODEL ?? settings().model;
  let effort = settings().effort;
  const catalog = new Map<ProviderId, ModelInfo[]>();
  let bound: { model: string; effort?: Effort; binding: ModelBinding } | undefined;

  const infoFor = (id: string | undefined) => {
    const provider = id ? parseModelId(id)?.provider : undefined;
    return provider ? catalog.get(provider)?.find((item) => item.id === id) : undefined;
  };
  // The choices as they stand; with KUMI_MODEL set, the model chosen in Kumi lasts until it closes.
  const save = () => {
    const saved = settings().model;
    const kept = pinned ? saved : model;
    writeSettings(settingsFile, { ...(kept ? { model: kept } : {}), ...(effort ? { effort } : {}) });
  };

  const control: ModelControl = {
    current() {
      const info = infoFor(model);
      const provider = model ? parseModelId(model)?.provider : undefined;
      return { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(info ? { name: info.name } : {}), ...(effort ? { effort } : {}),
        ...(info?.defaultEffort ? { defaultEffort: info.defaultEffort } : {}), efforts: info?.efforts ?? [], pinned };
    },
    async providers() {
      const statuses: ProviderStatus[] = [];
      for (const id of [...OFFER_ORDER, ...PROVIDERS.filter((id) => !OFFER_ORDER.includes(id))]) {
        const info = PROVIDER_INFO[id];
        let via: ProviderStatus["via"];
        if (info.signIn === "chatgpt") via = (await store.get(OPENAI_CODEX))?.type === "oauth" ? "chatgpt" : undefined;
        else { const key = await apiKeyFor(id, store, env); via = key?.source === "env" ? "environment" : key ? "saved key" : undefined; }
        statuses.push({ id, name: info.name, signIn: info.signIn, signedIn: via !== undefined, ...(via ? { via } : {}),
          ...(info.keyPage ? { keyPage: info.keyPage } : {}), ...(info.keyEnv ? { keyEnv: info.keyEnv } : {}) });
      }
      return statuses;
    },
    async chooseDefault() {
      if (model) return undefined;
      for (const provider of (await control.providers()).filter((status) => status.signedIn)) {
        const first = (await control.models(provider.id).catch(() => []))[0];
        if (first) { await control.choose(first.id); return first; }
      }
      return undefined;
    },
    async models(provider, refresh = false) {
      const known = catalog.get(provider);
      if (known && !refresh) return known;
      const listed = await listModels(provider, { store, env, ...(options.fetch ? { fetch: options.fetch } : {}), signal: AbortSignal.timeout(15_000) });
      catalog.set(provider, listed);
      return listed;
    },
    async choose(next) {
      const parsed = parseModelId(next);
      if (!parsed) throw new KumiError("config", `${next} isn't a model Kumi knows how to reach.`);
      const info = infoFor(next);
      // An effort the new model doesn't take goes back to its default.
      const keep = effort && (!info || info.efforts.some((level) => level.effort === effort)) ? effort : undefined;
      const binding = await resolveModel({ model: next, store, env, ...(keep ? { effort: keep } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
      model = next; effort = keep; bound = { model: next, ...(keep ? { effort: keep } : {}), binding };
      save();
      await options.changed();
    },
    async setEffort(next) {
      if (next !== undefined && !(EFFORTS as readonly string[]).includes(next)) throw new KumiError("config", `${String(next)} isn't an effort level.`);
      effort = next; bound = undefined;
      save();
      await options.changed();
    },
    async saveKey(provider, key, signal) {
      const info = PROVIDER_INFO[provider];
      if (info.signIn !== "api-key") throw new KumiError("config", `${info.name} signs in with ChatGPT, not a key.`);
      const trimmed = key.trim();
      const verdict = await checkApiKey(provider, trimmed, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(signal ? { signal } : {}) });
      if (verdict === "refused") return verdict;
      await store.update(info.credential, async () => ({ type: "api-key", key: trimmed }));
      catalog.delete(provider); if (provider === "opencode") catalog.delete("opencode-go"); if (provider === "opencode-go") catalog.delete("opencode");
      if (model && parseModelId(model)?.provider === provider) { bound = undefined; await options.changed(); }
      return verdict;
    },
    async signInChatGPT(io) {
      const credential = "device" in io ? await loginCodexDevice({ signal: io.signal, onCode: io.onCode }) : await loginCodexBrowser({ signal: io.signal, onUrl: io.onUrl });
      await store.update(OPENAI_CODEX, async () => credential);
      catalog.delete("openai-codex");
      // With no model yet, ChatGPT's own first choice, rather than a name written into Kumi.
      if (!model) { await control.chooseDefault(); return; }
      if (parseModelId(model)?.provider === "openai-codex") { bound = undefined; await options.changed(); }
    },
    async signOut(provider) {
      const info = PROVIDER_INFO[provider];
      const held = await store.get(info.credential);
      if (!held) return false;
      await store.update(info.credential, async () => undefined);
      catalog.delete(provider);
      if (model && PROVIDER_INFO[parseModelId(model)?.provider ?? provider].credential === info.credential) { bound = undefined; await options.changed(); }
      return true;
    },
    async binding() {
      if (!model) throw new KumiError("config", "Choose a model to talk to: type /model.");
      if (bound && bound.model === model && bound.effort === effort) return bound.binding;
      const binding = await resolveModel({ model, store, env, ...(effort ? { effort } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
      bound = { model, ...(effort ? { effort } : {}), binding };
      return binding;
    },
  };
  return control;
}
