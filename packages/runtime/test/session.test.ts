import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSession } from "../src/core/session.js";
import type { ConnectionState, Kernel, KernelEvent, KernelFactory, Observation, SessionEvent, TurnResult } from "../src/core/contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(options: { run?: Kernel["run"]; factory?: KernelFactory; timeoutMs?: number; maxTurns?: number } = {}) {
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
    cancelGraceMs: 10, closeTimeoutMs: 25, maxTurns: options.maxTurns ?? 30,
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
  assert(h.events.some((e) => e.type === "error" && /timed out/.test(e.message)));
  await h.session.submit("recovered");
  assert.equal(h.kernels.length, 2);
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
