import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { KernelEvent, KernelTool } from "../src/core/contracts.js";
import { KumiError } from "../src/core/errors.js";
import { createAgentKernel, type AgentKernelOptions, type ModelBinding } from "../src/kernel/agent.js";

type Script = (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart> | Promise<never>;
const usage = (input = 3, output = 2) => ({
  inputTokens: { total: input, noCache: input - 1, cacheRead: 1, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 },
});
const finish = (unified: "stop" | "tool-calls" | "error" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", usage: usage(), finishReason: { unified, raw: unified } });
const text = (value: string, id = "t1"): LanguageModelV4StreamPart[] => [
  { type: "text-start", id }, { type: "text-delta", id, delta: value }, { type: "text-end", id },
];
const call = (name: string, input: string, id = "c1"): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId: id, toolName: name, input });

function harness(script: Script, options: Partial<AgentKernelOptions> = {}) {
  const requests: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: "v4", provider: "test", modelId: "fixture", supportedUrls: {},
    doGenerate: () => { throw new Error("not used"); },
    async doStream(callOptions) {
      const { abortSignal: _signal, ...recorded } = callOptions;
      requests.push(structuredClone(recorded));
      const parts = await script(callOptions, requests.length);
      return { stream: parts instanceof ReadableStream ? parts : new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
    },
  };
  const binding: ModelBinding = { id: "test/fixture", model, prepare: (request) => ({ prompt: request.messages, ...(request.tools.length ? { tools: request.tools } : {}) }) };
  const kernel = createAgentKernel({ binding, instructions: "fixture instructions", tools: [], signal: new AbortController().signal, ...options });
  return { kernel, requests };
}
function collect() {
  const events: KernelEvent[] = [];
  return { events, emit: (event: KernelEvent) => events.push(event) };
}
/** A stream that emits some parts, then waits until the call's abort signal fires. */
function hanging(options: LanguageModelV4CallOptions, parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      options.abortSignal?.addEventListener("abort", () => controller.error(options.abortSignal!.reason), { once: true });
    },
  });
}
const tool = (name: string, execute: KernelTool["execute"]): KernelTool =>
  ({ name, description: `${name} fixture`, inputSchema: { type: "object", properties: {} }, execute });

test("streams text, reports summed usage, and settles the turn into history", async () => {
  const h = harness(() => [...text("hel"), { type: "text-delta", id: "t1", delta: "lo" }, finish()]);
  const { events, emit } = collect();
  const result = await h.kernel.run("hi", new AbortController().signal, emit);
  assert.deepEqual(events, [{ type: "text", text: "hel" }, { type: "text", text: "lo" }]);
  assert.deepEqual(result, { stopReason: "completed", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } });
  assert.deepEqual(h.kernel.checkpoint().messages, [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
  await h.kernel.close();
});

test("runs tool calls between model steps and feeds results back", async () => {
  const seen: unknown[] = [];
  const h = harness((_options, n) => n === 1 ? [call("lookup", '{"key":"tempo"}'), finish("tool-calls")] : [...text("120 BPM"), finish()], {
    tools: [tool("lookup", async (input) => { seen.push(input); return { text: '{"tempo":120}' }; })],
  });
  const { events, emit } = collect();
  const result = await h.kernel.run("tempo?", new AbortController().signal, emit);
  assert.deepEqual(seen, [{ key: "tempo" }]);
  assert.deepEqual(events.map((event) => event.type), ["tool-start", "tool-end", "text"]);
  assert.equal(result.usage?.inputTokens, 6);
  assert.equal(h.requests[0]?.tools?.[0]?.name, "lookup");
  assert.deepEqual(h.requests[1]?.prompt.slice(1), [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { key: "tempo" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "text", value: '{"tempo":120}' } }] },
  ]);
  await h.kernel.close();
});

test("replays provider metadata (encrypted reasoning, signatures, item ids) verbatim on the next request", async () => {
  const h = harness((_options, n) => n > 1 ? [...text("second"), finish()] : [
    { type: "reasoning-start", id: "r1", providerMetadata: { openai: { itemId: "rs_1" } } },
    { type: "reasoning-delta", id: "r1", delta: "", providerMetadata: { anthropic: { signature: "sig" } } },
    { type: "reasoning-end", id: "r1", providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } } },
    { type: "text-start", id: "m1", providerMetadata: { openai: { itemId: "msg_1" } } },
    { type: "text-delta", id: "m1", delta: "first" }, { type: "text-end", id: "m1" },
    { type: "reasoning-start", id: "empty" }, { type: "reasoning-end", id: "empty" },
    finish(),
  ]);
  await h.kernel.run("one", new AbortController().signal, () => {});
  await h.kernel.run("two", new AbortController().signal, () => {});
  assert.deepEqual(h.requests[1]?.prompt[1], { role: "assistant", content: [
    { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" }, anthropic: { signature: "sig" } } },
    { type: "text", text: "first", providerOptions: { openai: { itemId: "msg_1" } } },
  ] });
  await h.kernel.close();
});

test("cancellation mid-stream returns promptly, discards the turn, and the next turn recovers", async () => {
  const h = harness((options, n) => n === 1 ? hanging(options, text("partial").slice(0, 2)) : [...text("recovered"), finish()]);
  const controller = new AbortController();
  const running = h.kernel.run("long", controller.signal, (event) => { if (event.type === "text") controller.abort(); });
  const started = performance.now();
  assert.equal((await running).stopReason, "cancelled");
  assert(performance.now() - started < 1_000);
  assert.deepEqual(h.kernel.checkpoint().messages, []);
  const { events, emit } = collect();
  assert.equal((await h.kernel.run("again", new AbortController().signal, emit)).stopReason, "completed");
  assert.deepEqual(events, [{ type: "text", text: "recovered" }]);
  assert.equal(h.requests[1]?.prompt.length, 1, "cancelled turn must not be replayed");
  await h.kernel.close();
});

test("cancellation during an uncooperative tool settles without waiting for it; late results are ignored", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(() => [call("slow", "{}"), finish("tool-calls")], {
    tools: [tool("slow", async () => { await held; return { text: "late" }; })],
  });
  const controller = new AbortController();
  const events: KernelEvent[] = [];
  const running = h.kernel.run("go", controller.signal, (event) => { events.push(event); if (event.type === "tool-start") controller.abort(); });
  const result = await running;
  release(); await delay(5);
  assert.equal(result.stopReason, "cancelled");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 }, "usage reported before cancellation is kept");
  assert.deepEqual(events.map((event) => event.type), ["tool-start"]);
  assert.deepEqual(h.kernel.checkpoint().messages, []);
  await h.kernel.close();
});

test("an already-aborted turn makes no request; concurrent turns are rejected; close is idempotent and aborts work", async () => {
  const h = harness((options) => hanging(options, []));
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await h.kernel.run("never", aborted.signal, () => {}), { stopReason: "cancelled" });
  assert.equal(h.requests.length, 0);
  const running = h.kernel.run("hold", new AbortController().signal, () => {});
  await delay(5);
  await assert.rejects(h.kernel.run("second", new AbortController().signal, () => {}), /busy/);
  assert.throws(() => h.kernel.checkpoint(), /busy/);
  const closing = h.kernel.close();
  assert.equal(h.kernel.close(), closing);
  await closing;
  assert.equal((await running).stopReason, "cancelled");
  await assert.rejects(h.kernel.run("after", new AbortController().signal, () => {}), /closed/);
});

test("incomplete, errored and filtered responses fail instead of completing empty", async () => {
  for (const parts of [
    text("no finish"),
    [...text("x"), { type: "error", error: new Error("Bearer secret-token") }] as LanguageModelV4StreamPart[],
    [finish("error")],
    [{ type: "finish", usage: usage(), finishReason: { unified: "content-filter", raw: "x" } }] as LanguageModelV4StreamPart[],
  ]) {
    const h = harness(() => parts);
    await assert.rejects(h.kernel.run("q", new AbortController().signal, () => {}), (error: unknown) => {
      assert(error instanceof KumiError); assert(!error.message.includes("secret-token")); return true;
    });
    assert.deepEqual(h.kernel.checkpoint().messages, []);
    await h.kernel.close();
  }
});

test("provider HTTP failures become Kumi-written messages without credentials or bodies", async () => {
  const failure = (statusCode: number, responseBody = "") => new APICallError({
    message: statusCode === 400 ? "Unsupported parameter: max_output_tokens" : "Bearer leaked-token", url: "https://example.invalid",
    requestBodyValues: { authorization: "Bearer leaked-token" }, statusCode, responseBody, isRetryable: false,
  });
  for (const [status, pattern] of [[401, /rejected the credentials/], [429, /limit/], [404, /rejected the request \(HTTP 404\)/], [400, /max_output_tokens/]] as const) {
    const h = harness(() => Promise.reject(failure(status)));
    await assert.rejects(h.kernel.run("q", new AbortController().signal, () => {}), (error: unknown) => {
      assert(error instanceof KumiError); assert.match(error.message, pattern); assert(!error.message.includes("leaked-token"));
      return true;
    });
    await h.kernel.close();
  }
});

test("retries once before any output escapes, but never after text was delivered", async () => {
  const unavailable = () => new APICallError({ message: "down", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true, responseHeaders: { "retry-after-ms": "1" } });
  const retried = harness((_options, n) => n === 1 ? Promise.reject(unavailable()) : [...text("ok"), finish()]);
  assert.equal((await retried.kernel.run("q", new AbortController().signal, () => {})).stopReason, "completed");
  assert.equal(retried.requests.length, 2);
  const streamed = harness(() => [...text("partial"), { type: "error", error: unavailable() }]);
  await assert.rejects(streamed.kernel.run("q", new AbortController().signal, () => {}), /unavailable \(HTTP 503\)/);
  assert.equal(streamed.requests.length, 1);
  await retried.kernel.close(); await streamed.kernel.close();
});

test("a throwing listener discards the turn without poisoning the next one", async () => {
  const h = harness(() => [...text("x"), finish()]);
  await assert.rejects(h.kernel.run("q", new AbortController().signal, () => { throw new Error("listener state"); }), /could not be delivered/);
  assert.deepEqual(h.kernel.checkpoint().messages, []);
  assert.equal((await h.kernel.run("q", new AbortController().signal, () => {})).stopReason, "completed");
  await h.kernel.close();
});

test("unknown tools and malformed arguments return errors to the model without executing anything", async () => {
  let executed = 0;
  const h = harness((_options, n) => n === 1 ? [call("missing", "{}", "a"), call("lookup", "[1]", "b"), call("lookup", "{bad", "c"), finish("tool-calls")] : [...text("done"), finish()], {
    tools: [tool("lookup", async () => { executed++; return { text: "never" }; })],
  });
  const { events, emit } = collect();
  await h.kernel.run("q", new AbortController().signal, emit);
  assert.equal(executed, 0);
  assert.deepEqual(events.filter((event) => event.type === "tool-end").map((event) => event.type === "tool-end" && event.isError), [true, true, true]);
  const results = h.requests[1]?.prompt[2];
  assert(results?.role === "tool");
  assert.deepEqual(results.content.map((part) => part.type === "tool-result" && part.output.type), ["error-text", "error-text", "error-text"]);
  await h.kernel.close();
});

test("tool failures are reported to the model as errors and the turn continues", async () => {
  const h = harness((_options, n) => n === 1 ? [call("flaky", "{}"), finish("tool-calls")] : [...text("recovered"), finish()], {
    tools: [tool("flaky", async () => { throw new Error("Live read failed"); })],
  });
  assert.equal((await h.kernel.run("q", new AbortController().signal, () => {})).stopReason, "completed");
  const results = h.requests[1]?.prompt[2];
  assert.deepEqual(results?.role === "tool" && results.content[0], { type: "tool-result", toolCallId: "c1", toolName: "flaky", output: { type: "error-text", value: "Live read failed" } });
  await h.kernel.close();
});

test("stops at the step bound when the model keeps calling tools", async () => {
  const h = harness(() => [call("again", "{}"), finish("tool-calls")], { maxSteps: 3, tools: [tool("again", async () => ({ text: "ok" }))] });
  const result = await h.kernel.run("loop", new AbortController().signal, () => {});
  assert.equal(result.stopReason, "max-steps");
  assert.equal(h.requests.length, 3);
  await h.kernel.close();
});

test("steering enters at the next model boundary, even after a final answer", async () => {
  let kernelRef: ReturnType<typeof harness>["kernel"] | undefined;
  const h = harness((_options, n) => n === 1 ? [call("look", "{}"), finish("tool-calls")] : n === 2 ? [...text("first"), finish()] : [...text("steered"), finish()], {
    tools: [tool("look", async () => { assert.equal(kernelRef!.steer("make it darker"), true); return { text: "ok" }; })],
  });
  kernelRef = h.kernel;
  assert.equal(h.kernel.steer("idle"), false);
  const events: KernelEvent[] = [];
  await h.kernel.run("build a pad", new AbortController().signal, (event) => {
    events.push(event);
    if (event.type === "text" && event.text === "first") assert.equal(h.kernel.steer("and shorter"), true);
  });
  assert.deepEqual(events.filter((event) => event.type === "steer").map((event) => event.type === "steer" && event.text), ["make it darker", "and shorter"]);
  assert.deepEqual(h.requests[1]?.prompt.at(-1), { role: "user", content: [{ type: "text", text: "make it darker" }] }, "applied before step 2");
  assert.deepEqual(h.requests[2]?.prompt.at(-1), { role: "user", content: [{ type: "text", text: "and shorter" }] }, "a final answer continues");
  assert.equal(h.requests.length, 3);
  await h.kernel.close();
});

test("a checkpoint restores settled history into a fresh kernel", async () => {
  const first = harness(() => [...text("remembered"), finish()]);
  await first.kernel.run("marker-123", new AbortController().signal, () => {});
  const checkpoint = JSON.parse(JSON.stringify(first.kernel.checkpoint()));
  const second = harness(() => [...text("ok"), finish()], { checkpoint });
  await second.kernel.run("what marker?", new AbortController().signal, () => {});
  assert.deepEqual(second.requests[0]?.prompt.slice(0, 2), checkpoint.messages);
  assert.throws(() => harness(() => [], { checkpoint: { version: 2, messages: [] } as never }), /checkpoint/);
  await first.kernel.close(); await second.kernel.close();
});

test("rejects empty instructions and invalid or duplicate tool names", () => {
  const noop = async () => ({ text: "" });
  assert.throws(() => harness(() => [], { instructions: " " }), /instructions/);
  for (const tools of [[tool("bad name", noop)], [tool("dup", noop), tool("dup", noop)], [tool("x".repeat(65), noop)]]) {
    assert.throws(() => harness(() => [], { tools }), /Tool names/);
  }
});
