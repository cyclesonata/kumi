import { KumiError, parseModelId, PROVIDER_INFO, PROVIDERS, type Effort, type ModelInfo, type ProviderId } from "@kumi/runtime";
import type { ModelControl, ProviderStatus } from "../src/models.js";

/** A ModelControl held in memory: sign-ins, lists and choices, with each call recorded. */
export function fakeModels(options: { model?: string; effort?: Effort; signedIn?: ProviderId[]; lists?: Partial<Record<ProviderId, ModelInfo[]>> } = {}) {
  const calls: string[] = [];
  let model = options.model;
  let effort = options.effort;
  const signedIn = new Set<ProviderId>(options.signedIn ?? []);
  const shared = (provider: ProviderId) => PROVIDERS.filter((other) => PROVIDER_INFO[other].credential === PROVIDER_INFO[provider].credential);
  let finishChatGPT: (() => void) | undefined;
  const info = (id = model) => { const provider = id ? parseModelId(id)?.provider : undefined; return provider ? options.lists?.[provider]?.find((item) => item.id === id) : undefined; };
  const control: ModelControl = {
    current() {
      const found = info(); const provider = model ? parseModelId(model)?.provider : undefined;
      return { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(found ? { name: found.name } : {}), ...(effort ? { effort } : {}),
        ...(found?.defaultEffort ? { defaultEffort: found.defaultEffort } : {}), efforts: found?.efforts ?? [], pinned: false };
    },
    async providers(): Promise<ProviderStatus[]> {
      return (["openai-codex", "anthropic", "openai", "opencode", "opencode-go"] as const).map((id) => {
        const about = PROVIDER_INFO[id];
        const via = signedIn.has(id) ? about.signIn === "chatgpt" ? "chatgpt" as const : "saved key" as const : undefined;
        return { id, name: about.name, signIn: about.signIn, signedIn: Boolean(via), ...(via ? { via } : {}),
          ...(about.keyPage ? { keyPage: about.keyPage } : {}), ...(about.keyEnv ? { keyEnv: about.keyEnv } : {}) };
      });
    },
    async chooseDefault() {
      if (model) return undefined;
      const order = ["openai-codex", "anthropic", "openai", "opencode", "opencode-go"] as const;
      const provider = order.find((id) => signedIn.has(id) && options.lists?.[id]?.length);
      const first = provider ? options.lists![provider]![0]! : undefined;
      if (first) { model = first.id; calls.push(`default:${first.id}`); }
      return first;
    },
    async models(provider) {
      calls.push(`list:${provider}`);
      if (!signedIn.has(provider)) throw new KumiError("auth", `Not signed in to ${PROVIDER_INFO[provider].name}.`, provider);
      return options.lists?.[provider] ?? [];
    },
    async choose(next) {
      const provider = parseModelId(next)!.provider;
      if (!signedIn.has(provider)) throw new KumiError("auth", `Not signed in to ${PROVIDER_INFO[provider].name}.`, provider);
      const found = info(next);
      if (effort && found && !found.efforts.some((level) => level.effort === effort)) effort = undefined;
      model = next; calls.push(`choose:${next}`);
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

export const MODELS: Partial<Record<ProviderId, ModelInfo[]>> = {
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
