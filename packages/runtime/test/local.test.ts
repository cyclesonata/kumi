import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { KernelTool } from "../src/core/contracts.js";
import { KumiError } from "../src/core/errors.js";
import { createAgentKernel } from "../src/kernel/agent.js";
import { mendStream, thinkSplitter } from "../src/providers/compat.js";
import { contextFor, listLocalModels, localServers, parseLocalModelId, probeLocal, resolveLocalModel, type LocalServer } from "../src/providers/local.js";

type Json = Record<string, any>;
interface Seen { method: string; url: string; body: Json; headers: IncomingHttpHeaders }

/** An HTTP server on this computer for one test, recording what it's asked. */
async function serve(handle: (request: Seen, response: ServerResponse, seen: Seen[]) => unknown) {
  const seen: Seen[] = [];
  const server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const chunk of incoming) raw += String(chunk);
    const request = { method: incoming.method ?? "GET", url: incoming.url ?? "/", body: raw ? JSON.parse(raw) as Json : {}, headers: incoming.headers };
    seen.push(request);
    await handle(request, response, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const send = (response: ServerResponse, body: unknown, status = 200): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
/** A port nothing listens on. */
async function closedPort() { const fake = await serve(() => {}); await fake.close(); return fake.url; }

interface FakeModel { capabilities?: string[]; context?: number; thinking?: { values: unknown[]; default: unknown }; loaded?: boolean }
/** Ollama's API for `models`; each chat answered with the lines `chat` gives (or a status and body). */
function ollama(models: Record<string, FakeModel>, chat: (body: Json, n: number) => Json[] | { status: number; body: unknown } | ((response: ServerResponse) => void) = () => []) {
  let chats = 0;
  return async (request: Seen, response: ServerResponse) => {
    if (request.url === "/api/version") return send(response, { version: "0.12.6" });
    if (request.url === "/api/tags") return send(response, { models: Object.keys(models).map((name) => ({ name, model: name, details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } })) });
    if (request.url === "/api/ps") return send(response, { models: Object.entries(models).filter(([, model]) => model.loaded).map(([name]) => ({ name, model: name })) });
    if (request.url === "/api/show") {
      const model = models[request.body.model];
      if (!model) return send(response, { error: `model '${request.body.model}' not found` }, 404);
      return send(response, { ...(model.capabilities ? { capabilities: model.capabilities } : {}), model_info: { "general.architecture": "qwen3", ...(model.context ? { "qwen3.context_length": model.context } : {}) },
        ...(model.thinking ? { thinking: model.thinking } : {}), details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } });
    }
    if (request.url === "/api/chat") {
      const answer = chat(request.body, ++chats);
      if (typeof answer === "function") return answer(response);
      if (!Array.isArray(answer)) return send(response, answer.body, answer.status);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of answer) response.write(`${JSON.stringify(line)}\n`);
      return response.end();
    }
    send(response, { error: "not found" }, 404);
  };
}
const said = (content: string) => ({ message: { role: "assistant", content }, done: false });
const done = (extra: Json = {}) => ({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 900, eval_count: 12, ...extra });

const signal = () => new AbortController().signal;
const calls: Json[] = [];
const tempo: KernelTool = { name: "get_tempo", description: "The Set's tempo", inputSchema: { type: "object", properties: { precise: { type: "boolean" } } },
  async execute(input) { calls.push(input); return { text: '{"tempo":120}' }; } };
/** Kumi's real request, as big as it is: 16 KB of instructions and 70 tools of about 1 KB each. */
const INSTRUCTIONS = "Kumi's instructions, at their length. ".repeat(430);
const CATALOG: KernelTool[] = Array.from({ length: 70 }, (_, index) => ({ name: `change_${index}`, description: `A change to Live. ${"It says what it changes, what it takes, and what it leaves alone. ".repeat(13)}`,
  inputSchema: { type: "object", properties: { ref: { type: "string", description: "What to change, by its reference from the Set" }, value: { type: "number" } }, required: ["ref"] },
  async execute() { return { text: "ok" }; } }));
const fixedOf = (instructions: string, tools: readonly KernelTool[]) => Buffer.byteLength(instructions)
  + Buffer.byteLength(JSON.stringify(tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
const ollamaAt = (url: string) => localServers([], { OLLAMA_HOST: url })[0]!;
const lmStudioAt = (url: string): LocalServer => ({ id: "lmstudio", kind: "lmstudio", name: "LM Studio", baseURL: `${url}/v1`, where: "on this computer" });
interface Asking { instructions?: string; tools?: KernelTool[]; effort?: "low" | "high"; notes?: string[] }
async function answer(server: LocalServer, model: string, options: Asking = {}) {
  const binding = resolveLocalModel(server, model, { ...(options.effort ? { effort: options.effort } : {}), onNote: (note) => options.notes?.push(note) });
  const kernel = createAgentKernel({ binding, instructions: options.instructions ?? "fixture instructions", signal: signal(), tools: options.tools ?? [tempo] });
  let text = "";
  try {
    const result = await kernel.run("What's the tempo?", signal(), (event) => { if (event.type === "text") text += event.text; });
    return { text, result, binding };
  } finally { await kernel.close(); }
}
/** The KumiError a failed answer ends with. */
async function failed(server: LocalServer, model: string, options: Asking = {}): Promise<KumiError> {
  try { await answer(server, model, options); } catch (error) { assert.ok(error instanceof KumiError, String(error)); return error; }
  assert.fail("the answer should have failed");
}

test("Kumi finds Ollama where OLLAMA_HOST says, LM Studio where it listens, and the servers named in settings.json, each with a model id of its own", () => {
  const address = (host?: string) => localServers([], host === undefined ? {} : { OLLAMA_HOST: host })[0]!.baseURL;
  assert.equal(address(), "http://127.0.0.1:11434");
  assert.equal(address("0.0.0.0"), "http://127.0.0.1:11434", "listening everywhere is here");
  assert.equal(address("0.0.0.0:8000"), "http://127.0.0.1:8000");
  assert.equal(address("http://studio.local:11434/"), "http://studio.local:11434");
  assert.equal(address("studio.local"), "http://studio.local:11434");
  assert.equal(address("https://ollama.example.test"), "https://ollama.example.test");
  const servers = localServers([{ name: "llama.cpp", baseURL: "http://127.0.0.1:8080" }, { name: "Studio PC", baseURL: "http://192.168.1.20:8000/v1/", apiKey: "lan-token" },
    { name: "OpenAI", baseURL: "http://127.0.0.1:9000/v1" }, { name: "llama.cpp", baseURL: "http://127.0.0.1:8081/v1" }], {});
  assert.deepEqual(servers.map((item) => [item.id, item.baseURL, item.where]), [
    ["ollama", "http://127.0.0.1:11434", "on this computer"], ["lmstudio", "http://127.0.0.1:1234/v1", "on this computer"],
    ["llama-cpp", "http://127.0.0.1:8080/v1", "on this computer"], ["studio-pc", "http://192.168.1.20:8000/v1", "on 192.168.1.20"],
    ["openai-2", "http://127.0.0.1:9000/v1", "on this computer"], ["llama-cpp-2", "http://127.0.0.1:8081/v1", "on this computer"]]);
  assert.equal(servers[3]!.apiKey, "lan-token");
  assert.deepEqual(parseLocalModelId("ollama/qwen3:8b", servers), { server: servers[0], model: "qwen3:8b" });
  assert.equal(parseLocalModelId("lmstudio/qwen/qwen3-8b", servers)?.model, "qwen/qwen3-8b", "a model's own name keeps its slashes");
  assert.equal(parseLocalModelId("llama-cpp-2/My Model Q4.gguf", servers)?.server.baseURL, "http://127.0.0.1:8081/v1");
  for (const id of ["anthropic/claude-sonnet-5", "nowhere/model", "ollama/", "ollama/ spaced", "ollama/bad\u0007"]) assert.equal(parseLocalModelId(id, servers), undefined, id);
});

test("Ollama's models come from Ollama: what each can do, how much it reads, which are loaded; embedding models aren't offered", async () => {
  const fake = await serve(ollama({
    "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], context: 40960, loaded: true },
    "gemma3:4b": { capabilities: ["completion", "vision"], context: 131072 },
    "gpt-oss:20b": { capabilities: ["completion", "tools", "thinking"], context: 131072, thinking: { values: ["low", "medium", "high"], default: "medium" } },
    "nomic-embed-text": { capabilities: ["embedding"] },
  }));
  try {
    const server = ollamaAt(fake.url);
    assert.equal(await probeLocal(server), true);
    const models = await listLocalModels(server);
    assert.deepEqual(models.map((model) => model.id), ["ollama/qwen3:8b", "ollama/gemma3:4b", "ollama/gpt-oss:20b"]);
    assert.deepEqual(models[0], { id: "ollama/qwen3:8b", provider: "ollama", model: "qwen3:8b", name: "qwen3:8b", description: "8.2B · Q4_K_M · loaded",
      efforts: [], tools: true, context: 40960, loaded: true, where: "on this computer" });
    assert.equal(models[1]!.description, "8.2B · Q4_K_M · can't change the Set");
    assert.equal(models[1]!.tools, false);
    assert.deepEqual(models[2]!.efforts.map((level) => level.effort), ["low", "medium", "high"], "levels only where Ollama reports them");
    assert.equal(models[2]!.defaultEffort, "medium");
    assert.equal(await probeLocal(ollamaAt(await closedPort())), false);
  } finally { await fake.close(); }
});

test("Ollama: Kumi's request goes to /api/chat with the room it needs, tools in Ollama's form, and each result goes back tied to its call", async () => {
  const fake = await serve(ollama({ "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], context: 40960 } }, (_body, n) => (n === 1
    ? [{ message: { role: "assistant", content: "", thinking: "The tempo first." }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_tempo", arguments: { precise: true } } }] }, done: false }, done()]
    : [said("It's "), said("120 BPM."), done({ prompt_eval_count: 40, prompt_eval_cached_count: 900, eval_count: 5 })])));
  try {
    calls.length = 0;
    const { text, result } = await answer(ollamaAt(fake.url), "qwen3:8b");
    assert.equal(text, "It's 120 BPM.");
    assert.deepEqual(calls, [{ precise: true }]);
    assert.equal(result.usage?.inputTokens, 1840);
    assert.equal(result.usage?.cacheReadTokens, 900);
    const [first, second] = fake.seen.filter((request) => request.url === "/api/chat");
    assert.equal(first!.body.model, "qwen3:8b");
    assert.equal(first!.body.stream, true);
    assert.equal(first!.body.truncate, false, "a request that doesn't fit is refused, not cut");
    assert.equal(first!.body.think, true, "a thinking model's thinking comes apart from its words");
    assert.equal(first!.body.options.num_ctx, 32768, "room for the request, the conversation and an answer, in steps");
    assert.deepEqual(first!.body.messages[0], { role: "system", content: "fixture instructions" });
    assert.deepEqual(first!.body.tools, [{ type: "function", function: { name: "get_tempo", description: "The Set's tempo", parameters: { type: "object", properties: { precise: { type: "boolean" } } } } }]);
    assert.match(String(first!.headers["user-agent"]), /^kumi\//);
    const call = second!.body.messages.find((message: Json) => message.role === "assistant");
    assert.equal(call.thinking, "The tempo first.");
    assert.deepEqual(call.tool_calls[0].function, { name: "get_tempo", arguments: { precise: true } });
    assert.deepEqual(second!.body.messages.find((message: Json) => message.role === "tool"), { role: "tool", content: '{"tempo":120}', tool_name: "get_tempo", tool_call_id: call.tool_calls[0].id });
    assert.equal(second!.body.options.num_ctx, 32768, "the same context every request, so the model isn't loaded again");
  } finally { await fake.close(); }
});

test("Ollama: a full request gets a context big enough for Kumi's instructions and tools, up to what the model reads; one that can't fit them is told so", async () => {
  const fixed = fixedOf(INSTRUCTIONS, CATALOG);
  assert.ok(fixed > 80 * 1024 && fixed < 95 * 1024, `${fixed} bytes, as Kumi's request is`);
  const fake = await serve(ollama({ "big:latest": { capabilities: ["completion", "tools"], context: 131072 }, "short:latest": { capabilities: ["completion", "tools"], context: 8192 } }, () => [said("Ready."), done()]));
  try {
    const { binding } = await answer(ollamaAt(fake.url), "big:latest", { instructions: INSTRUCTIONS, tools: CATALOG });
    const asked = fake.seen.find((request) => request.url === "/api/chat")!.body.options.num_ctx as number;
    assert.equal(asked, contextFor(fixed));
    assert.equal(asked, 57344, "the request, about 16k tokens of conversation and an answer");
    const budget = binding.budget!(fixed);
    assert.ok(budget.limit >= 48 * 1024 && budget.limit < 64 * 1024 && budget.clearAt < budget.limit, "the conversation is kept to what fits beside them");
    const short = await failed(ollamaAt(fake.url), "short:latest", { instructions: INSTRUCTIONS, tools: CATALOG });
    assert.equal(short.kind, "model");
    const about = (Math.round(fixed / 4 / 1000) * 1000).toLocaleString("en-US");
    assert.equal(short.message, `short:latest reads at most 8,192 tokens at once, too few for Kumi's instructions and tools (about ${about}): choose a model that reads more with /model.`);
    assert.equal(fake.seen.filter((request) => request.url === "/api/chat").length, 1, "nothing is sent that can't fit");
  } finally { await fake.close(); }
});

test("Ollama: a model that can't use tools still talks, without them, and Kumi names one of Ollama's that can", async () => {
  const fake = await serve(ollama({ "gemma3:4b": { capabilities: ["completion", "vision"] }, "qwen3:8b": { capabilities: ["completion", "tools"], loaded: true } }, () => [said("Your Set has two tracks."), done()]));
  try {
    const { text, binding } = await answer(ollamaAt(fake.url), "gemma3:4b");
    assert.equal(text, "Your Set has two tracks.");
    assert.equal(binding.note, "gemma3:4b can't use tools, so Kumi can talk with it about your Set but can't change anything. qwen3:8b on Ollama can: /model chooses it.");
    const request = fake.seen.find((item) => item.url === "/api/chat")!.body;
    assert.equal(request.tools, undefined);
    assert.match(request.messages[0].content, /^fixture instructions\n\nThis model can't use tools here/);
    assert.equal(request.think, undefined, "a model that doesn't think isn't asked to");
  } finally { await fake.close(); }
  const alone = await serve(ollama({ "gemma3:4b": { capabilities: ["completion"] } }));
  try {
    const binding = resolveLocalModel(ollamaAt(alone.url), "gemma3:4b");
    await binding.asked;
    assert.match(binding.note ?? "", /None of Ollama's models can; pull one that can use tools, then choose it with \/model\.$/);
  } finally { await alone.close(); }
});

test("Ollama: the effort chosen goes as its thinking level, only where Ollama offers levels", async () => {
  const fake = await serve(ollama({ "gpt-oss:20b": { capabilities: ["completion", "tools", "thinking"], thinking: { values: ["low", "medium", "high"], default: "medium" } },
    "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], thinking: { values: [false, true], default: true } } }, () => [said("Ok."), done()]));
  try {
    await answer(ollamaAt(fake.url), "gpt-oss:20b", { effort: "high" });
    await answer(ollamaAt(fake.url), "gpt-oss:20b");
    await answer(ollamaAt(fake.url), "qwen3:8b", { effort: "high" });
    assert.deepEqual(fake.seen.filter((request) => request.url === "/api/chat").map((request) => request.body.think), ["high", "medium", true]);
  } finally { await fake.close(); }
});

test("Ollama's failures say what happened and what to do: not running, not pulled, out of memory, and stopping partway", async () => {
  const down = await failed(ollamaAt(await closedPort()), "qwen3:8b");
  assert.equal(down.kind, "network");
  assert.equal(down.message, "Ollama isn't running: open it, or run `ollama serve`, then send your message again.");
  assert.equal(down.provider, "ollama");
  const away = await failed(localServers([], { OLLAMA_HOST: "studio.invalid" })[0]!, "qwen3:8b");
  assert.equal(away.message, "Kumi can't reach Ollama at http://studio.invalid:11434: check that it's running on studio.invalid, then send your message again.");
  const fake = await serve(ollama({ "qwen3:8b": { capabilities: ["completion", "tools"] }, "qwen3:30b": { capabilities: ["completion", "tools"] }, "qwen3:14b": { capabilities: ["completion", "tools"] } }, (body) => {
    if (body.model === "qwen3:30b") return { status: 500, body: { error: "model requires more system memory (21.5 GiB) than is available (12.1 GiB)" } };
    if (body.model === "qwen3:14b") return [said("Half an answ"), { error: "llama runner process has terminated: exit status 2" }];
    return (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/x-ndjson" }); response.write(`${JSON.stringify(said("Let me"))}\n`); setTimeout(() => response.socket?.destroy(), 20); };
  }));
  try {
    const missing = await failed(ollamaAt(fake.url), "llama9:70b");
    assert.equal(missing.kind, "model");
    assert.equal(missing.message, "Ollama doesn't have llama9:70b: run `ollama pull llama9:70b`, or choose one you have with /model.");
    const memory = await failed(ollamaAt(fake.url), "qwen3:30b");
    assert.equal(memory.kind, "model");
    assert.match(memory.message, /^Ollama couldn't fit qwen3:30b in this computer's memory with the room Kumi needs \(32,768 tokens\): choose a smaller model with \/model, or close other apps and send your message again \(model requires more system memory \(21\.5 GiB\) than is available \(12\.1 GiB\)\)\.$/);
    const dropped = await failed(ollamaAt(fake.url), "qwen3:8b");
    assert.equal(dropped.kind, "network");
    assert.equal(dropped.message, "Ollama stopped answering partway (it may have quit, or run out of memory): if it closed, open it again, then send your message again.");
    const crashed = await failed(ollamaAt(fake.url), "qwen3:14b");
    assert.equal(crashed.message, "Ollama stopped answering partway (llama runner process has terminated: exit status 2): if it closed, open it again, then send your message again.");
  } finally { await fake.close(); }
});

/** LM Studio's REST API and its OpenAI-compatible chat, answering each chat with these SSE chunks. */
function lmStudio(models: Json[], chat: (body: Json, n: number) => Json[] = () => []) {
  let chats = 0;
  return (request: Seen, response: ServerResponse) => {
    if (request.url === "/v1/models") return send(response, { data: models.map((model) => ({ id: model.key, object: "model" })) });
    if (request.url === "/api/v1/models") return send(response, { models });
    if (request.url === "/api/v1/models/unload") { for (const model of models) model.loaded_instances = model.loaded_instances.filter((copy: Json) => copy.id !== request.body.instance_id); return send(response, { instance_id: request.body.instance_id }); }
    if (request.url === "/api/v1/models/load") {
      const model = models.find((item) => item.key === request.body.model)!;
      model.loaded_instances.push({ id: model.key, config: { context_length: request.body.context_length } });
      return send(response, { type: "llm", instance_id: model.key, status: "loaded", load_config: { context_length: request.body.context_length } });
    }
    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chat(request.body, ++chats)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write("data: [DONE]\n\n");
      return response.end();
    }
    send(response, { error: "Unexpected endpoint or method." }, 404);
  };
}
const lmModel = (key: string, extra: Json = {}) => ({ type: "llm", key, display_name: key.split("/").pop(), params_string: "8B", quantization: { name: "Q4_K_M" }, max_context_length: 131072,
  loaded_instances: [], capabilities: { vision: false, trained_for_tool_use: true }, ...extra });
const delta = (value: Json, finish?: string) => ({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: value, finish_reason: finish ?? null }] });

test("LM Studio: models come with what LM Studio says they can do, and one not loaded is loaded with the context Kumi needs", async () => {
  const models = [lmModel("qwen/qwen3-8b", { capabilities: { trained_for_tool_use: true, reasoning: { allowed_options: ["off", "low", "medium", "high"], default: "medium" } } }),
    lmModel("google/gemma-3-4b", { capabilities: { trained_for_tool_use: false } }), { type: "embedding", key: "text-embedding-nomic", loaded_instances: [] }];
  const fake = await serve(lmStudio(models, (_body, n) => (n === 1
    ? [delta({ role: "assistant", content: "" }), delta({ tool_calls: [{ index: 0, id: "call_7", type: "function", function: { name: "get_tempo", arguments: "{}" } }] }), delta({}, "tool_calls")]
    : [delta({ reasoning_content: "Tempo read." }), delta({ content: "120 BPM." }), delta({}, "stop")])));
  try {
    const server = lmStudioAt(fake.url);
    const listed = await listLocalModels(server);
    assert.deepEqual(listed.map((model) => [model.id, model.name, model.description, model.efforts.map((level) => level.effort).join(" ")]), [
      ["lmstudio/qwen/qwen3-8b", "qwen3-8b", "8B · Q4_K_M", "low medium high"], ["lmstudio/google/gemma-3-4b", "gemma-3-4b", "8B · Q4_K_M · can't change the Set", ""]]);
    const { text } = await answer(server, "qwen/qwen3-8b", { effort: "low" });
    assert.equal(text, "120 BPM.");
    const load = fake.seen.find((request) => request.url === "/api/v1/models/load")!;
    assert.deepEqual(load.body, { model: "qwen/qwen3-8b", context_length: 32768, echo_load_config: true });
    const chats = fake.seen.filter((request) => request.url === "/v1/chat/completions");
    assert.equal(chats.length, 2);
    assert.equal(chats[0]!.body.model, "qwen/qwen3-8b");
    assert.equal(chats[0]!.body.reasoning_effort, "low");
    assert.equal(chats[0]!.body.tools[0].function.name, "get_tempo");
    assert.equal(fake.seen.filter((request) => request.url === "/api/v1/models/load").length, 1, "loaded once, then used as it is");
  } finally { await fake.close(); }
});

test("LM Studio: a model loaded with too little room for Kumi is loaded again with enough, and Kumi says so", async () => {
  const models = [lmModel("qwen/qwen3-8b", { loaded_instances: [{ id: "qwen/qwen3-8b", config: { context_length: 4096 } }] })];
  const fake = await serve(lmStudio(models, () => [delta({ content: "Ok." }), delta({}, "stop")]));
  try {
    const notes: string[] = [];
    await answer(lmStudioAt(fake.url), "qwen/qwen3-8b", { notes });
    assert.deepEqual(fake.seen.filter((request) => request.url.startsWith("/api/v1/models/")).map((request) => [request.url, request.body.instance_id ?? request.body.context_length]),
      [["/api/v1/models/unload", "qwen/qwen3-8b"], ["/api/v1/models/load", 32768]]);
    assert.deepEqual(notes, ["LM Studio had qwen3-8b loaded with room for 4,096 tokens, too few for Kumi; Kumi loaded it again with room for 32,768."]);
  } finally { await fake.close(); }
});

test("an OpenAI-compatible server's quirks are mended: calls without ids, arguments as objects, thinking in <think> tags, no finish reason", async () => {
  const fake = await serve(async (request, response) => {
    if (request.url === "/v1/models") return send(response, { object: "list", data: [{ id: "qwen3-8b-q4.gguf", object: "model", owned_by: "llamacpp" }] });
    if (request.url === "/props") return send(response, { default_generation_settings: { n_ctx: 65536 } });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const n = request.body.messages.length;
    const chunks = n <= 2
      ? [delta({ role: "assistant", content: "<think>" }), delta({ content: "Tempo first.</th" }), delta({ content: "ink>\n\n" }),
        delta({ tool_calls: [{ index: 0, function: { name: "get_tempo", arguments: { precise: false } } }] })]
      : [delta({ content: "It's 120." })];
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  try {
    calls.length = 0;
    const [server] = localServers([{ name: "llama.cpp", baseURL: `${fake.url}/v1` }], {}).slice(2);
    const { text, binding } = await answer(server!, "qwen3-8b-q4.gguf");
    assert.equal(text, "It's 120.", "the thinking isn't shown as words");
    assert.deepEqual(calls, [{ precise: false }]);
    const second = fake.seen.filter((request) => request.url === "/v1/chat/completions")[1]!.body;
    const call = second.messages.find((message: Json) => message.role === "assistant");
    assert.match(call.tool_calls[0].id, /^call_[0-9a-f]{16}$/);
    assert.equal(call.reasoning_content, "Tempo first.");
    assert.equal(second.messages.find((message: Json) => message.role === "tool").tool_call_id, call.tool_calls[0].id);
    assert.equal(binding.budget!(1000).limit, (65536 - 8192) * 3 - 1000, "the conversation is kept to llama.cpp's own window, 64k tokens");
  } finally { await fake.close(); }
});

test("a server named in settings.json says plainly when it's down, needs --jinja, or its context is too small, and Kumi keeps to its window", async () => {
  const down = await failed(localServers([{ name: "llama.cpp", baseURL: await closedPort() }], {})[2]!, "model");
  assert.match(down.message, /^llama\.cpp isn't answering at http:\/\/127\.0\.0\.1:\d+\/v1: start it, then send your message again\.$/);
  let reply: Json = {};
  const fake = await serve((request, response) => {
    if (request.url === "/v1/models") return send(response, { data: [{ id: "local-model" }] });
    send(response, reply, 400);
  });
  try {
    const server = localServers([{ name: "llama.cpp", baseURL: fake.url }], {})[2]!;
    reply = { error: { code: 500, message: "tools param requires --jinja flag", type: "server_error" } };
    assert.equal((await failed(server, "local-model")).message, "llama.cpp needs --jinja to use tools: start it with --jinja, or choose another model with /model.");
    reply = { error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 8192 } };
    const small = await failed(server, "local-model", { instructions: INSTRUCTIONS, tools: CATALOG });
    assert.equal(small.kind, "model");
    const fixed = fixedOf(INSTRUCTIONS, CATALOG);
    const about = (Math.round(fixed / 4 / 1000) * 1000).toLocaleString("en-US");
    assert.equal(small.message, `llama.cpp gives local-model room for 8,192 tokens, too few for Kumi's instructions and tools (about ${about}): start it with a context of ${contextFor(fixed).toLocaleString("en-US")} tokens or more, or choose another model with /model.`);
    const binding = resolveLocalModel(server, "local-model");
    const kernel = createAgentKernel({ binding, instructions: "fixture instructions", signal: signal(), tools: [tempo] });
    reply = { error: { message: "the request exceeds the available context size, try increasing it", n_ctx: 16384 } };
    await assert.rejects(kernel.run("hi", signal(), () => {}), (error: unknown) => error instanceof KumiError && error.kind === "request" && /Kumi keeps it shorter from now on/.test(error.message));
    assert.ok(binding.budget!(1000).limit < 30 * 1024, "the window it reported is the one Kumi keeps to");
    await kernel.close();
  } finally { await fake.close(); }
});

test("thinking written into the words is split out only when the answer opens with it, wherever the tags fall", () => {
  const split = (chunks: string[]) => {
    const splitter = thinkSplitter(); let reasoning = ""; let text = "";
    for (const chunk of [...chunks.map((item) => splitter.push(item)), splitter.flush()]) { reasoning += chunk.reasoning; text += chunk.text; }
    return [reasoning, text];
  };
  assert.deepEqual(split(["<think>Hmm.</think>\n\nAnswer."]), ["Hmm.", "Answer."]);
  assert.deepEqual(split(["  <th", "ink>Hm", "m.</thi", "nk>", "\n", "Answer."]), ["Hmm.", "Answer."]);
  assert.deepEqual(split(["Use <think> tags like this."]), ["", "Use <think> tags like this."]);
  assert.deepEqual(split(["<b>Bold</b>"]), ["", "<b>Bold</b>"]);
  assert.deepEqual(split(["<think>Still thinking"]), ["Still thinking", ""], "an answer cut off mid-thought");
});

test("a mended stream gives each call one id, its arguments as text, and a finish, without touching a stream that needs none", async () => {
  const mend = async (events: string) => {
    const body = new Response(events).body!;
    return (await new Response(mendStream(body)).text()).split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)) as Json);
  };
  const chunks = await mend([
    delta({ tool_calls: [{ index: 0, id: "", function: { name: "get_tempo", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "{\"precise\":" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "true}" } }] }),
    delta({ tool_calls: [{ function: { name: "play", arguments: {} } }] }),
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
  const ids = chunks.slice(0, 3).map((chunk) => chunk.choices[0].delta.tool_calls[0].id);
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^call_/);
  const second = chunks[3]!.choices[0].delta.tool_calls[0];
  assert.equal(second.index, 1);
  assert.notEqual(second.id, ids[0]);
  assert.equal(second.function.arguments, "{}");
  assert.equal(chunks.at(-1)!.choices[0].finish_reason, "tool_calls");
  const plain = [delta({ content: "Hi." }), delta({}, "stop")].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  assert.deepEqual(await mend(plain), [delta({ content: "Hi." }), delta({}, "stop")]);
});

test("a server that wants a key says where Kumi's key for it goes", async () => {
  const fake = await serve((_request, response) => send(response, { error: { message: "Unauthorized" } }, 401));
  try {
    const custom = localServers([{ name: "Studio PC", baseURL: fake.url }], {})[2]!;
    assert.equal(await probeLocal(custom), true, "it's running, it just wants a key");
    await assert.rejects(listLocalModels(custom), (error: unknown) => error instanceof KumiError && error.kind === "auth"
      && error.message === "Studio PC didn't accept a request without a key (HTTP 401): set its apiKey in ~/.kumi/settings.json.");
    await assert.rejects(listLocalModels(lmStudioAt(fake.url)), (error: unknown) => error instanceof KumiError
      && error.message === "LM Studio didn't accept a request without a key (HTTP 401): set LM_API_TOKEN to a token from LM Studio's server settings.");
  } finally { await fake.close(); }
});
