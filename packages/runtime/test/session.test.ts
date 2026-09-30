import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { KumiError } from "../src/core/errors.js";
import { createSession } from "../src/core/session.js";
import type { ConnectionState, ConversationStore, DisconnectCause, Kernel, KernelEvent, KernelFactory, KernelOptions, Memory, MemoryNote, MemoryStore, Observation, SavedConversation, SessionEvent, TurnResult } from "../src/core/contracts.js";

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
  let stops = 0; let stopWorks = true;
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
        async stopLive() { stops++; return stopWorks; },
      };
    },
  });
  return { session, events, calls, kernels, get observations() { return observations; }, get integrationCloses() { return integrationCloses; },
    connection: (state: ConnectionState) => connection(state),
    setObservation: (next: Partial<Observation>) => { observation = { ...observation, ...next }; },
    failRefresh: () => { refreshError = true; },
    get stops() { return stops; }, failStop: () => { stopWorks = false; },
  };
}

test("stopping Live goes straight to the integration, during a turn too, and NOW hears of it only when it worked", async () => {
  const held = deferred<TurnResult>();
  const h = harness({ run: async () => held.promise });
  await h.session.start();
  const running = h.session.submit("record the bass");
  await delay(0);
  assert.equal(await h.session.stopLive!(), true);
  assert.equal(h.stops, 1);
  assert.deepEqual(h.events.filter((event) => event.type === "action"), [{ type: "action", title: "Stopped", playing: false, recording: false }]);
  assert.equal(h.session.status().state, "running", "the answer isn't cancelled by it");
  held.resolve({ stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  await running;
  h.failStop();
  assert.equal(await h.session.stopLive!(), false);
  assert.equal(h.events.filter((event) => event.type === "action").length, 1);
  await h.session.close();
});

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
  assert(h.events.some((e) => e.type === "notice" && /will pick up where you left off/.test(e.message)));
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

/** Conversations kept in memory, as the file store keeps them. */
function memoryStore() {
  const places = new Map<string, { current: string | undefined; kept: Map<string, SavedConversation> }>();
  const at = (place: string) => { let entry = places.get(place); if (!entry) places.set(place, entry = { current: undefined, kept: new Map() }); return entry; };
  const store: ConversationStore = {
    async current(place) { const entry = at(place); const conversation = entry.current ? entry.kept.get(entry.current) : undefined; return conversation ? { id: entry.current!, conversation: structuredClone(conversation) } : undefined; },
    async load(place, id) { const conversation = at(place).kept.get(id); return conversation ? structuredClone(conversation) : undefined; },
    async save(place, id, conversation) { const entry = at(place); entry.kept.set(id, structuredClone(conversation)); entry.current = id; },
    async fresh(place) { at(place).current = undefined; },
    async list(place) {
      const entry = at(place);
      return [...entry.kept].map(([id, conversation]) => ({ id, savedAt: conversation.savedAt, first: conversation.first ?? "", turns: conversation.turns ?? 0, current: id === entry.current })).sort((a, b) => b.savedAt - a.savedAt);
    },
    async move(id, from, to) {
      const conversation = at(from).kept.get(id);
      if (!conversation) return;
      at(from).kept.delete(id); if (at(from).current === id) at(from).current = undefined;
      at(to).kept.set(id, conversation); at(to).current = id;
    },
  };
  return store;
}
type Said = { role: "user" | "assistant"; content: string };
/** A kernel whose conversation is the producer's words, carried on from its checkpoint; `hang` makes a turn never stop. */
function wordsKernel(created: KernelOptions[], behaviour: { hang?: boolean } = {}): KernelFactory {
  return async (options) => {
    created.push(options);
    const history = [...(options.checkpoint?.messages ?? [])] as Said[];
    return {
      async run(input) {
        if (behaviour.hang) return new Promise<TurnResult>(() => {});
        history.push({ role: "user", content: input.split("\n\n<current_observation_untrusted>")[0]! });
        return { stopReason: "completed" };
      },
      async close() {},
      checkpoint() { return { version: 1, messages: [...history] }; },
      transcript() { return history.map((message) => ({ role: message.role, text: message.content })); },
    };
  };
}
const words = (options: KernelOptions | undefined) => (options?.checkpoint?.messages as Said[] | undefined)?.map((message) => message.content);
const settle = () => delay(5);

test("a saved Set's conversation continues next time; /new starts afresh over the same bridge and keeps it for /conversations", async () => {
  const project = "a".repeat(32);
  const store = memoryStore();
  const created: KernelOptions[] = [];
  let integrations = 0;
  const open = () => {
    const events: SessionEvent[] = [];
    const session = createSession({ kernelFactory: wordsKernel(created), onEvent: (event) => events.push(event), conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
      integrationFactory: (listener) => { integrations++; return { async start() { listener("connected"); }, async close() {},
        async observe() { return { key: "night-drive", label: "Night Drive", context: "ctx", instructions: "i", tools: [], project: { id: project, name: "Night Drive" } }; } }; } });
    return { session, events };
  };
  const one = open();
  await one.session.start(); await one.session.submit("remember 42"); await settle(); await one.session.close();
  const kept = await store.current(project);
  assert.deepEqual((kept?.conversation.checkpoint.messages as Said[]).map((message) => message.content), ["remember 42"], "kept after the turn");
  assert.equal(kept?.conversation.turns, 1);
  const two = open();
  await two.session.start();
  const resumed = two.events.find((event): event is Extract<SessionEvent, { type: "resumed" }> => event.type === "resumed");
  assert.deepEqual(resumed?.lines, [{ role: "user", text: "remember 42" }]);
  assert.deepEqual(words(created.at(-1)), ["remember 42"], "the kernel carries it on");
  const bridges = integrations;
  await two.session.newConversation();
  assert.equal(integrations, bridges, "/new keeps the bridge, and with it HISTORY's undo");
  assert.equal(created.at(-1)?.checkpoint, undefined, "the new conversation starts empty");
  assert.equal(await store.current(project), undefined);
  assert.ok(two.events.some((event) => event.type === "notice" && /The last one is kept; \/conversations goes back to it/.test(event.message)));
  await two.session.submit("a new idea"); await settle();
  const listed = await two.session.conversations!();
  assert.deepEqual(listed.map((row) => [row.first, row.turns, row.current]), [["a new idea", 1, true], ["remember 42", 1, false]]);
  assert.equal(await two.session.resumeConversation!(listed[1]!.id), true);
  assert.deepEqual(words(created.at(-1)), ["remember 42"], "back to the earlier one");
  assert.ok(two.events.some((event) => event.type === "resumed" && event.chosen === true));
  await settle();
  assert.equal((await store.current(project))?.id, listed[1]!.id, "and it's the Set's current one now");
  await two.session.close();
});

test("an unsaved Set's conversation is kept too, and moves with the Set when it's first saved", async () => {
  const store = memoryStore();
  const created: KernelOptions[] = [];
  let project: { id: string; name: string } | undefined;
  const session = createSession({ kernelFactory: wordsKernel(created), onEvent: () => {}, conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
    integrationFactory: (listener) => ({ async start() { listener("connected"); }, async close() {},
      async observe() { return { key: "sketch", label: "Sketch", context: "ctx", instructions: "i", tools: [], ...(project ? { project } : {}) }; } }) });
  await session.start(); await session.submit("sketch a progression"); await settle();
  assert.equal((await store.list("unsaved")).length, 1);
  project = { id: "b".repeat(32), name: "Sketch" };
  await session.submit("now add drums"); await settle();
  assert.deepEqual(await store.list("unsaved"), []);
  assert.deepEqual(((await store.current(project.id))?.conversation.checkpoint.messages as Said[]).map((message) => message.content), ["sketch a progression", "now add drums"]);
  await session.close();
});

test("Live closing mid-request stops it and keeps the conversation; when it's back Kumi offers to send the request again", async () => {
  const created: KernelOptions[] = [];
  const behaviour = { hang: false };
  const events: SessionEvent[] = [];
  let listener!: (state: ConnectionState, cause?: DisconnectCause) => void;
  const session = createSession({ kernelFactory: wordsKernel(created, behaviour), onEvent: (event) => events.push(event), cancelGraceMs: 10, closeTimeoutMs: 25, missingAfterMs: 30,
    integrationFactory: (connection) => { listener = connection; return { async start() { connection("connected"); }, async close() {},
      async observe() { return { key: "unsaved-set", label: "Set", context: "ctx", instructions: "i", tools: [] }; } }; } });
  await session.start();
  await session.submit("make the bass wider");
  behaviour.hang = true;
  const running = session.submit("record the chorus");
  await delay(0);
  listener("disconnected", "live");
  await running;
  assert.ok(events.some((event) => event.type === "notice" && event.message === "Live closed. Kumi will pick up where you left off when it's back."));
  assert.ok(!events.some((event) => event.type === "notice" && /\/new/.test(event.message)), "never /new for a connection problem");
  await delay(60);
  assert.ok(events.some((event) => event.type === "notice" && /^Kumi can't reach Live\. Is it open, with AbletonMcpBridge/.test(event.message)), "after a while, Kumi asks whether Live is open");
  behaviour.hang = false;
  listener("connected");
  assert.ok(events.some((event) => event.type === "notice" && event.message === "Live is back. Your last request was stopped; press enter to send it again."));
  assert.deepEqual(events.filter((event) => event.type === "resend"), [{ type: "resend", text: "record the chorus" }]);
  await settle();
  await session.submit("record the chorus");
  assert.deepEqual(words(created.at(-1)), ["make the bass wider"], "the answer that didn't stop is set aside; the conversation carries on from before it");
  assert.ok(!events.some((event) => event.type === "notice" && /fresh conversation/.test(event.message)));
  await session.close();
});

test("/reconnect starts a fresh bridge and carries the conversation over, unless a different saved Set is open", async () => {
  const created: KernelOptions[] = [];
  let bridges = 0; let project = { id: "f".repeat(32), name: "Night Drive" };
  const session = createSession({ kernelFactory: wordsKernel(created), onEvent: () => {}, cancelGraceMs: 10, closeTimeoutMs: 25,
    integrationFactory: (listener) => { const bridge = ++bridges; return { async start() { listener("connected"); }, async close() {},
      async observe() { return { key: `bridge-${bridge}`, label: "Set", context: "ctx", instructions: "i", tools: [], project }; } }; } });
  await session.start(); await session.submit("one");
  await session.reconnect!();
  assert.equal(bridges, 2);
  assert.deepEqual(words(created.at(-1)), ["one"], "a new bridge (a new key), the same conversation");
  await session.submit("two");
  project = { id: "d".repeat(32), name: "Another Set" };
  await session.reconnect!();
  assert.equal(created.at(-1)?.checkpoint, undefined, "a different saved Set has its own conversation");
  await session.close();
});

test("a kept conversation this model can't continue is shown, and a fresh one starts", async () => {
  const store = memoryStore();
  const project = "c".repeat(32);
  await store.save(project, "old001", { savedAt: 1, checkpoint: { version: 1, messages: [{ role: "user", content: "from another model" }, { role: "assistant", content: "sure" }] } });
  const events: SessionEvent[] = [];
  const session = createSession({ onEvent: (event) => events.push(event), conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
    kernelFactory: async (options) => { if (options.checkpoint) throw new Error("Unsupported checkpoint version."); return { async run() { return { stopReason: "completed" }; }, async close() {} }; },
    integrationFactory: (listener) => ({ async start() { listener("connected"); }, async close() {},
      async observe() { return { key: "k", label: "Set", context: "ctx", instructions: "i", tools: [], project: { id: project, name: "Set" } }; } }) });
  await session.start();
  const resumed = events.find((event): event is Extract<SessionEvent, { type: "resumed" }> => event.type === "resumed");
  assert.equal(resumed?.unreadable, true);
  assert.deepEqual(resumed?.lines, [{ role: "user", text: "from another model" }, { role: "assistant", text: "sure" }]);
  assert.ok(events.some((event) => event.type === "notice" && /couldn't continue that conversation with this model/.test(event.message)));
  assert.equal((await store.list(project)).length, 1, "the kept one stays");
  await session.close();
});

test("Kumi's changes are kept with the conversation and come back as HISTORY Kumi can't undo", async () => {
  const store = memoryStore();
  const project = "e".repeat(32);
  const open = () => {
    const events: SessionEvent[] = [];
    const session = createSession({ kernelFactory: wordsKernel([]), onEvent: (event) => events.push(event), conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
      integrationFactory: (listener) => ({ async start() { listener("connected"); }, async close() {},
        async observe() { return { key: "k", label: "Set", context: "ctx", instructions: "i", tools: [], project: { id: project, name: "Set" } }; } }) });
    return { session, events };
  };
  const one = open();
  await one.session.start();
  one.session.watch!({ type: "change", change: { id: "c1", family: "mixer", title: "Bass volume −6 dB", state: "applied", at: 1, clip: { length: 4, notes: [] } } });
  one.session.watch!({ type: "change", change: { id: "c2", family: "tempo", title: "Tempo 120 → 124 BPM", state: "undone", at: 2 } });
  await one.session.submit("turn the bass down"); await settle(); await one.session.close();
  const two = open();
  await two.session.start();
  const resumed = two.events.find((event): event is Extract<SessionEvent, { type: "resumed" }> => event.type === "resumed");
  assert.deepEqual(resumed?.changes?.map((change) => [change.title, change.state, change.note]), [
    ["Bass volume −6 dB", "expired", "From an earlier session, so Kumi can't undo it now."], ["Tempo 120 → 124 BPM", "undone", undefined]]);
  assert.ok(resumed?.changes?.every((change) => change.id.includes(":") && change.clip === undefined), "their own ids, without the pictures");
  await two.session.close();
});

test("there's no turn limit unless one is set", async () => {
  const h = harness(); await h.session.start();
  for (let turn = 0; turn < 40; turn++) await h.session.submit(`prompt ${turn}`);
  assert.equal(h.session.status().turns, 40); assert.equal(h.session.status().maxTurns, undefined);
  await h.session.close();
});

test("going back to a Set in the same session doesn't list its changes twice", async () => {
  const store = memoryStore();
  let project = { id: "1".repeat(32), name: "A" };
  const events: SessionEvent[] = [];
  const session = createSession({ kernelFactory: wordsKernel([]), onEvent: (event) => events.push(event), conversations: store, cancelGraceMs: 10, closeTimeoutMs: 25,
    integrationFactory: (listener) => ({ async start() { listener("connected"); }, async close() {},
      async observe() { return { key: project.id, label: project.name, context: "ctx", instructions: "i", tools: [], project }; } }) });
  await session.start();
  session.watch!({ type: "change", change: { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "applied", at: 5 } });
  await session.submit("faster"); await settle();
  project = { id: "2".repeat(32), name: "B" };
  await session.submit("hello B"); await settle();
  project = { id: "1".repeat(32), name: "A" };
  await session.submit("back to A"); await settle();
  const back = events.filter((event): event is Extract<SessionEvent, { type: "resumed" }> => event.type === "resumed").at(-1);
  assert.deepEqual(back?.lines.map((line) => line.text), ["faster"], "A's conversation carries on");
  assert.equal(back?.changes, undefined, "HISTORY shows its changes already, with their undo");
  await session.close();
});

test("/new closes the old conversation, not the bridge, and resets the submitted-turn limit", async () => {
  const h = harness({ maxTurns: 1 }); await h.session.start(); await h.session.submit("one");
  await assert.rejects(h.session.submit("two"), /\/new/);
  await h.session.newConversation();
  assert.equal(h.integrationCloses, 0); assert.equal(h.kernels[0]?.closed, 1);
  assert.equal(h.session.status().turns, 0);
  await h.session.submit("new one");
  await h.session.close(); await h.session.close();
  assert.equal(h.integrationCloses, 1);
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

test("a tool that works longer than the quiet timer (a plan recording) doesn't get the answer stopped; silence without one does", async () => {
  const long = harness({ idleTimeoutMs: 40, run: async (_input, _signal, emit) => {
    emit({ type: "tool-start", id: "t1", name: "make_changes" });
    await delay(120);
    emit({ type: "tool-end", id: "t1", name: "make_changes", elapsedMs: 120, isError: false });
    emit({ type: "text", text: "Recorded." });
    return { stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } });
  await long.session.start();
  await long.session.submit("bounce it");
  assert(!long.events.some((event) => event.type === "error"), JSON.stringify(long.events.filter((event) => event.type === "error")));
  assert.equal((long.events.find((event) => event.type === "turn-complete") as { result: TurnResult } | undefined)?.result.stopReason, "completed");
  await long.session.close();

  const quiet = harness({ idleTimeoutMs: 40, run: async (_input, signal) => {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 400); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); });
    return { stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  } });
  await quiet.session.start();
  await quiet.session.submit("hello");
  assert(quiet.events.some((event) => event.type === "error" && /without progress/.test(event.message)), "silence still stops an answer");
  await quiet.session.close();
});
