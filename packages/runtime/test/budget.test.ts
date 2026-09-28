import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { dropEarliest, fit, OBSERVATION_MARKER, SHORTENED } from "../src/kernel/budget.js";

const observed = (words: string) => `${words}${OBSERVATION_MARKER}\n${"o".repeat(600)}\n</current_observation_untrusted>`;
const user = (text: string): LanguageModelV4Message => ({ role: "user", content: [{ type: "text", text }] });
const said = (text: string): LanguageModelV4Message => ({ role: "assistant", content: [{ type: "text", text }] });
const called = (id: string): LanguageModelV4Message => ({ role: "assistant", content: [
  { type: "reasoning", text: "", providerOptions: { openai: { itemId: `rs_${id}`, reasoningEncryptedContent: "enc" } } },
  { type: "tool-call", toolCallId: id, toolName: "live_discover", input: { kind: "track" }, providerOptions: { openai: { itemId: `fc_${id}` } } },
] });
const result = (id: string, value: string, error = false): LanguageModelV4Message => ({ role: "tool", content: [
  { type: "tool-result", toolCallId: id, toolName: "live_discover", output: error ? { type: "error-text", value } : { type: "text", value } },
] });
const read = (tag: string, bytes = 3000) => `{"changed":"${tag}","items":[${'"x",'.repeat(Math.ceil(bytes / 4))}"end"]}`;
/** One turn: the producer asks, Kumi reads Live once, then answers. */
const exchange = (tag: string, bytes = 3000): LanguageModelV4Message[] => [user(observed(`ask ${tag}`)), called(`c_${tag}`), result(`c_${tag}`, read(tag, bytes)), said(`answer ${tag}`)];
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const outputOf = (message: LanguageModelV4Message | undefined) => {
  const part = message?.role === "tool" ? message.content[0] : undefined;
  return part?.type === "tool-result" && (part.output.type === "text" || part.output.type === "error-text") ? part.output.value : undefined;
};
const textOf = (message: LanguageModelV4Message | undefined) => (message?.role === "user" && message.content[0]?.type === "text" ? message.content[0].text : undefined);

test("under the budget nothing changes, down to the same arrays", () => {
  const history = [...exchange("a"), ...exchange("b")]; const turn = [user(observed("now"))];
  const fitted = fit(history, turn, { clearAt: 64 * 1024, limit: 128 * 1024 });
  assert.equal(fitted.history, history); assert.equal(fitted.turn, turn);
});

test("past clearAt, earlier turns' reads shrink to their opening and their observations go; the turn before stays whole", () => {
  const small = result("c_small", '{"changed":"Tempo 120 → 124","change":"c1","state":"applied"}');
  const refusal = result("c_refused", "x".repeat(900), true);
  const history = [...exchange("a"), called("c_small"), small, called("c_refused"), refusal, ...exchange("b")];
  const turn = [user(observed("now"))];
  const fitted = fit(history, turn, { clearAt: 4096, limit: 64 * 1024 });
  const cleared = outputOf(fitted.history[2])!;
  assert.match(cleared, /^\{"changed":"a","items":\["x",/);
  assert.match(cleared, /Kumi cleared the rest of this earlier result to save room; read Live again if you need it\.\]$/);
  assert.ok(Buffer.byteLength(cleared) < 400);
  assert.equal(textOf(fitted.history[0]), "ask a");
  // Small results and short refusals stay whole; calls and replay metadata are untouched.
  assert.equal(fitted.history[5], small); assert.equal(fitted.history[7], refusal);
  assert.equal(fitted.history[1], history[1]);
  // The turn just before this one, and this turn's own observation, stay as they were.
  assert.deepEqual(fitted.history.slice(8), history.slice(8));
  assert.equal(fitted.turn, turn);
  assert.equal(fitted.history.length, history.length);
});

test("a steered turn before this one is still kept whole", () => {
  const steered = [user(observed("prev")), called("c_prev"), result("c_prev", read("prev")), user("also check the drums"), said("answer prev")];
  const history = [...exchange("a"), ...steered];
  const fitted = fit(history, [user(observed("now"))], { clearAt: 4096, limit: 64 * 1024 });
  assert.match(outputOf(fitted.history[2])!, /Kumi cleared the rest/, "the turn before it is cleared");
  assert.deepEqual(fitted.history.slice(4), steered, "the steered turn keeps its read and its observation");
});

test("fitting is stable: once cleared, the same conversation comes back unchanged, so prompt caches keep working", () => {
  const budget = { clearAt: 4096, limit: 64 * 1024 };
  const once = fit([...exchange("a"), ...exchange("b"), ...exchange("c")], [user(observed("now"))], budget);
  const twice = fit(once.history, once.turn, budget);
  assert.equal(twice.history, once.history); assert.equal(twice.turn, once.turn);
});

test("past the limit, this turn's older reads are cleared too, keeping its latest results and its observation", () => {
  const turn = [user(observed("now")), called("t1"), result("t1", read("t1", 12_000)), called("t2"), result("t2", read("t2", 12_000))];
  const fitted = fit([...exchange("a")], turn, { clearAt: 4096, limit: 32 * 1024 });
  assert.match(outputOf(fitted.turn[2])!, /Kumi cleared the rest/);
  assert.equal(fitted.turn[4], turn[4]);
  assert.equal(textOf(fitted.turn[0]), textOf(turn[0]));
  assert.ok(size([...fitted.history, ...fitted.turn]) <= 32 * 1024);
});

test("when clearing isn't enough, the earliest exchanges go, with a note where the conversation now starts", () => {
  const history = Array.from({ length: 40 }, (_, index) => [user(`question ${index} ${"w".repeat(400)}`), said(`answer ${index} ${"w".repeat(400)}`)]).flat();
  const turn = [user(observed("now"))];
  const budget = { clearAt: 4096, limit: 16 * 1024 };
  const fitted = fit(history, turn, budget);
  assert.ok(fitted.history.length < history.length);
  assert.ok(size([...fitted.history, ...fitted.turn]) <= budget.limit * 0.75);
  assert.equal(fitted.history[0]?.role, "user");
  assert.ok(textOf(fitted.history[0])!.startsWith(SHORTENED));
  assert.equal(fitted.history.at(-1), history.at(-1));
  // The next request drops nothing more and doesn't note twice.
  const again = fit(fitted.history, fitted.turn, budget);
  assert.equal(again.history, fitted.history);
});

test("if no earlier exchange fits, the note goes on this turn", () => {
  const history = [user("w".repeat(20_000)), said("w".repeat(20_000))];
  const turn = [user(observed("now"))];
  const fitted = fit(history, turn, { clearAt: 4096, limit: 16 * 1024 });
  assert.deepEqual(fitted.history, []);
  assert.equal(textOf(fitted.turn[0]), SHORTENED + textOf(turn[0]));
});

test("dropEarliest keeps whole exchanges from the end, starting where the producer spoke", () => {
  const messages = [{ role: "user", n: 1 }, { role: "assistant", n: 2 }, { role: "tool", n: 3 }, { role: "user", n: 4 }, { role: "assistant", n: 5 }];
  assert.deepEqual(dropEarliest(messages, 10_000), messages);
  assert.deepEqual(dropEarliest(messages, size(messages.slice(3))), messages.slice(3));
  assert.deepEqual(dropEarliest(messages, size(messages.slice(3)) - 1), []);
});
