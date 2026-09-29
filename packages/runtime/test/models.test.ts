import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCredentialStore, type CredentialStore } from "../src/auth/store.js";
import { KumiError } from "../src/core/errors.js";
import { checkApiKey, listModels } from "../src/providers/models.js";

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function withStore(body: (store: CredentialStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kumi-models-"));
  try { await body(openCredentialStore(join(dir, "auth.json"))); } finally { await rm(dir, { recursive: true, force: true }); }
}
/** A fetch answering a few URLs, recording what was asked. */
function server(routes: Record<string, (headers: Headers) => Response>) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); const headers = new Headers(init?.headers);
    seen.push({ url, headers });
    return routes[url]?.(headers) ?? new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, seen };
}

test("ChatGPT's models come from its own list: hidden ones left out, its order kept, each with its effort levels", async () => {
  await withStore(async (store) => {
    await store.update("openai-codex", async () => ({ type: "oauth", access: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), refresh: "refresh-1", expires: Date.now() + 86_400_000, accountId: "acct-1" }));
    const { fetch, seen } = server({ "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0": () => json({ models: [
      { slug: "gpt-6-luna", display_name: "GPT-6 Luna", description: "Fast", priority: 3, visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Quick" }, { effort: "medium" }] },
      { slug: "gpt-reserve", display_name: "Reserve", priority: 0, visibility: "hide" },
      { slug: "gpt-6-astra", display_name: "GPT-6 Astra", priority: 1, visibility: "list", default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "turbo" }] },
    ] }) });
    const models = await listModels("openai-codex", { store, fetch });
    assert.deepEqual(models.map((model) => model.id), ["openai-codex/gpt-6-astra", "openai-codex/gpt-6-luna"]);
    assert.deepEqual(models[0]!.efforts.map((level) => level.effort), ["low", "medium", "high", "xhigh"], "a level Kumi can't send is left out");
    assert.equal(models[0]!.defaultEffort, "medium");
    assert.deepEqual(models[1], { id: "openai-codex/gpt-6-luna", provider: "openai-codex", model: "gpt-6-luna", name: "GPT-6 Luna", description: "Fast",
      efforts: [{ effort: "low", description: "Quick" }, { effort: "medium" }], defaultEffort: "low" });
    assert.equal(seen[0]!.headers.get("chatgpt-account-id"), "acct-1");
  });
});

test("API-key providers list with the saved key or the environment's; Anthropic says which efforts each model takes", async () => {
  await withStore(async (store) => {
    await assert.rejects(listModels("anthropic", { store, env: {} }), (error: unknown) => error instanceof KumiError && error.kind === "auth" && error.provider === "anthropic");
    await store.update("anthropic", async () => ({ type: "api-key", key: "sk-ant-saved-0000" }));
    const levels = (...names: string[]) => Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((name) => [name, { supported: names.includes(name) }]));
    const { fetch, seen } = server({
      "https://api.anthropic.com/v1/models?limit=100": (headers) => headers.get("x-api-key") === "sk-ant-saved-0000" ? json({ data: [
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", capabilities: { effort: { supported: true, ...levels("low", "medium", "high", "xhigh", "max") } } },
        { id: "claude-opus-4-5", display_name: "Claude Opus 4.5", capabilities: { effort: { supported: true, ...levels("low", "medium", "high") } } },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", capabilities: { effort: { supported: false } } },
        { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
      ] }) : json({ error: { message: "invalid x-api-key" } }, 401),
      "https://api.openai.com/v1/models": () => json({ data: [
        { id: "gpt-6-luna", created: 2 }, { id: "gpt-realtime-6", created: 3 }, { id: "text-embedding-4", created: 4 }, { id: "o5-mini", created: 1 }, { id: "gpt-6-astra", created: 5 },
      ] }),
      "https://opencode.ai/zen/v1/models": () => json({ data: [{ id: "claude-sonnet-5-5" }, { id: "gemini-3.5-pro" }, { id: "kimi-k2.6" }] }),
    });
    const anthropic = await listModels("anthropic", { store, fetch });
    assert.deepEqual(anthropic.map((model) => [model.name, model.efforts.map((level) => level.effort).join(" ")]), [
      ["Claude Sonnet 5.5", "low medium high xhigh max"], ["Claude Opus 4.5", "low medium high"], ["Claude Haiku 4.5", ""], ["Claude Fable 5.1", "low medium high xhigh max"],
    ]);
    const openai = await listModels("openai", { store, env: { OPENAI_API_KEY: "sk-env-openai" }, fetch });
    assert.deepEqual(openai.map((model) => model.model), ["gpt-6-astra", "gpt-6-luna", "o5-mini"], "chat models only, newest first");
    assert.equal(openai[0]!.efforts.length, 5); assert.equal(openai[2]!.efforts.length, 3);
    const opencode = await listModels("opencode", { store, env: { OPENCODE_API_KEY: "oc-env-key" }, fetch });
    assert.deepEqual(opencode.map((model) => model.model), ["claude-sonnet-5-5", "kimi-k2.6"], "Gemini through OpenCode isn't offered yet");
    // A key saved in Kumi wins over the environment's, which is often a stale one; without it, the environment's.
    await listModels("anthropic", { store, env: { ANTHROPIC_API_KEY: "sk-ant-env-1111" }, fetch });
    assert.equal(seen.at(-1)!.headers.get("x-api-key"), "sk-ant-saved-0000");
    await store.update("anthropic", async () => undefined);
    await listModels("anthropic", { store, env: { ANTHROPIC_API_KEY: "sk-ant-env-1111" }, fetch }).catch(() => undefined);
    assert.equal(seen.at(-1)!.headers.get("x-api-key"), "sk-ant-env-1111");
  });
});

test("a key is checked with its provider before it's kept: accepted, refused, or unanswered", async () => {
  const { fetch } = server({ "https://api.anthropic.com/v1/models?limit=100": (headers) => headers.get("x-api-key") === "good-key-123" ? json({ data: [] }) : json({}, 401) });
  assert.equal(await checkApiKey("anthropic", "good-key-123", { fetch }), "ok");
  assert.equal(await checkApiKey("anthropic", "bad-key-456", { fetch }), "refused");
  assert.equal(await checkApiKey("anthropic", "good-key-123", { fetch: async () => { throw new TypeError("fetch failed"); } }), "unreachable");
  assert.equal(await checkApiKey("anthropic", "good-key-123", { fetch: async () => json({}, 500) }), "unreachable");
});
