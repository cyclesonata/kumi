/**
 * Which model Kumi talks to, how hard it thinks, and the sign-ins behind them: what /model,
 * /effort, /login and /logout change. Models come from each provider's own list, so new ones
 * appear by themselves; models served on the producer's own computer (Ollama, LM Studio, servers
 * named in settings.json) come from those servers, with no sign-in. Keys are checked with their
 * provider before they're kept, and kept only in Kumi's owner-only credential file.
 */
import {
  apiKeyFor, checkApiKey, EFFORTS, KumiError, listLocalModels, listModels, localInstalled, localServers, loginCodexBrowser, loginCodexDevice, OPENAI_CODEX, parseLocalModelId, parseModelId,
  probeLocal, PROVIDER_INFO, PROVIDERS, resolveLocalModel, resolveModel, startHint,
  type CredentialStore, type Effort, type LocalKind, type LocalServer, type ModelBinding, type ModelInfo, type ProviderId,
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

/** A model server the producer runs, and whether it's answering. */
export interface LocalStatus {
  id: string;
  name: string;
  /** "on this computer", or the machine it's on. */
  where: string;
  running: boolean;
  /** How to start it, when it isn't running. */
  start?: string;
}

export interface CurrentModel {
  model?: string;
  /** One of PROVIDERS, or a model server's id ("ollama"). */
  provider?: string;
  /** Its name from the provider's list, once read. */
  name?: string;
  effort?: Effort;
  /** What the model does when no effort is chosen, and what it takes. */
  defaultEffort?: Effort;
  efforts: ModelInfo["efforts"];
  /** KUMI_MODEL set in the environment: choices last until Kumi closes. */
  pinned: boolean;
  /** A model on the producer's own server: where it is. */
  where?: string;
}

export interface ModelControl {
  current(): CurrentModel;
  providers(): Promise<ProviderStatus[]>;
  /**
   * The model servers worth showing: running, installed here but closed, or named in settings.json.
   * Quick: a server that isn't running refuses at once.
   */
  local(): Promise<LocalStatus[]>;
  /** What a provider or server is called: "ChatGPT", "Ollama", a server's own name. */
  providerName(id: string): string;
  /**
   * With no model chosen: the first model its provider lists, from the first provider signed in, or
   * else a model on this computer (one that can change the Set, loaded already if there is one),
   * chosen and returned with what to say about it. Undefined when there's none to choose.
   */
  chooseDefault(): Promise<(ModelInfo & { note?: string }) | undefined>;
  /** The provider's models, from its own list (read once per session, then kept); a server's, read each time. */
  models(provider: string, refresh?: boolean): Promise<ModelInfo[]>;
  /**
   * Use `model` from the next answer on; returns what the producer should hear about it, once (a
   * model that can't change the Set). Throws KumiError("auth") when its provider isn't signed in.
   */
  choose(model: string): Promise<string | undefined>;
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
  /** What Kumi learns about the chosen model as it's used, said once (a model that can't change the Set). */
  say?: (message: string) => void;
  /** Whether Ollama or LM Studio is installed here, so a closed one is shown; looked up when left out. */
  installed?: (kind: LocalKind) => boolean;
}): ModelControl {
  const { store, settingsFile, env } = options;
  const pinned = Boolean(env.KUMI_MODEL);
  const settings = (): Settings => readSettings(settingsFile);
  let model = env.KUMI_MODEL ?? settings().model;
  let effort = settings().effort;
  const catalog = new Map<string, ModelInfo[]>();
  /** A binding, and for a model on a server, what it learns about the model (a note to say once). */
  type Bound = ModelBinding & { readonly note?: string | undefined; readonly asked?: Promise<void> };
  let bound: { model: string; effort?: Effort; binding: Bound } | undefined;
  const transport = options.fetch ? { fetch: options.fetch } : {};

  const servers = (): LocalServer[] => localServers(settings().modelServers, env);
  /** A model id's provider (or server) and model. */
  const parse = (id: string | undefined): { provider: string; model: string; server?: LocalServer } | undefined => {
    if (!id) return undefined;
    const cloud = parseModelId(id);
    if (cloud) return cloud;
    const local = parseLocalModelId(id, servers());
    return local ? { provider: local.server.id, model: local.model, server: local.server } : undefined;
  };
  const infoFor = (id: string | undefined) => {
    const provider = parse(id)?.provider;
    return provider ? catalog.get(provider)?.find((item) => item.id === id) : undefined;
  };
  // What the producer has heard about models this session, so each thing is said once.
  const heard = new Set<string>();
  const once = (note: string | undefined) => { if (!note || heard.has(note)) return undefined; heard.add(note); return note; };
  const say = (note: string) => { const fresh = once(note); if (fresh) options.say?.(fresh); };
  const bind = async (id: string, level: Effort | undefined): Promise<Bound> => {
    const parsed = parse(id);
    if (parsed?.server) return resolveLocalModel(parsed.server, parsed.model, { ...transport, ...(level ? { effort: level } : {}), onNote: say });
    return resolveModel({ model: id, store, env, ...(level ? { effort: level } : {}), ...transport });
  };
  /** The default being chosen, shared: the session may ask for the model while the app is choosing it. */
  let defaulting: Promise<(ModelInfo & { note?: string }) | undefined> | undefined;
  // The choices as they stand; with KUMI_MODEL set, the model chosen in Kumi lasts until it closes.
  const save = () => {
    const saved = settings().model;
    const kept = pinned ? saved : model;
    writeSettings(settingsFile, { ...(kept ? { model: kept } : {}), ...(effort ? { effort } : {}) });
  };

  const control: ModelControl = {
    current() {
      const info = infoFor(model);
      const parsed = parse(model);
      return { ...(model ? { model } : {}), ...(parsed ? { provider: parsed.provider } : {}), ...(info ? { name: info.name } : {}), ...(effort ? { effort } : {}),
        ...(info?.defaultEffort ? { defaultEffort: info.defaultEffort } : {}), efforts: info?.efforts ?? [], pinned, ...(parsed?.server ? { where: parsed.server.where } : {}) };
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
    async local() {
      const installed = options.installed ?? ((kind: LocalKind) => localInstalled(kind, env));
      const found = await Promise.all(servers().map(async (server): Promise<LocalStatus | undefined> => {
        const running = await probeLocal(server, transport);
        // A closed server is worth a line when the producer has it: named in settings.json, set in OLLAMA_HOST, or installed here.
        const theirs = server.kind === "openai-compatible" || (server.kind === "ollama" && Boolean(env.OLLAMA_HOST)) || installed(server.kind);
        if (!running && !theirs) return undefined;
        return { id: server.id, name: server.name, where: server.where, running, ...(running ? {} : { start: startHint(server) }) };
      }));
      return found.filter((status): status is LocalStatus => Boolean(status));
    },
    providerName(id) {
      if ((PROVIDERS as readonly string[]).includes(id)) return PROVIDER_INFO[id as ProviderId].name;
      return servers().find((server) => server.id === id)?.name ?? id;
    },
    chooseDefault() {
      if (model) return Promise.resolve(undefined);
      defaulting ??= (async () => {
        for (const provider of (await control.providers()).filter((status) => status.signedIn)) {
          const first = (await control.models(provider.id).catch(() => []))[0];
          if (first) { await control.choose(first.id); return first; }
        }
        // Signed in nowhere (or no provider answering): a model on this computer.
        for (const server of (await control.local()).filter((status) => status.running)) {
          const listed = await control.models(server.id).catch(() => []);
          const pick = listed.find((item) => item.tools !== false && item.loaded) ?? listed.find((item) => item.tools !== false) ?? listed[0];
          if (pick) { const note = await control.choose(pick.id); return { ...pick, ...(note ? { note } : {}) }; }
        }
        return undefined;
      })().finally(() => { defaulting = undefined; });
      return defaulting;
    },
    async models(provider, refresh = false) {
      const server = servers().find((item) => item.id === provider);
      const known = catalog.get(provider);
      // A server's models change as the producer pulls and loads them: they're read each time.
      if (known && !refresh && !server) return known;
      const signal = AbortSignal.timeout(15_000);
      const listed = server ? await listLocalModels(server, { ...transport, signal })
        : (PROVIDERS as readonly string[]).includes(provider) ? await listModels(provider as ProviderId, { store, env, ...transport, signal }) : [];
      catalog.set(provider, listed);
      return listed;
    },
    async choose(next) {
      if (!parse(next)) throw new KumiError("config", `${next} isn't a model Kumi knows how to reach.`);
      const info = infoFor(next);
      // An effort the new model doesn't take goes back to its default.
      const keep = effort && (!info || info.efforts.some((level) => level.effort === effort)) ? effort : undefined;
      const binding = await bind(next, keep);
      model = next; effort = keep; bound = { model: next, ...(keep ? { effort: keep } : {}), binding };
      save();
      await options.changed();
      // A model on a server says what it can't do with the choice.
      await binding.asked;
      return once(binding.note);
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
      const verdict = await checkApiKey(provider, trimmed, { ...transport, ...(signal ? { signal } : {}) });
      if (verdict === "refused") return verdict;
      await store.update(info.credential, async () => ({ type: "api-key", key: trimmed }));
      catalog.delete(provider); if (provider === "opencode") catalog.delete("opencode-go"); if (provider === "opencode-go") catalog.delete("opencode");
      // By the key, not the provider: OpenCode Zen and Go share one.
      const current = model ? parseModelId(model)?.provider : undefined;
      if (current && PROVIDER_INFO[current].credential === info.credential) { bound = undefined; await options.changed(); }
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
      const current = model ? parseModelId(model)?.provider : undefined;
      if (current && PROVIDER_INFO[current].credential === info.credential) { bound = undefined; await options.changed(); }
      return true;
    },
    async binding() {
      // Kumi starting with no model yet: the one being chosen for it, rather than an answer saying to choose.
      if (!model) await control.chooseDefault().catch(() => undefined);
      if (!model) throw new KumiError("config", "Choose a model to talk to: type /model.");
      if (bound && bound.model === model && bound.effort === effort) return bound.binding;
      const binding = await bind(model, effort);
      bound = { model, ...(effort ? { effort } : {}), binding };
      // Said once it's known, without holding up the answer.
      void binding.asked?.then(() => { if (binding.note) say(binding.note); });
      return binding;
    },
  };
  return control;
}
