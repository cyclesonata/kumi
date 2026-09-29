import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { KumiError } from "../src/core/errors.js";
import { createSession } from "../src/core/session.js";
import type { ConnectionState, ConversationStore, Kernel, KernelEvent, KernelFactory, KernelOptions, Memory, MemoryNote, MemoryStore, Observation, SavedConversation, SessionEvent, TurnResult } from "../src/core/contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(options: { run?: Kernel["run"]; factory?: KernelFactory; timeoutMs?: number; idleTimeoutMs?: number; turnLimitMs?: number; maxTurns?: number; memory?: MemoryStore } = {}) {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const kernels: { closed: number }[] = [];
  let integrationCloses = 0;
  let observations = 0;
  let connection!: (state: ConnectionState) => void;
  let observation: Observation = { key: "epoch:1", label: "Fixture Set", context: "fresh fixture context", instructions: "fixture instructions", tools: [] };
  let refreshError = false;
  const session = createSession({
    onEvent: (event) => events.push(event), timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}), ...(options.turnLimitMs ? { turnLimitMs: options.turnLimitMs } : {}),
    cancelGraceMs: 10, closeTimeoutMs: 25, ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}), ...(options.memory ? { memory: options.memory } : {}),
    kernelFactory: options.factory ?? (async ({ instructions, tools }) => {
      assert.equal(instructions, observation.instructions); assert.deepEqual(tools, []);
      const record = { closed: 0 }; kernels.push(record);
      return {
        async run(input, signal, emit) {
          calls.push(input);
          if (options.run) return options.run(input, signal, emit);
          emit({ type: "text", text: "answer" });
          return { stopReason: "completed", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        },
        async close() { record.closed++; },
      };
    }),
    integrationFactory: (listener) => {
      connection = listener;
      return {
        async start() { listener("connecting"); listener("connected"); },
        async observe() { observations++; if (refreshError) throw new Error("secret-token-must-not-escape"); return observation; },
        async close() { integrationCloses++; },
      };
    },
  });
  return { session, events, calls, kernels, get observations() { return observations; }, get integrationCloses() { return integrationCloses; },
    connection: (state: ConnectionState) => connection(state),
    setObservation: (next: Partial<Observation>) => { observation = { ...observation, ...next }; },
    failRefresh: () => { refreshError = true; },
  };
}

test("fresh context per turn; streams text/tools/usage once and rejects concurrent submit", async () => {
  const held = deferred<TurnResult>();
  const h = harness({ run: async (_input, _signal, emit) => {
    emit({ type: "text", text: "hello" });
    emit({ type: "tool-start", id: "t1", name: "read_fixture" });
    emit({ type: "tool-end", id: "t1", name: "read_fixture", elapsedMs: 3, isError: false });
    return held.promise;
  } });
  await h.session.start();
  const running = h.session.submit("question");
  await delay(0);
  await assert.rejects(h.session.submit("second"), /busy/);
  assert.equal(h.session.status().state, "running");
  assert(h.calls[0]?.includes("fresh fixture context"));
  held.resolve({ stopReason: "completed", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  await running;
  assert.equal(h.observations, 2);
  assert.equal(h.events.filter((e) => e.type === "text").length, 1);
  assert.equal(h.events.filter((e) => e.type === "tool-start").length, 1);
  assert(h.events.some((e) => e.type === "turn-complete" && e.result.usage?.inputTokens === 5));
  assert.equal(h.session.status().state, "idle");
  await h.session.close();
});

test("cancels uncooperative streaming/tools, fences late results, and recovers next turn", async () => {
  const held = deferred<TurnResult>();
  let oldEmit: ((event: KernelEvent) => void) | undefined;
  let calls = 0;
  const h = harness({ run: async (_input, _signal, emit) => {
    calls++;
    if (calls === 1) { oldEmit = emit; return held.promise; }
    emit({ type: "text", text: "fresh" }); return { stopReason: "completed" };
  } });
  await h.session.start();
  await h.session.cancel(); // idle cancellation sends no prompt
  const running = h.session.submit("cancel me");
  await delay(0);
  await h.session.cancel(); await running;
  assert.equal(h.session.status().state, "idle");
  await h.session.submit("next");
  oldEmit?.({ type: "text", text: "stale" });
  oldEmit?.({ type: "tool-end", id: "late", name: "late", isError: false, elapsedMs: 999 });
  held.resolve({ stopReason: "completed" }); await delay(0);
  assert.deepEqual(h.events.filter((e) => e.type === "text").map((e) => e.text), ["fresh"]);
  assert(!h.events.some((e) => e.type === "tool-end" && e.id === "late"));
  assert(h.events.some((e) => e.type === "turn-complete" && e.result.stopReason === "cancelled"));
  await h.session.close();
});

test("cooperative cancellation keeps settled conversation history without recreating the kernel", async () => {
  let count = 0;
  const h = harness({ run: async (_input, signal) => {
    if (++count > 1) return { stopReason: "completed" };
    return new Promise<TurnResult>((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "cancelled", usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }), { once: true }));
  } });
  await h.session.start(); const running = h.session.submit("cancel"); await delay(0);
  await h.session.cancel(); await running; await h.session.submit("followup");
  assert.equal(h.kernels.length, 1); assert.equal(h.kernels[0]?.closed, 0);
  assert(h.events.some((event) => event.type === "turn-complete" && event.result.stopReason === "cancelled" && event.result.usage?.inputTokens === 4));
  await h.session.close(); assert.equal(h.session.status().connection, "disconnected");
});

test("timeout is bounded and quarantines an uncooperative kernel", async () => {
  let calls = 0;
  const h = harness({ timeoutMs: 15, run: async () => { if (++calls === 1) return new Promise(() => {}); return { stopReason: "completed" }; } });
  await h.session.start();
  await h.session.submit("timeout");
  assert(h.events.some((e) => e.type === "error" && /without progress/.test(e.message)));
  await h.session.submit("recovered");
  assert.equal(h.kernels.length, 2, "a kernel that didn't stop when asked is set aside");
  await h.session.close();
});

test("a turn that keeps making progress runs past the no-progress limit; one that stops when asked keeps its conversation", async () => {
  let mode: "busy" | "quiet" = "busy";
  const h = harness({ idleTimeoutMs: 40, run: async (_input, signal, emit) => {
    if (mode === "busy") { for (let step = 0; step < 8; step++) { await delay(15); emit({ type: "text", text: "." }); } return { stopReason: "completed" }; }
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "cancelled" }), { once: true }));
  } });
  await h.session.start();
  await h.session.submit("build a patch");
  assert(h.events.some((event) => event.type === "turn-complete" && event.result.stopReason === "completed"), "120 ms of steady progress outlives a 40 ms limit");
  assert(!h.events.some((event) => event.type === "error"));
  mode = "quiet";
  await h.session.submit("think");
  assert(h.events.some((event) => event.type === "error" && /Kumi stopped after 1 second without progress\. Anything it changed is in HISTORY/.test(event.message)));
  await h.session.submit("carry on");
  assert.equal(h.kernels.length, 1, "the kernel stopped when asked, so its conversation carries on");
  assert(!h.events.some((event) => event.type === "notice" && /discarded/.test(event.message)));
  await h.session.close();
});

test("however busy, a turn stops at its limit", async () => {
  const h = harness({ idleTimeoutMs: 1_000, turnLimitMs: 60, run: (_input, signal, emit) => new Promise((resolve) => {
    const timer = setInterval(() => emit({ type: "text", text: "." }), 5);
    signal.addEventListener("abort", () => { clearInterval(timer); resolve({ stopReason: "cancelled" }); }, { once: true });
  }) });
  await h.session.start();
  await h.session.submit("forever");
  assert(h.events.some((event) => event.type === "error" && /this answer had run for/.test(event.message)));
  assert(h.events.some((event) => event.type === "turn-complete" && event.result.stopReason === "cancelled"));
  await h.session.close();
});

test("refresh failure does not call inference or emit old context", async () => {
  const h = harness(); await h.session.start(); h.failRefresh();
  await h.session.submit("current state?");
  assert.equal(h.calls.length, 0);
  assert(h.events.some((e) => e.type === "error"));
  assert(!JSON.stringify(h.events).includes("secret-token"));
  await h.session.close();
});

test("identity change resets conversation; same-identity refresh updates observations", async () => {
  const h = harness(); await h.session.start(); await h.session.submit("one");
  h.setObservation({ label: "Renamed Set", context: "new name" });
  await h.session.refresh();
  assert.equal(h.session.status().observation, "Renamed Set");
  assert.equal(h.kernels.length, 1);
  h.setObservation({ key: "epoch:2" }); await h.session.submit("two");
  assert.equal(h.kernels.length, 2); assert.equal(h.kernels[0]?.closed, 1);
  assert(h.events.some((e) => e.type === "notice" && /changed/.test(e.message)));
  await h.session.close();
});

test("a changed tool catalog for the same Set keeps the conversation in a rebuilt kernel", async () => {
  const created: { checkpoint?: unknown; tools: number }[] = [];
  const h = harness({ factory: async ({ tools, checkpoint }) => {
    created.push({ tools: tools.length, ...(checkpoint ? { checkpoint } : {}) });
    const history: string[] = checkpoint ? [...(checkpoint.messages as string[])] : [];
    return {
      async run(input: string) { history.push(input); return { stopReason: "completed" as const }; },
      async close() {},
      checkpoint() { return { version: 1 as const, messages: [...history] }; },
    };
  } });
  await h.session.start(); await h.session.submit("one");
  h.setObservation({ revision: "2", tools: [{ name: "live_clip", description: "clip tool", inputSchema: { type: "object" }, execute: async () => ({ text: "ok" }) }] });
  await h.session.submit("two");
  assert.equal(created.length, 2, "a kernel with the new tools");
  const carried = created[1]?.checkpoint as { version: number; messages: string[] } | undefined;
  assert.equal(carried?.version, 1);
  assert.equal(carried?.messages.length, 1, "carrying the settled conversation");
  assert.ok(carried?.messages[0]?.includes("one"));
  assert.equal(created[1]?.tools, 1);
  assert(!h.events.some((e) => e.type === "notice" && /fresh conversation/.test(e.message)), "no reset notice");
  await h.session.close();
});

test("a model change rebuilds the kernel when it's next needed, carrying the conversation on, even mid-answer", async () => {
  const created: { checkpoint?: unknown }[] = [];
  const held = deferred<TurnResult>();
  let turns = 0;
  const h = harness({ factory: async ({ checkpoint }) => {
    created.push({ ...(checkpoint ? { checkpoint } : {}) });
    const history: string[] = checkpoint ? [...(checkpoint.messages as string[])] : [];
    return {
      async run(input: string) { history.push(input); return ++turns === 2 ? held.promise : { stopReason: "completed" as const }; },
      async close() {},
      checkpoint() { return { version: 1 as const, messages: [...history] }; },
    };
  } });
  await h.session.start(); await h.session.submit("one");
  const answering = h.session.submit("two");
  await delay(0);
  await h.session.reconfigure!();
  assert.equal(created.length, 1, "the answer running now finishes as it started");
  held.resolve({ stopReason: "completed" });
  await answering;
  await h.session.submit("three");
  assert.equal(created.length, 2, "the next answer uses the new model");
  const carried = (created[1]?.checkpoint as { messages: string[] }).messages;
  assert.equal(carried.length, 2);
  assert.ok(carried[0]?.includes("one") && carried[1]?.includes("two"));
  await h.session.close();
});

test("a failed answer's error says what failed and where, so the app can offer the fix", async () => {
  const h = harness({ run: async () => { throw new KumiError("auth", "Not signed in to Anthropic: add its API key with /login (or set ANTHROPIC_API_KEY).", "anthropic"); } });
  await h.session.start();
  await h.session.submit("hello");
  const error = h.events.find((event) => event.type === "error");
  assert.deepEqual(error, { type: "error", message: "Not signed in to Anthropic: add its API key with /login (or set ANTHROPIC_API_KEY).", kind: "auth", provider: "anthropic" });
  await h.session.close();
});

test("disconnect invalidates current observation and cancels; next turn is explicitly inference-only", async () => {
  let calls = 0;
  const h = harness({ run: async () => { if (++calls === 1) return new Promise(() => {}); return { stopReason: "completed" }; } });
  await h.session.start(); const running = h.session.submit("live"); await delay(0);
  h.setObservation({ key: "disconnected:2", label: "No Live access", context: "No Live access", tools: [] });
  h.connection("disconnected"); await running;
  assert.equal(h.session.status().connection, "disconnected");
  assert.equal(h.session.status().observation, undefined);
  await h.session.submit("music theory");
  assert(h.calls.at(-1)?.includes("No Live access"));
  await h.session.close();
});

test("Live going away while idle keeps the conversation; when it's back Kumi says so and reads the Set again", async () => {
  const h = harness();
  await h.session.start();
  await h.session.submit("first");
  h.connection("disconnected");
  assert(h.events.some((e) => e.type === "notice" && /reconnects when Live is back/.test(e.message)));
  const observed = h.observations;
  h.connection("connected");
  assert(h.events.some((e) => e.type === "notice" && e.message === "Live is back."));
  await delay(20);
  assert.equal(h.observations, observed + 1, "the Set is read again right away");
  await h.session.submit("second");
  assert.equal(h.kernels.length, 1, "the same conversation continues");
  assert(!h.events.some((e) => e.type === "notice" && /fresh conversation/.test(e.message)));
  await h.session.close();
});

test("a saved Set's conversation continues next time; /new starts it afresh", async () => {
  const project = "a".repeat(32);
  const saved = new Map<string, SavedConversation>();
  const store: ConversationStore = { async load(id) { return saved.get(id); }, async save(id, conversation) { saved.set(id, structuredClone(conversation)); }, async clear(id) { saved.delete(id); } };
  const created: KernelOptions[] = [];
  const factory: KernelFactory = async (options) => {
    created.push(options);
    const history = [...(options.checkpoint?.messages ?? [])] as string[];
    return {
      async run(input) { history.push(input.split("\n\n<current_observation_untrusted>")[0]!); return { stopReason: "completed" }; },
      async close() {},
      checkpoint() { return { version: 1, messages: [...history] }; },
      transcript() { return history.map((text) => ({ role: "user" as const, text })); },
    };
  };
  const open = () => {
    const events: SessionEvent[] = [];
    const session = createSession({ kernelFactory: factory, onEvent: (event) => events.push(event), conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
      integrationFactory: (listener) => ({ async start() { listener("connected"); }, async close() {},
        async observe() { return { key: "night-drive", label: "Night Drive", context: "ctx", instructions: "i", tools: [], project: { id: project, name: "Night Drive" } }; } }) });
    return { session, events };
  };
  const one = open();
  await one.session.start(); await one.session.submit("remember 42"); await delay(5); await one.session.close();
  assert.deepEqual(saved.get(project)?.checkpoint.messages, ["remember 42"], "kept after the turn");
  const two = open();
  await two.session.start();
  const resumed = two.events.find((event): event is Extract<SessionEvent, { type: "resumed" }> => event.type === "resumed");
  assert.deepEqual(resumed?.lines, [{ role: "user", text: "remember 42" }]);
  assert.deepEqual(created.at(-1)?.checkpoint?.messages, ["remember 42"], "the kernel carries it on");
  await two.session.newConversation();
  assert.equal(saved.has(project), false, "/new discards the saved conversation too");
  assert.equal(created.at(-1)?.checkpoint, undefined);
  await two.session.close();
});

test("there's no turn limit unless one is set", async () => {
  const h = harness(); await h.session.start();
  for (let turn = 0; turn < 40; turn++) await h.session.submit(`prompt ${turn}`);
  assert.equal(h.session.status().turns, 40); assert.equal(h.session.status().maxTurns, undefined);
  await h.session.close();
});

test("new conversation closes old resources, reconnects, and resets submitted-turn limit", async () => {
  const h = harness({ maxTurns: 1 }); await h.session.start(); await h.session.submit("one");
  await assert.rejects(h.session.submit("two"), /\/new/);
  await h.session.newConversation();
  assert.equal(h.integrationCloses, 1); assert.equal(h.kernels[0]?.closed, 1);
  assert.equal(h.session.status().turns, 0);
  await h.session.submit("new one");
  await h.session.close(); await h.session.close();
  assert.equal(h.integrationCloses, 2);
  await assert.rejects(h.session.submit("closed"), /closed/);
});

test("startup failure closes integration; late startup kernel is closed after cancellation", async () => {
  const failed = harness({ factory: async () => { throw new Error("private startup failure"); } });
  await assert.rejects(failed.session.start(), /start/);
  assert.equal(failed.integrationCloses, 1);
  assert(!JSON.stringify(failed.events).includes("private"));
  await failed.session.close();
  const held = deferred<Kernel>(); let closed = 0;
  const h = harness({ factory: () => held.promise });
  const starting = h.session.start().catch(() => {}); await delay(0);
  await h.session.close();
  held.resolve({ async run() { return { stopReason: "completed" }; }, async close() { closed++; } });
  await starting; await delay(0);
  assert.equal(closed, 1); assert.equal(h.session.status().state, "closed");
});

test("what Kumi remembers goes into each new conversation's instructions, with the tools to keep and drop notes", async () => {
  const saved: Record<string, MemoryNote[]> = { producer: [{ id: "p1", text: "Prefers short reverbs", at: 1 }], set: [] };
  const memory: MemoryStore = {
    async load(project): Promise<Memory> { return { producer: [...saved.producer!], set: project ? [...saved.set!] : [] }; },
    async save(scope, _project, notes) { saved[scope] = [...notes]; },
  };
  const created: KernelOptions[] = [];
  const h = harness({ memory, factory: async (options) => {
    created.push(options);
    return { async run(_input, signal) {
      await options.tools.find((item) => item.name === "remember")!.execute({ note: "The Reese is the main bass", about: "producer" }, signal);
      return { stopReason: "completed" as const };
    }, async close() {} };
  } });
  await h.session.start();
  await h.session.submit("the reese is my main bass");
  assert.match(created[0]!.instructions, /fixture instructions\n\n<remembered_notes_untrusted>[\s\S]*\[p1\] Prefers short reverbs/);
  assert.deepEqual(created[0]!.tools.map((item) => item.name), ["remember", "forget"]);
  assert.ok(h.events.some((event) => event.type === "remembered" && event.note.text === "The Reese is the main bass"));
  const now = await h.session.memory!();
  assert.deepEqual(now?.producer.map((note) => note.id), ["p1", "p2"]);
  assert.equal(now?.saved, false, "the fixture's Set isn't saved");
  assert.equal((await h.session.forget!("p1"))?.text, "Prefers short reverbs");
  assert.deepEqual(saved.producer!.map((note) => note.id), ["p2"]);
  assert.ok(h.events.some((event) => event.type === "forgot"));
  await h.session.close();
});
