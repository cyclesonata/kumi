import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCredentialStore, type OAuthCredential } from "../src/auth/store.js";
import { KumiError } from "../src/core/errors.js";
import { createAgentKernel } from "../src/kernel/agent.js";
import { resolveModel } from "../src/providers/index.js";

interface Captured { url: string; headers: Headers; body: Record<string, unknown> & { input?: Record<string, unknown>[] }; form?: URLSearchParams }
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const access = (account = "acct-1") => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: account }, exp: Math.floor(Date.now() / 1000) + 3600 });
const sse = (events: object[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const rejection = () => new Response(JSON.stringify({ error: { message: "fixture rejection" } }), { status: 400, headers: { "content-type": "application/json" } });
const created = (id: string) => ({ type: "response.created", response: { id, object: "response", created_at: 1_760_000_000, status: "in_progress", model: "gpt-6-astra", output: [], usage: null, service_tier: null, incomplete_details: null } });
const completed = (id: string) => ({ type: "response.completed", response: { id, status: "completed", model: "gpt-6-astra", incomplete_details: null, service_tier: null,
  usage: { input_tokens: 63, input_tokens_details: { cached_tokens: 5 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 78 } } });
const reasoningThenCall = [
  created("resp_1"),
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", encrypted_content: "enc-1", summary: [] } },
  { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", encrypted_content: "enc-1", summary: [] } },
  { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", status: "in_progress", arguments: "", call_id: "call_1", name: "get_tempo" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{}" },
  { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", status: "completed", arguments: "{}", call_id: "call_1", name: "get_tempo" } },
  completed("resp_1"),
];
const answer = [
  created("resp_2"),
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_2", type: "message", status: "in_progress", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "120", logprobs: [] },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_2", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "120", annotations: [], logprobs: [] }] } },
  completed("resp_2"),
];

function recorder(respond: (request: Captured, index: number) => Response) {
  const requests: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    const form = init?.body instanceof URLSearchParams ? init.body : undefined;
    const request: Captured = { url: String(input), headers: new Headers(init?.headers), body: raw && !form ? JSON.parse(raw) : {}, ...(form ? { form } : {}) };
    requests.push(request);
    return respond(request, requests.length);
  };
  return { fetch: fetchImpl, requests };
}
async function withStore(credential: OAuthCredential | undefined, body: (store: ReturnType<typeof openCredentialStore>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kumi-provider-"));
  try {
    const store = openCredentialStore(join(dir, "auth.json"));
    if (credential) await store.update("openai-codex", async () => credential);
    await body(store);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const codexCredential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential =>
  ({ type: "oauth", access: access(), refresh: "refresh-1", expires: Date.now() + 86_400_000, accountId: "acct-1", ...overrides });
function kernelFor(binding: Awaited<ReturnType<typeof resolveModel>>) {
  return createAgentKernel({ binding, instructions: "fixture instructions", signal: new AbortController().signal,
    tools: [{ name: "get_tempo", description: "tempo", inputSchema: { type: "object", properties: {} }, async execute() { return { text: '{"tempo":120}' }; } }] });
}

test("codex: stateless Responses requests identify Kumi, carry account/session headers, and replay encrypted reasoning", async () => {
  // One credential: a second one would carry a later expiry once the clock ticks over a second.
  const credential = codexCredential();
  await withStore(credential, async (store) => {
    const { fetch, requests } = recorder((_request, n) => sse(n === 1 ? reasoningThenCall : answer));
    const kernel = kernelFor(await resolveModel({ model: "openai-codex/gpt-6-astra", store, fetch, env: { OPENAI_API_KEY: "sk-not-for-codex" } }));
    let text = "";
    const result = await kernel.run("tempo?", new AbortController().signal, (event) => { if (event.type === "text") text += event.text; });
    assert.equal(text, "120");
    assert.equal(result.usage?.inputTokens, 126);
    assert.equal(result.usage?.cacheReadTokens, 10);
    const [first, second] = requests;
    assert.equal(first?.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(first?.headers.get("authorization"), `Bearer ${credential.access}`);
    assert.equal(first?.headers.get("chatgpt-account-id"), "acct-1");
    assert.equal(first?.headers.get("originator"), "kumi");
    assert.equal(first?.headers.get("openai-beta"), "responses=experimental");
    assert.match(first?.headers.get("user-agent") ?? "", /^kumi\/\S+ \(/);
    const session = first?.headers.get("session-id");
    assert.match(session ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(first?.body.prompt_cache_key, session);
    assert.equal(first?.body.store, false);
    assert.equal(first?.body.instructions, "fixture instructions");
    assert.deepEqual(first?.body.text, { verbosity: "low" });
    assert.deepEqual(first?.body.include, ["reasoning.encrypted_content"]);
    assert.equal(first?.body.max_output_tokens, undefined);
    assert(!JSON.stringify(first?.body.input).includes("fixture instructions"), "instructions are not duplicated as a system message");
    assert.deepEqual(second?.body.input?.slice(1), [
      { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] },
      { type: "function_call", call_id: "call_1", name: "get_tempo", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: '{"tempo":120}' },
    ]);
    for (const request of requests) assert(!JSON.stringify([...request.headers]).includes("sk-not-for-codex"));
    await kernel.close();
  });
});

test("codex: refreshes a token near expiry under the store lock and persists the rotated refresh token", async () => {
  await withStore(codexCredential({ expires: Date.now() + 60_000 }), async (store) => {
    const fresh = access("acct-1");
    const { fetch, requests } = recorder((request) => request.url === "https://auth.openai.com/oauth/token"
      ? Response.json({ access_token: fresh, refresh_token: "refresh-2", expires_in: 3600 })
      : sse(answer));
    const kernel = kernelFor(await resolveModel({ model: "openai-codex/gpt-6-astra", store, fetch }));
    await kernel.run("hi", new AbortController().signal, () => {});
    assert.equal(requests[0]?.form?.get("grant_type"), "refresh_token");
    assert.equal(requests[0]?.form?.get("refresh_token"), "refresh-1");
    assert.equal(requests.filter((request) => request.url.includes("oauth/token")).length, 1, "one refresh, shared by later requests");
    assert.equal(requests.at(-1)?.headers.get("authorization"), `Bearer ${fresh}`);
    const stored = await store.get("openai-codex");
    assert.equal(stored?.refresh, "refresh-2");
    assert(stored!.expires > Date.now() + 30 * 60_000);
    await kernel.close();
  });
});

test("codex: a missing or revoked sign-in fails with login guidance and no model request", async () => {
  await withStore(undefined, async (store) => {
    const { fetch, requests } = recorder(() => rejection());
    await assert.rejects(resolveModel({ model: "openai-codex/gpt-6-astra", store, fetch }), (error: unknown) =>
      error instanceof KumiError && /login openai-codex/.test(error.message));
    assert.equal(requests.length, 0);
  });
  await withStore(codexCredential({ expires: Date.now() - 1 }), async (store) => {
    const { fetch } = recorder(() => new Response("{}", { status: 401 }));
    await assert.rejects(resolveModel({ model: "openai-codex/gpt-6-astra", store, fetch }), /could not be refreshed \(HTTP 401\).*login openai-codex/);
  });
});

test("API-key providers use their own endpoints, credentials, and cache/session hints", async () => {
  const key = "key-fixture-value";
  const cases: [string, string, (request: Captured) => void][] = [
    ["openai/gpt-6-luna", "https://api.openai.com/v1/responses", (request) => {
      assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
      assert.equal(request.body.store, false);
      assert.equal(request.headers.get("chatgpt-account-id"), null);
    }],
    ["anthropic/claude-sonnet-5", "https://api.anthropic.com/v1/messages", (request) => {
      assert.equal(request.headers.get("x-api-key"), key);
      assert.deepEqual(request.body.system, [{ type: "text", text: "fixture instructions", cache_control: { type: "ephemeral" } }]);
      const messages = request.body.messages as { content: { cache_control?: unknown }[] }[];
      assert.deepEqual(messages.at(-1)?.content.at(-1)?.cache_control, { type: "ephemeral" });
    }],
    ["opencode/claude-sonnet-5", "https://opencode.ai/zen/v1/messages", (request) => {
      assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
      assert.match(request.headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
    }],
    ["opencode/gpt-5.5", "https://opencode.ai/zen/v1/responses", (request) => assert.equal(request.headers.get("authorization"), `Bearer ${key}`)],
    ["opencode/kimi-k2.6", "https://opencode.ai/zen/v1/chat/completions", (request) => {
      assert.equal((request.body.messages as { role: string }[])[0]?.role, "system");
      assert.match(request.headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
    }],
    ["opencode-go/gpt-5.5", "https://opencode.ai/zen/go/v1/responses", (request) => assert.match(request.headers.get("user-agent") ?? "", /^kumi\//)],
  ];
  await withStore(undefined, async (store) => {
    for (const [model, url, check] of cases) {
      const { fetch, requests } = recorder(() => rejection());
      const kernel = kernelFor(await resolveModel({ model, store, fetch, env: { OPENAI_API_KEY: key, ANTHROPIC_API_KEY: key, OPENCODE_API_KEY: key } }));
      await assert.rejects(kernel.run("hi", new AbortController().signal, () => {}), /fixture rejection/);
      assert.equal(requests[0]?.url, url, model);
      check(requests[0]!);
      await kernel.close();
    }
  });
});

test("missing keys, unknown providers and unsupported routes fail with configuration guidance, never echoing values", async () => {
  await withStore(undefined, async (store) => {
    await assert.rejects(resolveModel({ model: "anthropic/claude-sonnet-5", store, env: {} }), /ANTHROPIC_API_KEY/);
    await assert.rejects(resolveModel({ model: "opencode/gemini-3.5-pro", store, env: { OPENCODE_API_KEY: "k" } }), /Gemini/);
    for (const model of ["gateway/secret-value", "openai-codex/", "openai-codex/has space", "anthropic"]) {
      await assert.rejects(resolveModel({ model, store }), (error: unknown) => error instanceof KumiError && !error.message.includes("secret-value"));
    }
  });
});
