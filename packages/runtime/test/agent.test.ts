import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { KernelEvent, KernelTool } from "../src/core/contracts.js";
import { KumiError } from "../src/core/errors.js";
import { createAgentKernel, plainWords, STOPPED_NOTE, type AgentKernelOptions, type ModelBinding } from "../src/kernel/agent.js";

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
  // Each says what went wrong, and its kind and provider let the app offer the fix.
  for (const [status, kind, pattern] of [
    [401, "auth", /test didn't accept Kumi's sign-in \(HTTP 401\): sign in again/], [403, "auth", /can't use fixture \(HTTP 403\)/],
    [402, "billing", /billing/], [404, "model", /doesn't offer fixture to this sign-in \(HTTP 404\); choose another model/],
    [429, "rate-limit", /limit/], [529, "provider", /overloaded/], [400, "request", /turned the request down \(HTTP 400\): Unsupported parameter: max_output_tokens/],
  ] as const) {
    const h = harness(() => Promise.reject(failure(status)));
    await assert.rejects(h.kernel.run("q", new AbortController().signal, () => {}), (error: unknown) => {
      assert(error instanceof KumiError); assert.match(error.message, pattern); assert(!error.message.includes("leaked-token"));
      assert.equal(error.kind, kind); assert.equal(error.provider, "test");
      return true;
    });
    await h.kernel.close();
  }
});

test("retries up to three times before any output escapes, but never after text was delivered", async () => {
  const unavailable = () => new APICallError({ message: "down", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true, responseHeaders: { "retry-after-ms": "1" } });
  const retried = harness((_options, n) => n <= 3 ? Promise.reject(unavailable()) : [...text("ok"), finish()]);
  assert.equal((await retried.kernel.run("q", new AbortController().signal, () => {})).stopReason, "completed");
  assert.equal(retried.requests.length, 4);
  const gaveUp = harness(() => Promise.reject(unavailable()));
  await assert.rejects(gaveUp.kernel.run("q", new AbortController().signal, () => {}), /overloaded right now/);
  assert.equal(gaveUp.requests.length, 4, "the first try and three more");
  await gaveUp.kernel.close();
  const streamed = harness(() => [...text("partial"), { type: "error", error: unavailable() }]);
  await assert.rejects(streamed.kernel.run("q", new AbortController().signal, () => {}), /overloaded right now \(HTTP 503\)/);
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

test("a tool that finished the request answers for the model: the turn ends with its reply and no further model call", async () => {
  const h = harness(() => [...text("On it."), call("plan", "{}"), finish("tool-calls")], {
    tools: [tool("plan", async () => ({ text: '{"done":[1]}', reply: "Done: Tempo 120 → 124 BPM." }))],
  });
  const { events, emit } = collect();
  assert.equal((await h.kernel.run("faster", new AbortController().signal, emit)).stopReason, "completed");
  assert.equal(h.requests.length, 1, "no model call to write the answer");
  assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.type === "text" && event.text), ["On it.", "\n\nDone: Tempo 120 → 124 BPM."]);
  assert.deepEqual(h.kernel.checkpoint().messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Done: Tempo 120 → 124 BPM." }] }, "the reply is the answer the next turn sees");
  await h.kernel.close();
});

test("a reply doesn't end the turn when another call in the step failed, or guidance is waiting", async () => {
  const failing = harness((_options, n) => n === 1 ? [call("plan", "{}", "c1"), call("read", "{}", "c2"), finish("tool-calls")] : [...text("fixed"), finish()], {
    tools: [tool("plan", async () => ({ text: "ok", reply: "Done." })), tool("read", async () => ({ text: "gone", isError: true }))],
  });
  await failing.kernel.run("q", new AbortController().signal, () => {});
  assert.equal(failing.requests.length, 2, "the model sees the failure");
  await failing.kernel.close();
  let kernelRef: ReturnType<typeof harness>["kernel"] | undefined;
  const steered = harness((_options, n) => n === 1 ? [call("plan", "{}"), finish("tool-calls")] : [...text("darker too"), finish()], {
    tools: [tool("plan", async () => { kernelRef!.steer("make it darker"); return { text: "ok", reply: "Done." }; })],
  });
  kernelRef = steered.kernel;
  const { events, emit } = collect();
  await steered.kernel.run("q", new AbortController().signal, emit);
  assert.equal(steered.requests.length, 2, "the model hears the guidance");
  assert.ok(!events.some((event) => event.type === "text" && event.text.includes("Done.")));
  await steered.kernel.close();
});

test("stops at the step bound when the model keeps calling tools", async () => {
  const h = harness(() => [call("again", "{}"), finish("tool-calls")], { maxSteps: 3, tools: [tool("again", async () => ({ text: "ok" }))] });
  const result = await h.kernel.run("loop", new AbortController().signal, () => {});
  assert.equal(result.stopReason, "max-steps");
  assert.equal(h.requests.length, 3);
  await h.kernel.close();
});

test("a side question sees the conversation and the turn so far, calls no tools, and leaves no trace", async () => {
  let kernelRef: ReturnType<typeof harness>["kernel"] | undefined;
  const heard: string[] = [];
  let answer: string | undefined;
  const h = harness((_options, n) => {
    if (n === 1) return [...text("fine"), finish()];
    if (n === 2) return [call("look", "{}"), finish("tool-calls")];
    if (n === 3) return [...text("About 2.4 s."), finish()];
    return [...text("done"), finish()];
  }, { tools: [tool("look", async () => { answer = await kernelRef!.aside("how long is the tail?", new AbortController().signal, (words) => heard.push(words)); return { text: "looked" }; })] });
  kernelRef = h.kernel;
  await h.kernel.run("one", new AbortController().signal, () => {});
  await h.kernel.run("two", new AbortController().signal, () => {});
  assert.equal(answer, "About 2.4 s.");
  assert.deepEqual(heard, ["About 2.4 s."]);
  const aside = h.requests[2]!;
  assert.equal(aside.tools, undefined, "no tools offered");
  const said = aside.prompt.map((message) => `${message.role}: ${JSON.stringify(message.content)}`);
  assert.equal(said.length, 4, "the conversation, the turn under way without its call still running, and the question");
  assert.match(said[2]!, /^user: .*two/); assert.match(said[3]!, /^user: .*side question[\s\S]*how long is the tail\?/);
  assert.ok(aside.prompt.every((message) => (message.content as { type: string }[]).every((part) => part.type === "text")), "words only");
  assert.doesNotMatch(JSON.stringify(h.kernel.checkpoint()), /tail/, "never kept");
  await h.kernel.close();
});

test("a side question's copy of the conversation writes calls and results out as words", () => {
  const words = plainWords([
    { role: "user", content: [{ type: "text", text: "tempo?" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Looking." }, { type: "tool-call", toolCallId: "c1", toolName: "look", input: { what: "tempo" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "look", output: { type: "text", value: '{"tempo":124}' } }] },
    { role: "assistant", content: [{ type: "text", text: "124 BPM." }] },
  ]);
  assert.deepEqual(words.map((message) => [message.role, (message.content as { text: string }[])[0]!.text]), [
    ["user", "tempo?"], ["assistant", 'Looking.\n[called look {"what":"tempo"}]'], ["user", '[look returned: {"tempo":124}]'], ["assistant", "124 BPM."]]);
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

test("a checkpoint says which model wrote it, with which tools; another model or other tools continue from a portable copy", async () => {
  const thinking: LanguageModelV4StreamPart[] = [
    { type: "reasoning-start", id: "r1", providerMetadata: { test: { replay: "provider-only" } } }, { type: "reasoning-delta", id: "r1", delta: "thinking" }, { type: "reasoning-end", id: "r1" },
  ];
  const first = harness(() => [...thinking, ...text("Try a shorter release."), finish()]);
  await first.kernel.run("How do I tame the snare?\n\n<current_observation_untrusted>\n{\"tempo\":120}\n</current_observation_untrusted>", new AbortController().signal, () => {});
  const checkpoint = first.kernel.checkpoint();
  assert.equal(checkpoint.origin, "test/fixture");
  assert.match(checkpoint.tools ?? "", /^[\w-]{22}$/);
  assert.deepEqual(first.kernel.transcript(), [{ role: "user", text: "How do I tame the snare?" }, { role: "assistant", text: "Try a shorter release." }], "the producer's words, without the host's observation");
  const replay = async (changes: object, options: Parameters<typeof harness>[1] = {}) => {
    const next = harness(() => [...text("ok"), finish()], { ...options, checkpoint: { ...JSON.parse(JSON.stringify(checkpoint)), ...changes } });
    await next.kernel.run("next", new AbortController().signal, () => {});
    await next.kernel.close();
    return JSON.stringify(next.requests[0]!.prompt[1]);
  };
  assert.match(await replay({}), /provider-only/, "the same model with the same tools replays everything");
  assert.match(await replay({ origin: "test" }), /provider-only/, "an older save names only the provider");
  for (const [changes, options, why] of [
    [{ origin: "elsewhere/model" }, {}, "another provider"], [{ origin: "test/other-model" }, {}, "another model"],
    [{}, { tools: [tool("lookup", async () => ({ text: "x" }))] }, "other tools"],
  ] as const) {
    const replayed = await replay(changes, options);
    assert.doesNotMatch(replayed, /provider-only|reasoning/, why); assert.match(replayed, /Try a shorter release/, why);
  }
  await first.kernel.close();
});

test("when the budget clears earlier turns, their reasoning goes too, so a model that checks its history never sees it edited", async () => {
  const big = JSON.stringify({ items: "x".repeat(3000) });
  const thinking: LanguageModelV4StreamPart[] = [
    { type: "reasoning-start", id: "r1", providerMetadata: { anthropic: { signature: "sig-1" } } }, { type: "reasoning-delta", id: "r1", delta: "hmm" }, { type: "reasoning-end", id: "r1" },
  ];
  const h = harness((_options, n) => n % 2 === 1 ? [...thinking, call("read", "{}", `c${n}`), finish("tool-calls")] : [...text(`answer ${n / 2}`), finish()], {
    tools: [tool("read", async () => ({ text: big }))], budget: { clearAt: 4096, limit: 64 * 1024 },
  });
  const observed = (words: string) => `${words}\n\n<current_observation_untrusted>\n{"tempo":120}\n</current_observation_untrusted>`;
  await h.kernel.run(observed("one"), new AbortController().signal, () => {});
  await h.kernel.run(observed("two"), new AbortController().signal, () => {});
  assert.match(JSON.stringify(h.requests[2]!.prompt), /sig-1/, "under the budget, reasoning is replayed as it was");
  await h.kernel.run(observed("three"), new AbortController().signal, () => {});
  const cleared = JSON.stringify(h.requests[4]!.prompt);
  assert.match(cleared, /Kumi cleared the rest/);
  assert.doesNotMatch(cleared, /sig-1|"reasoning"/);
  assert.doesNotMatch(JSON.stringify(h.kernel.checkpoint().messages.slice(0, 4)), /sig-1/, "and stays gone from the saved conversation");
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

test("long conversations stay in budget: earlier reads are cleared in requests and the checkpoint, and the transcript keeps every word", async () => {
  const big = JSON.stringify({ items: "x".repeat(3000) });
  // Each turn reads once, then answers.
  const h = harness((_options, n) => n % 2 === 1 ? [call("read", "{}", `c${n}`), finish("tool-calls")] : [...text(`answer ${n / 2}`), finish()], {
    tools: [tool("read", async () => ({ text: big }))], budget: { clearAt: 4096, limit: 64 * 1024 },
  });
  const observed = (words: string) => `${words}\n\n<current_observation_untrusted>\n{"tempo":120}\n</current_observation_untrusted>`;
  for (const words of ["one", "two", "three"]) await h.kernel.run(observed(words), new AbortController().signal, () => {});
  const output = (message: unknown) => JSON.stringify(message);
  // The third turn's first request: turn one cleared, turn two whole.
  const prompt = h.requests[4]!.prompt;
  assert.deepEqual(prompt[0], { role: "user", content: [{ type: "text", text: "one" }] });
  assert.match(output(prompt[2]), /Kumi cleared the rest of this earlier result/);
  assert.equal(output(prompt[6]), output({ role: "tool", content: [{ type: "tool-result", toolCallId: "c3", toolName: "read", output: { type: "text", value: big } }] }));
  assert.match(output(prompt[4]), /current_observation_untrusted/);
  assert.match(output(h.kernel.checkpoint().messages[2]), /Kumi cleared the rest/);
  assert.deepEqual(h.kernel.transcript().filter((line) => line.text).map((line) => line.text), ["one", "answer 1", "two", "answer 2", "three", "answer 3"]);
  assert.deepEqual(h.kernel.transcript().flatMap((line) => line.tools ?? []), ["read", "read", "read"], "each answer's steps come back with it");
  await h.kernel.close();
});

test("a stopped turn keeps the steps it finished, with a note; the step in progress, and a turn that finished none, leave no trace", async () => {
  let mode: "answer" | "fail" | "hang" | "hang-first" = "answer"; let step = 0;
  const h = harness((options) => {
    if (mode === "answer") return [...text("fine"), finish()];
    if (mode === "hang-first") return hanging(options, []);
    if (++step % 2 === 1) return [call("read", "{}", `r${step}`), finish("tool-calls")];
    return mode === "fail" ? Promise.reject(new Error("provider down")) : hanging(options, []);
  }, { tools: [tool("read", async () => ({ text: '{"tempo":120}' }))] });
  await h.kernel.run("one", new AbortController().signal, () => {});
  mode = "fail";
  await assert.rejects(h.kernel.run("two", new AbortController().signal, () => {}));
  assert.deepEqual(h.kernel.transcript().filter((line) => line.text).map((line) => line.text), ["one", "fine", "two", STOPPED_NOTE]);
  assert.deepEqual(h.kernel.checkpoint().messages.slice(3).map((message) => (message as { role: string }).role), ["assistant", "tool", "assistant"], "the read and its result stay; the failed step goes");
  mode = "hang";
  const controller = new AbortController();
  const stopped = h.kernel.run("three", controller.signal, () => {});
  await delay(20); controller.abort();
  assert.equal((await stopped).stopReason, "cancelled");
  assert.deepEqual(h.kernel.transcript().filter((line) => line.text).map((line) => line.text).slice(-2), ["three", STOPPED_NOTE]);
  const settled = h.kernel.checkpoint().messages;
  mode = "hang-first";
  const early = new AbortController();
  const nothing = h.kernel.run("four", early.signal, () => {});
  await delay(20); early.abort();
  assert.equal((await nothing).stopReason, "cancelled");
  assert.deepEqual(h.kernel.checkpoint().messages, settled, "no finished step, no trace");
  await h.kernel.close();
});

test("a turn stopped during a tool keeps what finished before it, never a call without its result", async () => {
  let calls = 0;
  const h = harness(() => (++calls === 1 ? [call("read", "{}", "r1"), finish("tool-calls")] : [call("slow", "{}", "s1"), finish("tool-calls")]), {
    tools: [tool("read", async () => ({ text: "ok" })), tool("slow", () => new Promise<never>(() => {}))],
  });
  const controller = new AbortController();
  const stopped = h.kernel.run("go", controller.signal, () => {});
  await delay(20); controller.abort();
  assert.equal((await stopped).stopReason, "cancelled");
  const messages = h.kernel.checkpoint().messages as { role: string }[];
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.doesNotMatch(JSON.stringify(messages), /"s1"/, "the slow call, which has no result, is gone");
  await h.kernel.close();
});

test("when a stopped turn's steps are kept, so is the budget's trimming for them, with its note", async () => {
  let mode: "answer" | "fail" = "answer"; let step = 0;
  const big = "x".repeat(9_000);
  const h = harness(() => {
    if (mode === "answer") return [...text("fine"), finish()];
    return ++step === 1 ? [call("read", "{}", "big"), finish("tool-calls")] : Promise.reject(new Error("provider down"));
  }, { tools: [tool("read", async () => ({ text: big }))], budget: { clearAt: 1024, limit: 8192 } });
  for (const words of ["one", "two", "three"]) await h.kernel.run(`${words} ${"w".repeat(600)}`, new AbortController().signal, () => {});
  mode = "fail";
  await assert.rejects(h.kernel.run("four", new AbortController().signal, () => {}));
  assert.match(JSON.stringify(h.kernel.checkpoint().messages[0]), /Kumi removed the earlier part/, "the model is told the start is gone");
  assert.deepEqual(h.kernel.transcript().filter((line) => line.text).map((line) => line.text), ["four", STOPPED_NOTE]);
  await h.kernel.close();
});

test("when the earliest exchanges go, the model is told and the transcript isn't", async () => {
  const h = harness(() => [...text("w".repeat(1500)), finish()], { budget: { clearAt: 1024, limit: 4096 } });
  for (const words of ["one", "two", "three", "four"]) await h.kernel.run(`${words} ${"w".repeat(1500)}`, new AbortController().signal, () => {});
  assert.match(JSON.stringify(h.requests.at(-1)!.prompt[0]), /Kumi removed the earlier part of this conversation/);
  const lines = h.kernel.transcript();
  assert.ok(lines.length < 8);
  assert.ok(lines.every((line) => !line.text.includes("Kumi removed")));
  assert.match(lines[0]!.text, /^(two|three|four) /);
  await h.kernel.close();
});

test("rejects empty instructions, invalid or duplicate tool names, and a budget that can't hold anything", () => {
  const noop = async () => ({ text: "" });
  assert.throws(() => harness(() => [], { instructions: " " }), /instructions/);
  for (const tools of [[tool("bad name", noop)], [tool("dup", noop), tool("dup", noop)], [tool("x".repeat(65), noop)]]) {
    assert.throws(() => harness(() => [], { tools }), /Tool names/);
  }
  for (const budget of [{ clearAt: 100, limit: 4096 }, { clearAt: 4096, limit: 2048 }, { clearAt: Number.NaN, limit: 4096 }]) {
    assert.throws(() => harness(() => [], { budget }), /context budget/);
  }
});

/** A tool whose calls can start while they're written: work begins once a whole step ("}") has arrived. */
function streamingTool() {
  const calls: { pushes: string[]; finished?: unknown; abandoned: boolean }[] = [];
  let executed = 0;
  const planTool: KernelTool = {
    ...tool("plan", async () => { executed++; return { text: "never" }; }),
    stream(_signal, onStart) {
      const record: (typeof calls)[number] = { pushes: [], abandoned: false };
      calls.push(record);
      let started = false;
      return {
        get started() { return started; },
        push(delta) { record.pushes.push(delta); if (!started && record.pushes.join("").includes("}")) { started = true; onStart(); } },
        async finish(input) { record.finished = input; return { text: "planned", reply: "Done: Tempo 120 → 126 BPM." }; },
        async abandon() { record.abandoned = true; },
      };
    },
  };
  return { planTool, calls, get executed() { return executed; } };
}
const planParts = (whole: boolean): LanguageModelV4StreamPart[] => [
  { type: "tool-input-start", id: "c1", toolName: "plan" },
  { type: "tool-input-delta", id: "c1", delta: whole ? "{\"steps\":[{\"tool\":\"set_tempo\"}" : "{\"steps\":[{\"tool\":" },
];
const overloaded = () => new APICallError({ message: "down", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true, responseHeaders: { "retry-after-ms": "1" } });

test("a plan whose first step waits for the next begins when it's finished, and says it started once", async () => {
  // Like parameter steps waiting to batch: nothing starts while it's written; finishing starts it.
  let begin: (() => void) | undefined;
  const planTool: KernelTool = { name: "plan", description: "plan", inputSchema: { type: "object" }, execute: async () => ({ text: "whole" }),
    stream(_signal, onStart) {
      begin = onStart;
      return { started: false, push() {}, async finish() { onStart(); return { text: "planned", reply: "Done." }; }, async abandon() {} };
    } };
  const h = harness(() => new ReadableStream({ start(controller) {
    for (const part of planParts(true)) controller.enqueue(part);
    controller.enqueue({ type: "tool-input-end", id: "c1" });
    controller.enqueue(call("plan", "{\"steps\":[{\"tool\":\"set_tempo\"}]}"));
    controller.enqueue(finish("tool-calls")); controller.close();
  } }), { tools: [planTool] });
  const { events, emit } = collect();
  await h.kernel.run("go", new AbortController().signal, emit);
  assert.ok(begin);
  assert.equal(events.filter((event) => event.type === "tool-start").length, 1, `one start, so its end closes it: ${JSON.stringify(events)}`);
  await h.kernel.close();
});

test("a plan starts while the model is still writing it, and finishes with the whole of it", async () => {
  const fixture = streamingTool();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(() => new ReadableStream({ async start(controller) {
    for (const part of planParts(true)) controller.enqueue(part);
    await held;
    controller.enqueue({ type: "tool-input-delta", id: "c1", delta: "]}" });
    controller.enqueue({ type: "tool-input-end", id: "c1" });
    controller.enqueue(call("plan", "{\"steps\":[{\"tool\":\"set_tempo\"}]}"));
    controller.enqueue(finish("tool-calls")); controller.close();
  } }), { tools: [fixture.planTool] });
  const { events, emit } = collect();
  const running = h.kernel.run("go", new AbortController().signal, emit);
  await delay(10);
  assert.deepEqual(events.map((event) => event.type), ["tool-input", "tool-start"], "running before the model finished writing it");
  release();
  assert.equal((await running).stopReason, "completed");
  assert.deepEqual(fixture.calls[0]!.finished, { steps: [{ tool: "set_tempo" }] });
  assert.equal(fixture.calls[0]!.pushes.join(""), "{\"steps\":[{\"tool\":\"set_tempo\"}]}");
  assert.equal(fixture.executed, 0, "not run a second time");
  assert.deepEqual(events.map((event) => event.type), ["tool-input", "tool-start", "tool-end", "text"], "its reply ends the turn");
  assert.equal(h.requests.length, 1);
  await h.kernel.close();
});

test("a reply that breaks off after its plan began isn't asked for again; one that broke off before is, afresh", async () => {
  const begun = streamingTool();
  let attempts = 0;
  const failing = harness(() => { attempts++; return [...planParts(true), { type: "error", error: overloaded() }]; }, { tools: [begun.planTool] });
  await assert.rejects(failing.kernel.run("go", new AbortController().signal, () => {}), /overloaded/);
  assert.equal(attempts, 1, "its first step ran, so the reply isn't asked for again");
  assert.equal(begun.calls[0]!.abandoned, true, "and nothing more of the plan starts");
  await failing.kernel.close();

  const early = streamingTool();
  const retried = harness((_options, n) => n === 1 ? [...planParts(false), { type: "error", error: overloaded() }] : [...text("ok"), finish()], { tools: [early.planTool] });
  assert.equal((await retried.kernel.run("go", new AbortController().signal, () => {})).stopReason, "completed");
  assert.equal(retried.requests.length, 2, "nothing had begun, so the reply was asked for again");
  assert.equal(early.calls[0]!.abandoned, true);
  await retried.kernel.close();
});

test("a quiet call (a note kept) beside the model's answer ends the turn; before the answer, or beside a read, the model carries on", async () => {
  const note = tool("remember", async () => ({ text: "{\"kept\":\"s1\"}", reply: "" }));
  const read = tool("read", async () => ({ text: "{\"tempo\":120}" }));
  const answered = harness(() => [...text("Got it: the Reese carries the low end."), call("remember", "{\"note\":\"The Reese is the main bass\",\"about\":\"set\"}"), finish("tool-calls")], { tools: [note, read] });
  const { events, emit } = collect();
  assert.equal((await answered.kernel.run("the reese is my main bass", new AbortController().signal, emit)).stopReason, "completed");
  assert.equal(answered.requests.length, 1, "no model reply after keeping a note");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.type === "text" && event.text).join(""), "Got it: the Reese carries the low end.", "nothing added to the answer");
  assert.equal(answered.kernel.checkpoint().messages.at(-1)?.role, "tool", "the call and its result stay in the conversation");
  await answered.kernel.close();

  const reading = harness((_options, n) => n === 1 ? [call("read", "{}", "a"), call("remember", "{\"note\":\"x\",\"about\":\"set\"}", "b"), finish("tool-calls")] : [...text("It's 120."), finish()], { tools: [note, read] });
  await reading.kernel.run("what's the tempo? and remember I like it", new AbortController().signal, () => {});
  assert.equal(reading.requests.length, 2, "the read's result goes back to the model");
  await reading.kernel.close();

  // A note kept before the answer is written: the model still answers, after it.
  const first = harness((_options, n) => n === 1 ? [call("remember", "{\"note\":\"Prefers short reverbs\",\"about\":\"producer\"}"), finish("tool-calls")] : [...text("Short, dark reverbs: try Hybrid Reverb."), finish()], { tools: [note] });
  const answers = collect();
  assert.equal((await first.kernel.run("I like short reverbs. Which reverb suits that?", new AbortController().signal, answers.emit)).stopReason, "completed");
  assert.equal(first.requests.length, 2, "a note kept first doesn't cut the answer off");
  assert.match(answers.events.map((event) => event.type === "text" ? event.text : "").join(""), /Hybrid Reverb/);
  assert.ok(!first.kernel.checkpoint().messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && !part.text)), "no empty answer is kept");
  await first.kernel.close();
});

test("a conversation carried into other instructions (other notes, say) continues without its reasoning", async () => {
  const thinking: LanguageModelV4StreamPart[] = [
    { type: "reasoning-start", id: "r1", providerMetadata: { anthropic: { signature: "sig-9" } } }, { type: "reasoning-delta", id: "r1", delta: "hmm" }, { type: "reasoning-end", id: "r1" },
  ];
  const first = harness(() => [...thinking, ...text("ok"), finish()]);
  await first.kernel.run("one", new AbortController().signal, () => {});
  const checkpoint = JSON.parse(JSON.stringify(first.kernel.checkpoint()));
  const same = harness(() => [...text("ok"), finish()], { checkpoint });
  await same.kernel.run("two", new AbortController().signal, () => {});
  assert.match(JSON.stringify(same.requests[0]!.prompt), /sig-9/);
  const other = harness(() => [...text("ok"), finish()], { checkpoint, instructions: "fixture instructions\n\n<remembered_notes_untrusted>\n- [s1] new note\n</remembered_notes_untrusted>" });
  await other.kernel.run("two", new AbortController().signal, () => {});
  assert.doesNotMatch(JSON.stringify(other.requests[0]!.prompt), /sig-9/);
  await first.kernel.close(); await same.kernel.close(); await other.kernel.close();
});

test("a tool's images reach the model for the rest of the turn; when it ends they're put away, with the reasoning written after them", async () => {
  const thinking = (id: string): LanguageModelV4StreamPart[] => [
    { type: "reasoning-start", id, providerMetadata: { openai: { itemId: `rs_${id}`, reasoningEncryptedContent: "enc" } } },
    { type: "reasoning-delta", id, delta: "thinking" }, { type: "reasoning-end", id }];
  const h = harness((_options, n) => n === 1 ? [...thinking("a"), call("watch", "{}"), finish("tool-calls")]
    : n === 2 ? [...thinking("b"), call("read", "{}", "c2"), finish("tool-calls")] : n === 3 ? [...thinking("c"), ...text("It loads Operator."), finish()] : [...text("again"), finish()], {
    tools: [
      tool("watch", async () => ({ text: "Video: a tutorial", images: [
        { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), mediaType: "image/jpeg", caption: "Frame at 0:05" },
        { data: new Uint8Array([1]), mediaType: "text/plain" },
        { data: new Uint8Array([0x89, 0x50]), mediaType: "image/png" }] })),
      tool("read", async () => ({ text: "tempo 120" })),
    ],
  });
  await h.kernel.run("watch this", new AbortController().signal, () => {});
  const shown = (request: LanguageModelV4CallOptions | undefined) => request?.prompt.find((message) => message.role === "tool");
  // During the turn: words, each image after its caption (what models can't read is left out), as plain bytes.
  const output = shown(h.requests[1])?.content[0];
  assert.ok(output?.type === "tool-result" && output.output.type === "content");
  assert.deepEqual(output.output.value.map((part) => part.type === "text" ? part.text : part.type === "file" ? part.mediaType : part.type),
    ["Video: a tutorial", "Frame at 0:05", "image/jpeg", "image/png"]);
  const image = output.output.value[2];
  assert.ok(image?.type === "file" && image.data.type === "data" && image.data.data instanceof Uint8Array && !Buffer.isBuffer(image.data.data));
  assert.equal(shown(h.requests[2])?.content[0]?.type === "tool-result" && (shown(h.requests[2])!.content[0] as { output: { type: string } }).output.type, "content");
  // Settled: the words stay with a line saying images were there; reasoning before them stays, after them goes.
  const settled = h.kernel.checkpoint().messages;
  assert.deepEqual(settled[2], { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "watch",
    output: { type: "text", value: "Video: a tutorial\nFrame at 0:05\n[2 images were shown here; they're no longer attached (the tool shows them again when asked).]" } }] });
  assert.equal(settled[1]!.role === "assistant" && settled[1]!.content[0]?.type, "reasoning");
  assert.ok(settled.slice(3).every((message) => message.role !== "assistant" || message.content.every((part) => part.type !== "reasoning")));
  assert.doesNotMatch(JSON.stringify(settled), /"0":255/);
  await h.kernel.run("and now?", new AbortController().signal, () => {});
  assert.ok(!JSON.stringify(h.requests[3]?.prompt).includes("image/jpeg"));
  await h.kernel.close();
});

test("a stopped turn keeps a tool's words, not its images", async () => {
  const h = harness((options, n) => n === 1 ? [call("watch", "{}"), finish("tool-calls")] : hanging(options, []), {
    tools: [tool("watch", async () => ({ text: "Video", images: [{ data: new Uint8Array([0xff, 0xd8]), mediaType: "image/jpeg" }] }))],
  });
  const controller = new AbortController();
  const running = h.kernel.run("watch", controller.signal, () => {});
  while (h.requests.length < 2) await delay(1);
  controller.abort();
  assert.equal((await running).stopReason, "cancelled");
  const settled = JSON.stringify(h.kernel.checkpoint().messages);
  assert.match(settled, /An image was shown here/);
  assert.doesNotMatch(settled, /image\/jpeg/);
  await h.kernel.close();
});
