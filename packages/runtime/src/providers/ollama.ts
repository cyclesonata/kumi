/**
 * Ollama's own chat API, as a model Kumi's kernel streams from.
 *
 * Not Ollama's OpenAI-compatible endpoint: that one ignores a request's context size (num_ctx), so
 * the model reads only Ollama's default window, a few thousand tokens, and Ollama silently drops the
 * start of the request to fit, which is where Kumi's instructions and tools are (about 85 KB, some
 * 25-30k tokens, with Live's full set of tools). /api/chat takes options.num_ctx, streams words,
 * thinking and tool calls, and with truncate and shift off it refuses a request that doesn't fit
 * rather than cutting it.
 */
import { randomUUID } from "node:crypto";
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4Prompt, type LanguageModelV4StreamPart, type LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import type { KumiError } from "../core/errors.js";
import { thinkSplitter } from "./compat.js";

/** How one request goes to the model, settled once its server has said what the model is. */
export interface OllamaShape {
  /** The context, in tokens, Ollama gives the model. */
  numCtx: number;
  /** Thinking on or off, or a level; left out for a model that doesn't think. */
  think?: boolean | string;
  /** What to send: tools taken out for a model that can't use them. */
  options: LanguageModelV4CallOptions;
  /** It sees pictures. */
  images: boolean;
}

export interface OllamaChatSettings {
  /** Ollama's address, e.g. http://127.0.0.1:11434. */
  baseURL: string;
  model: string;
  fetch: typeof fetch;
  shape(options: LanguageModelV4CallOptions): Promise<OllamaShape>;
  /** A failure in plain words: before the answer began, or partway through it. */
  failure(error: unknown, phase: "request" | "answer"): KumiError;
}

type Json = Record<string, unknown>;
interface OllamaMessage { role: string; content: string; images?: string[]; thinking?: string; tool_calls?: { id: string; function: { name: string; arguments: unknown } }[]; tool_name?: string; tool_call_id?: string }

const NO_IMAGE = "[An image this model can't be shown.]";
const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const base64 = (data: Uint8Array | string) => (typeof data === "string" ? data : Buffer.from(data).toString("base64"));

export function ollamaChat(settings: OllamaChatSettings): LanguageModelV4 {
  const url = `${settings.baseURL}/api/chat`;
  return {
    specificationVersion: "v4", provider: "ollama", modelId: settings.model, supportedUrls: {},
    doGenerate() { return Promise.reject(new Error("Kumi streams every answer.")); },
    async doStream(call) {
      const signal = call.abortSignal;
      const { numCtx, think, options, images } = await settings.shape(call);
      const tools = (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema } }] : []));
      const body = { model: settings.model, messages: messages(options.prompt, images), stream: true, ...(tools.length ? { tools } : {}), ...(think !== undefined ? { think } : {}),
        options: { num_ctx: numCtx }, truncate: false, shift: false };
      let response: Response;
      try { response = await settings.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }); }
      catch (error) { if (signal?.aborted) throw error; throw settings.failure(error, "request"); }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw settings.failure(new APICallError({ message: `HTTP ${response.status}`, url, requestBodyValues: {}, statusCode: response.status, responseBody: text, isRetryable: false }), "request");
      }
      return { stream: answer(response.body, signal, settings), request: { body } };
    },
  };
}

/** Kumi's conversation as Ollama's messages: a tool's result as words, each tied to its call. */
function messages(prompt: LanguageModelV4Prompt, images: boolean): OllamaMessage[] {
  return prompt.flatMap((message): OllamaMessage[] => {
    if (message.role === "system") return [{ role: "system", content: message.content }];
    if (message.role === "user") {
      const words = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const pictures = message.content.flatMap((part) => (part.type === "file" && part.mediaType.startsWith("image") && part.data.type === "data" ? [base64(part.data.data)] : []));
      if (!pictures.length) return [{ role: "user", content: words }];
      return [images ? { role: "user", content: words, images: pictures } : { role: "user", content: `${words}\n${NO_IMAGE}` }];
    }
    if (message.role === "assistant") {
      const content = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const thinking = message.content.map((part) => (part.type === "reasoning" ? part.text : "")).join("");
      const calls = message.content.flatMap((part) => (part.type === "tool-call" ? [{ id: part.toolCallId, function: { name: part.toolName, arguments: parsed(part.input) } }] : []));
      return [{ role: "assistant", content, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) }];
    }
    return message.content.flatMap((part) => (part.type === "tool-result" ? [{ role: "tool", content: words(part.output), tool_name: part.toolName, tool_call_id: part.toolCallId }] : []));
  });
}

const parsed = (input: unknown) => {
  if (typeof input !== "string") return input ?? {};
  try { return JSON.parse(input) as unknown; } catch { return {}; }
};

function words(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
  if (output.type === "execution-denied") return output.reason ?? "Not run.";
  return output.value.map((item) => (item.type === "text" ? item.text : item.type === "file" ? NO_IMAGE : "")).filter(Boolean).join("\n");
}

/** Ollama's answer, a JSON object a line, as the kernel's stream parts. */
function answer(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, settings: OllamaChatSettings): ReadableStream<LanguageModelV4StreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const think = thinkSplitter();
  let cancelled = false;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      const emit = (part: LanguageModelV4StreamPart) => { if (!cancelled) controller.enqueue(part); };
      let open: "text" | "reasoning" | undefined;
      let called = false;
      const close = () => {
        if (open === "text") emit({ type: "text-end", id: "txt-0" });
        if (open === "reasoning") emit({ type: "reasoning-end", id: "reasoning-0" });
        open = undefined;
      };
      const say = (kind: "text" | "reasoning", delta: string) => {
        if (!delta) return;
        if (open !== kind) {
          close(); open = kind;
          emit(kind === "text" ? { type: "text-start", id: "txt-0" } : { type: "reasoning-start", id: "reasoning-0" });
        }
        emit(kind === "text" ? { type: "text-delta", id: "txt-0", delta } : { type: "reasoning-delta", id: "reasoning-0", delta });
      };
      /** One line of the answer; true once it's the last. */
      const line = (raw: string): boolean => {
        let chunk: Json | undefined;
        try { chunk = object(JSON.parse(raw)); } catch { return false; }
        if (!chunk) return false;
        // Something went wrong partway (it ran out of memory, say): Ollama says so in a line of its own.
        if (typeof chunk.error === "string") throw new Error(chunk.error);
        const message = object(chunk.message) ?? {};
        if (typeof message.thinking === "string") say("reasoning", message.thinking);
        if (typeof message.content === "string" && message.content) { const split = think.push(message.content); say("reasoning", split.reasoning); say("text", split.text); }
        for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const fn = object(object(item)?.function) ?? {};
          if (typeof fn.name !== "string" || !fn.name) continue;
          const given = object(item)?.id;
          const id = typeof given === "string" && given ? given : `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const input = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
          close();
          emit({ type: "tool-input-start", id, toolName: fn.name });
          emit({ type: "tool-input-delta", id, delta: input });
          emit({ type: "tool-input-end", id });
          emit({ type: "tool-call", toolCallId: id, toolName: fn.name, input });
          called = true;
        }
        if (chunk.done !== true) return false;
        const rest = think.flush();
        say("reasoning", rest.reasoning); say("text", rest.text); close();
        const evaluated = count(chunk.prompt_eval_count); const cached = count(chunk.prompt_eval_cached_count);
        const reason = typeof chunk.done_reason === "string" ? chunk.done_reason : undefined;
        emit({ type: "finish", finishReason: { unified: called ? "tool-calls" : reason === "length" ? "length" : !reason || reason === "stop" ? "stop" : "other", raw: reason },
          usage: { inputTokens: { total: evaluated + cached, noCache: evaluated, cacheRead: cached, cacheWrite: undefined }, outputTokens: { total: count(chunk.eval_count), text: undefined, reasoning: undefined } } });
        return true;
      };
      void (async () => {
        let buffer = "";
        let finished = false;
        try {
          emit({ type: "stream-start", warnings: [] });
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (let at = buffer.indexOf("\n"); at >= 0 && !finished; at = buffer.indexOf("\n")) {
              const raw = buffer.slice(0, at).trim();
              buffer = buffer.slice(at + 1);
              if (raw) finished = line(raw);
            }
          }
          buffer += decoder.decode();
          if (!finished && buffer.trim()) finished = line(buffer.trim());
          // The connection closed before Ollama said it was done: as a dropped connection reads.
          if (!finished) throw new TypeError("terminated");
          if (!cancelled) controller.close();
        } catch (error) {
          if (cancelled) return;
          if (signal?.aborted) { controller.error(error); return; }
          close();
          emit({ type: "error", error: settings.failure(error, "answer") });
          controller.close();
        }
      })();
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason); },
  });
}
