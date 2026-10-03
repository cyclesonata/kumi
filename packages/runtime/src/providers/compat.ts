/**
 * Local model servers' streamed answers, mended where they part from what Kumi's OpenAI-compatible
 * client expects. Servers differ in small ways (llama.cpp's server, vLLM, LM Studio, Jan), and one
 * unexpected field would otherwise end the answer with an error the producer can't act on.
 */
import { randomUUID } from "node:crypto";

const OPEN = "<think>";
const CLOSE = "</think>";

/** How much of `text`'s end could be the start of `tag` (held back until the rest arrives). */
function partial(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) if (tag.startsWith(text.slice(-length))) return length;
  return 0;
}

/**
 * Splits a reply that writes its thinking into its words between <think> tags (servers that don't
 * separate it): what's inside goes to reasoning, the rest stays words. Only a reply that opens with
 * the tag is split, so an answer that mentions it later is left alone.
 */
export function thinkSplitter(): { push(text: string): { reasoning: string; text: string }; flush(): { reasoning: string; text: string } } {
  let state: "start" | "thinking" | "gap" | "words" = "start";
  let held = "";
  return {
    push(chunk) {
      let reasoning = "", text = "";
      let input = held + chunk;
      held = "";
      while (input) {
        if (state === "start") {
          const trimmed = input.trimStart();
          if (trimmed.startsWith(OPEN)) { state = "thinking"; input = trimmed.slice(OPEN.length); continue; }
          // Blank so far, or a tag still arriving: wait for more.
          if (!trimmed || OPEN.startsWith(trimmed)) { held = input; break; }
          state = "words";
        }
        if (state === "thinking") {
          const end = input.indexOf(CLOSE);
          if (end >= 0) { reasoning += input.slice(0, end); input = input.slice(end + CLOSE.length); state = "gap"; continue; }
          const keep = partial(input, CLOSE);
          reasoning += input.slice(0, input.length - keep);
          held = input.slice(input.length - keep);
          break;
        }
        // The blank lines between the thinking and the answer aren't part of the answer.
        if (state === "gap") { input = input.trimStart(); if (!input) break; state = "words"; }
        text += input;
        break;
      }
      return { reasoning, text };
    },
    flush() {
      const rest = held;
      held = "";
      return state === "thinking" ? { reasoning: rest, text: "" } : { reasoning: "", text: state === "gap" ? "" : rest };
    },
  };
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);

/**
 * An OpenAI-compatible stream of chat chunks, mended: a tool call without an id (or an index) gets
 * one, arguments sent as an object become the text they stand for, thinking written between
 * <think> tags moves to reasoning, and a stream that ends without saying why ends as finished.
 */
export function mendStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const think = thinkSplitter();
  /** Each call's id by its index, as first seen (or given); and the index of the call last named. */
  const ids = new Map<number, string>();
  const byId = new Map<string, number>();
  let latest: number | undefined;
  let buffer = "";
  let finished = false;
  let ended = false;
  let called = false;
  let separated = false;
  const chunk = (delta: Json, finish?: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
  const mendCall = (call: Json) => {
    const fn = object(call.function) ?? (call.function = {}) as Json;
    if (fn.arguments !== undefined && fn.arguments !== null && typeof fn.arguments !== "string") fn.arguments = JSON.stringify(fn.arguments);
    let index = typeof call.index === "number" ? call.index : undefined;
    if (index === undefined) {
      // No index: a call by its id; else a new call when it names its function, else the one before.
      const id = typeof call.id === "string" && call.id ? call.id : undefined;
      index = (id ? byId.get(id) : undefined) ?? (typeof fn.name === "string" && fn.name || latest === undefined ? ids.size : latest);
      call.index = index;
    }
    if (!ids.has(index)) {
      const id = typeof call.id === "string" && call.id ? call.id : `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      ids.set(index, id);
      byId.set(id, index);
    }
    // One id for the whole call, whatever later pieces carry.
    call.id = ids.get(index);
    latest = index;
    called = true;
  };
  const mend = (data: string): string => {
    let value: Json | undefined;
    try { value = object(JSON.parse(data)); } catch { return data; }
    const choice = object(Array.isArray(value?.choices) ? value.choices[0] : undefined);
    if (!value || !choice) return data;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finished = true;
    const delta = object(choice.delta);
    if (delta) {
      if (typeof delta.reasoning_content === "string" || typeof delta.reasoning === "string") separated = true;
      if (typeof delta.content === "string" && delta.content && !separated) {
        const { reasoning, text } = think.push(delta.content);
        delta.content = text;
        if (reasoning) delta.reasoning_content = reasoning;
      }
      if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) { const item = object(call); if (item) mendCall(item); }
    }
    return JSON.stringify(value);
  };
  // What's left of the thinking or the words, and the finish the stream never gave, once; each as an
  // event of its own (the blank line first ends any event still open).
  const ending = () => {
    if (ended) return "";
    ended = true;
    const { reasoning, text } = think.flush();
    let out = reasoning || text ? chunk({ ...(text ? { content: text } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }) : "";
    if (!finished) { finished = true; out += chunk({}, called ? "tool_calls" : "stop"); }
    return out ? `\n${out}` : "";
  };
  const line = (raw: string): string => {
    const match = /^data:\s?(.*?)(\r?)$/.exec(raw);
    if (!match) return `${raw}\n`;
    if (match[1]!.trim() === "[DONE]") return `${ending()}${raw}\n`;
    return `data: ${mend(match[1]!)}${match[2]}\n`;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      let out = "";
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { out += line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      buffer += decoder.decode();
      const out = (buffer ? line(buffer) : "") + ending();
      if (out) controller.enqueue(encoder.encode(out));
    },
  }));
}

/** A fetch whose streamed chat answers come back mended (see mendStream); everything else as it was. */
export function mendingFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    const streamed = typeof init?.body === "string" && /"stream"\s*:\s*true/.test(init.body);
    if (!response.ok || !response.body || !streamed || !/\/chat\/completions$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)) return response;
    return new Response(mendStream(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
