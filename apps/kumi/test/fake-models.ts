import { KumiError, parseModelId, PROVIDER_INFO, PROVIDERS, type Effort, type ModelInfo, type ProviderId } from "@kumi/runtime";
import type { LocalStatus, ModelControl, ProviderStatus } from "../src/models.js";

/** A ModelControl held in memory: sign-ins, model servers, lists and choices, with each call recorded. */
export function fakeModels(options: { model?: string; effort?: Effort; signedIn?: ProviderId[]; lists?: Partial<Record<string, ModelInfo[]>>; local?: LocalStatus[]; notes?: Record<string, string> } = {}) {
  const calls: string[] = [];
  let model = options.model;
  let effort = options.effort;
  const signedIn = new Set<ProviderId>(options.signedIn ?? []);
  const shared = (provider: ProviderId) => PROVIDERS.filter((other) => PROVIDER_INFO[other].credential === PROVIDER_INFO[provider].credential);
  let finishChatGPT: (() => void) | undefined;
  const local = options.local ?? [];
  /** A model's provider, as the real control parses it: a provider's, or a server's. */
  const providerOf = (id: string) => parseModelId(id)?.provider ?? local.find((server) => id.startsWith(`${server.id}/`))?.id;
  const info = (id = model) => { const provider = id ? providerOf(id) : undefined; return provider ? options.lists?.[provider]?.find((item) => item.id === id) : undefined; };
  const isLocal = (provider: string) => local.some((server) => server.id === provider);
  const control: ModelControl = {
    current() {
      const found = info(); const provider = model ? providerOf(model) : undefined; const server = local.find((item) => item.id === provider);
      return { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(found ? { name: found.name } : {}), ...(effort ? { effort } : {}),
        ...(found?.defaultEffort ? { defaultEffort: found.defaultEffort } : {}), efforts: found?.efforts ?? [], pinned: false, ...(server ? { where: server.where } : {}) };
    },
    async providers(): Promise<ProviderStatus[]> {
      return (["openai-codex", "anthropic", "openai", "opencode", "opencode-go"] as const).map((id) => {
        const about = PROVIDER_INFO[id];
        const via = signedIn.has(id) ? about.signIn === "chatgpt" ? "chatgpt" as const : "saved key" as const : undefined;
        return { id, name: about.name, signIn: about.signIn, signedIn: Boolean(via), ...(via ? { via } : {}),
          ...(about.keyPage ? { keyPage: about.keyPage } : {}), ...(about.keyEnv ? { keyEnv: about.keyEnv } : {}) };
      });
    },
    async local() { return local; },
    providerName(id) { return id in PROVIDER_INFO ? PROVIDER_INFO[id as ProviderId].name : local.find((server) => server.id === id)?.name ?? id; },
    async chooseDefault() {
      if (model) return undefined;
      const order = ["openai-codex", "anthropic", "openai", "opencode", "opencode-go"] as const;
      const provider = order.find((id) => signedIn.has(id) && options.lists?.[id]?.length) ?? local.find((server) => server.running && options.lists?.[server.id]?.length)?.id;
      const first = provider ? options.lists![provider]![0]! : undefined;
      if (!first) return undefined;
      model = first.id; calls.push(`default:${first.id}`);
      const note = options.notes?.[first.id];
      return { ...first, ...(note ? { note } : {}) };
    },
    async models(provider) {
      calls.push(`list:${provider}`);
      if (!isLocal(provider) && !signedIn.has(provider as ProviderId)) throw new KumiError("auth", `Not signed in to ${PROVIDER_INFO[provider as ProviderId].name}.`, provider);
      return options.lists?.[provider] ?? [];
    },
    async choose(next) {
      const provider = providerOf(next)!;
      if (!isLocal(provider) && !signedIn.has(provider as ProviderId)) throw new KumiError("auth", `Not signed in to ${PROVIDER_INFO[provider as ProviderId].name}.`, provider);
      const found = info(next);
      if (effort && found && !found.efforts.some((level) => level.effort === effort)) effort = undefined;
      model = next; calls.push(`choose:${next}`);
      return options.notes?.[next];
    },
    async setEffort(next) { effort = next; calls.push(`effort:${next ?? "default"}`); },
    async saveKey(provider, key) {
      calls.push(`key:${provider}:${key.length}`);
      if (key.startsWith("refused")) return "refused";
      for (const other of shared(provider)) signedIn.add(other);
      return "ok";
    },
    async signInChatGPT(io) {
      calls.push("chatgpt");
      if ("onUrl" in io) io.onUrl("https://auth.example.test/oauth/authorize?client=kumi&state=fixture");
      await new Promise<void>((resolve, reject) => {
        finishChatGPT = resolve;
        io.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      signedIn.add("openai-codex");
      if (!model && options.lists?.["openai-codex"]?.[0]) model = options.lists["openai-codex"][0].id;
    },
    async signOut(provider) {
      calls.push(`signout:${provider}`);
      if (!signedIn.has(provider)) return false;
      for (const other of shared(provider)) signedIn.delete(other);
      return true;
    },
    async binding() { throw new Error("The fake doesn't bind models."); },
  };
  return { control, calls, signedIn, finishChatGPT: () => finishChatGPT?.() };
}

export const MODELS: Partial<Record<string, ModelInfo[]>> = {
  "openai-codex": [
    { id: "openai-codex/gpt-6-astra", provider: "openai-codex", model: "gpt-6-astra", name: "GPT-6 Astra", description: "Frontier model for complex work",
      efforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }], defaultEffort: "medium" },
    { id: "openai-codex/gpt-6-luna", provider: "openai-codex", model: "gpt-6-luna", name: "GPT-6 Luna", description: "Fast and light",
      efforts: [{ effort: "low" }, { effort: "medium" }], defaultEffort: "low" },
  ],
  anthropic: [
    { id: "anthropic/claude-sonnet-5-5", provider: "anthropic", model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5",
      efforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }] },
    { id: "anthropic/claude-haiku-4-5", provider: "anthropic", model: "claude-haiku-4-5", name: "Claude Haiku 4.5", efforts: [] },
  ],
};
