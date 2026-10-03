import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  JSONSchema7, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4FinishReason, LanguageModelV4FunctionTool,
  LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolCall, LanguageModelV4ToolResultOutput,
  LanguageModelV4ToolResultPart, LanguageModelV4Usage, SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { JsonObject, Kernel, KernelCheckpoint, KernelEvent, KernelOptions, KernelTool, StreamingCall, ToolImage, TranscriptLine, TurnResult, Usage } from "../core/contracts.js";
import { KumiError } from "../core/errors.js";
import { DEFAULT_BUDGET, fit, putAwayImages, transcriptOf, type ContextBudget } from "./budget.js";
import { describeFailure, MAX_RETRIES, retryDelayMs } from "./failure.js";

export interface ModelRequest {
  instructions: string;
  /** Conversation so far, without a system message; bindings place instructions where their API expects them. */
  messages: LanguageModelV4Prompt;
  tools: LanguageModelV4FunctionTool[];
  /** Stable for one kernel: provider prompt-cache routing and request correlation. */
  sessionId: string;
}

/** A configured model plus its provider-specific request shaping. The loop itself is provider-neutral. */
export interface ModelBinding {
  /** "<provider>/<model>" as configured. */
  readonly id: string;
  readonly model: LanguageModelV4;
  prepare(request: ModelRequest): LanguageModelV4CallOptions;
  /**
   * How much conversation fits beside the instructions and tools (`fixed` bytes), for a model that
   * reads less at once than the default budget assumes (one on the producer's computer). Asked
   * before every call: what the model reads may be known only once its server has answered.
   */
  budget?(fixed: number): ContextBudget;
}

/** Plain JSON, owned by Kumi: settled messages only, including provider replay metadata. */
export interface Checkpoint extends KernelCheckpoint { version: 1; messages: LanguageModelV4Message[] }

export interface AgentKernelOptions extends KernelOptions {
  binding: ModelBinding;
  /** Model calls per turn; each tool round trip is one more. A patch built knob by knob takes dozens. */
  maxSteps?: number;
  /** How much conversation to send; older Live reads are cleared first. */
  budget?: ContextBudget;
}

export interface AgentKernel extends Kernel {
  /** Queue guidance for the running turn; it enters at the next model boundary. False when idle. */
  steer(text: string): boolean;
  /**
   * A side question about the conversation so far (the turn under way included, up to its last
   * finished step), answered in one model call without tools. It never enters the conversation.
   */
  aside(question: string, signal: AbortSignal, onText: (text: string) => void): Promise<string>;
  /** Settled conversation only; an in-flight turn is never included. */
  checkpoint(): Checkpoint;
  transcript(): TranscriptLine[];
}

interface StepResult {
  content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"];
  calls: { call: LanguageModelV4ToolCall; input: JsonObject | undefined }[];
  usage: LanguageModelV4Usage;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOLS = 128;
const MAX_INSTRUCTIONS = 64 * 1024;
const MAX_STEER = 16 * 1024;
const MAX_TOOL_ERROR = 4 * 1024;
/** A tool's own answer to the producer, when it finished the request. */
const MAX_REPLY = 8 * 1024;
/** Images one tool result shows, and the media types models read. */
const MAX_TOOL_IMAGES = 16;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** Says what a side question is, ahead of its words. */
const ASIDE_NOTE = "(A side question while you work. Answer it briefly, in plain words, from what's above; use no tools. It doesn't change the request you're working on, and your answer isn't kept in the conversation.)";
/** Ends a stopped turn's kept steps, for the model and in the transcript. */
export const STOPPED_NOTE = "(Stopped before finishing. The steps above happened; the one in progress may have too, so check Live before carrying on.)";

export function createAgentKernel(options: AgentKernelOptions): AgentKernel {
  const { binding, instructions } = options;
  const maxSteps = options.maxSteps ?? 200;
  const budget = options.budget ?? DEFAULT_BUDGET;
  if (!instructions.trim() || Buffer.byteLength(instructions) > MAX_INSTRUCTIONS) throw new Error("Kernel instructions must be nonempty and at most 64 KiB.");
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer.");
  if (!Number.isSafeInteger(budget.clearAt) || !Number.isSafeInteger(budget.limit) || budget.clearAt < 1024 || budget.limit < budget.clearAt) {
    throw new Error("The context budget must clear at 1 KiB or more, with a limit at least that.");
  }
  const names = options.tools.map((tool) => tool.name);
  if (names.length > MAX_TOOLS || new Set(names).size !== names.length || names.some((name) => !TOOL_NAME.test(name))) {
    throw new Error("Tool names must be unique, at most 64 characters of [a-zA-Z0-9_-], and at most 128 tools.");
  }
  const tools = new Map<string, KernelTool>(options.tools.map((tool) => [tool.name, tool]));
  const specs: LanguageModelV4FunctionTool[] = options.tools.map((tool) => ({
    type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema as JSONSchema7,
  }));
  const sessionId = randomUUID();
  const lifetime = new AbortController();
  // What the conversation was made with besides its messages: some models' reasoning is bound to it.
  const toolsKey = createHash("sha256").update(JSON.stringify({ instructions, specs })).digest("base64url").slice(0, 22);
  // A binding that sizes the conversation to its model is told what the instructions and tools take.
  const fixed = Buffer.byteLength(instructions) + Buffer.byteLength(JSON.stringify(specs));
  const budgetNow = (): ContextBudget => (options.budget || !binding.budget ? budget : binding.budget(fixed));
  let history = options.checkpoint ? restore(options.checkpoint, binding.id, toolsKey) : [];
  /** The turn under way: guidance waiting for its next step, and what it has said and done so far. */
  let running: { steering: string[]; context?: () => LanguageModelV4Message[] } | undefined;
  let active: Promise<TurnResult> | undefined;
  let closing: Promise<void> | undefined;

  async function turn(input: string, signal: AbortSignal, emit: (event: KernelEvent) => void, state: NonNullable<typeof running>): Promise<TurnResult> {
    const { steering } = state;
    const failed = new AbortController();
    const abort = AbortSignal.any([signal, lifetime.signal, failed.signal]);
    // A throwing listener must not leave a half-delivered turn in history.
    const deliver = (event: KernelEvent) => {
      if (abort.aborted) return;
      try { emit(event); } catch { failed.abort(); }
    };
    const messages: LanguageModelV4Message[] = [user(input)];
    let spoke = false;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let reported = false;
    const settled = (stopReason: TurnResult["stopReason"]): TurnResult => ({ stopReason, ...(reported ? { usage } : {}) });
    // What this turn sends as the earlier conversation, fitted to the budget. It becomes the
    // history only when the turn settles; fitting is deterministic, so the next turn sends the same.
    let earlier = history;
    // A side question sees this turn up to its last finished step: a call still waiting for its result is left out.
    state.context = () => {
      const last = messages[messages.length - 1];
      const end = last?.role === "assistant" && last.content.some((part) => part.type === "tool-call") ? messages.length - 1 : messages.length;
      return [...earlier, ...messages.slice(0, end)];
    };
    // A stopped turn (cancelled, timed out or failed) keeps the steps it finished, each model reply
    // with all its tool results, so the conversation says what those steps changed in Live. The
    // step in progress goes; a turn that finished no tool round leaves no trace.
    // A call already running while the model writes it (a plan whose first steps are under way).
    let early = new Map<string, Early>();
    const keepFinished = () => {
      let end = messages.length;
      const last = messages[end - 1];
      if (last?.role === "assistant" && last.content.some((part) => part.type === "tool-call")) end--;
      const finished = messages.slice(0, end);
      if (finished.some((message) => message.role === "tool")) history = [...earlier, ...withoutImages(finished), { role: "assistant", content: [{ type: "text", text: STOPPED_NOTE }] }];
    };
    try {
      for (let step = 0; ; step++) {
        if (step === maxSteps) { abort.throwIfAborted(); history = [...earlier, ...withoutImages(messages)]; return settled("max-steps"); }
        const fitted = fit(earlier, messages, budgetNow());
        if (fitted.history !== earlier || fitted.turn !== messages) {
          // Kumi just changed what came before. Some providers bind a model's reasoning to the exact
          // conversation it saw (Anthropic's current models refuse the request otherwise), so the
          // reasoning goes, once: what was said, called and read stays.
          earlier = withoutReasoning(fitted.history);
          messages.splice(0, messages.length, ...withoutReasoning(fitted.turn));
        }
        const request = binding.prepare({ instructions, messages: [...earlier, ...messages], tools: specs, sessionId });
        early = new Map();
        const result = await stream(request, abort, (text) => { spoke = true; deliver({ type: "text", text }); }, early, deliver);
        add(usage, result.usage); reported = true;
        if (result.content.length) messages.push({ role: "assistant", content: result.content });
        if (result.calls.length) {
          const { results, reply } = await execute(result.calls, abort, deliver, early);
          messages.push({ role: "tool", content: results });
          // The tools finished the request and said so: their reply is the answer, with no model call to
          // write one. A quiet call (a note kept) adds nothing: it ends the turn only when this reply
          // already holds the model's answer; a model that kept a note first still gets to answer.
          const answered = result.content.some((part) => part.type === "text" && part.text.trim());
          if (reply !== undefined && !steering.length && (reply || answered)) {
            if (reply) {
              deliver({ type: "text", text: spoke ? `\n\n${reply}` : reply });
              messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
            }
            abort.throwIfAborted(); history = [...earlier, ...withoutImages(messages)]; return settled("completed");
          }
        } else if (!steering.length) { abort.throwIfAborted(); history = [...earlier, ...withoutImages(messages)]; return settled("completed"); }
        for (const text of steering.splice(0)) { messages.push(user(text)); deliver({ type: "steer", text }); }
      }
    } catch (error) {
      // A reply that broke off mid-plan: nothing more starts, and what's under way finishes first.
      if (!abort.aborted) await Promise.all([...early.values()].map((entry) => entry.call.abandon().catch(() => {})));
      keepFinished();
      if (signal.aborted || lifetime.signal.aborted) return settled("cancelled");
      if (failed.signal.aborted) throw new KumiError("output", "Inference output could not be delivered; the rest of the answer was dropped.");
      throw describeFailure(error, binding.id);
    }
  }

  /**
   * One model call. Retries up to MAX_RETRIES times, only before any output has escaped this step: text shown, or a
   * streaming call's work begun. A reply's first call whose tool can stream starts as it's written.
   */
  async function stream(request: LanguageModelV4CallOptions, abort: AbortSignal, onText: (text: string) => void,
    early: Map<string, Early>, deliver: (event: KernelEvent) => void): Promise<StepResult> {
    for (let attempt = 0; ; attempt++) {
      let delivered = false;
      let calls = 0;
      const input: InputStream = {
        start(id, name) {
          const tool = tools.get(name);
          if (calls++ === 0 && tool?.stream) {
            const entry: Early = { name, begun: 0, call: undefined as unknown as StreamingCall };
            entry.call = tool.stream(abort, () => {
              if (entry.begun) return;
              entry.begun = performance.now();
              deliver({ type: "tool-start", id, name });
            });
            early.set(id, entry);
          }
          deliver({ type: "tool-input", id, name });
        },
        delta(id, delta) { early.get(id)?.call.push(delta); },
      };
      try {
        const { stream: parts } = await binding.model.doStream({ ...request, abortSignal: abort });
        const result = await consume(parts, abort, (text) => { delivered = true; onText(text); }, input);
        // A call that began but never arrived whole is settled, not left running.
        for (const [id, entry] of early) {
          if (result.calls.some(({ call }) => call.toolCallId === id)) continue;
          await entry.call.abandon().catch(() => {});
          early.delete(id);
        }
        return result;
      } catch (error) {
        const escaped = delivered || [...early.values()].some((entry) => entry.call.started);
        const wait = attempt < MAX_RETRIES && !escaped && !abort.aborted ? retryDelayMs(error, attempt) : undefined;
        if (wait === undefined) throw error;
        // Nothing began, so the retry starts clean.
        await Promise.all([...early.values()].map((entry) => entry.call.abandon().catch(() => {})));
        early.clear();
        await delay(wait, undefined, { signal: abort });
      }
    }
  }

  /**
   * Runs a step's calls in order. `reply` is set when all succeeded and some finished the request, or
   * every call was quiet (an empty reply: done, nothing to add); then no model reply follows. A call
   * that started while it was written finishes with its whole input.
   */
  async function execute(calls: StepResult["calls"], abort: AbortSignal, deliver: (event: KernelEvent) => void, early: Map<string, Early>): Promise<{ results: LanguageModelV4ToolResultPart[]; reply?: string }> {
    const results: LanguageModelV4ToolResultPart[] = [];
    const replies: string[] = []; let failed = false; let quiet = 0;
    for (const { call, input } of calls) {
      abort.throwIfAborted();
      const streamed = early.get(call.toolCallId);
      const started = streamed?.begun || performance.now();
      if (!streamed?.begun) deliver({ type: "tool-start", id: call.toolCallId, name: call.toolName });
      // A streamed call that hadn't begun (its first step waiting for the next, to batch them) begins in
      // finish: it's started now, so beginning there doesn't say so a second time.
      if (streamed && !streamed.begun) streamed.begun = started;
      const tool = tools.get(call.toolName);
      let outcome: { text: string; isError: boolean; images?: readonly ToolImage[] };
      if (!tool) outcome = { text: `Unknown tool ${JSON.stringify(call.toolName.slice(0, 64))}; use only the supplied tools.`, isError: true };
      else if (!input && !streamed) outcome = { text: "Tool arguments must be a JSON object.", isError: true };
      else {
        try {
          const result = await untilAborted(streamed ? streamed.call.finish(input) : tool.execute(input!, abort), abort);
          outcome = { text: result.text, isError: Boolean(result.isError), ...(result.images?.length ? { images: result.images } : {}) };
          if (!outcome.isError && typeof result.reply === "string") {
            if (result.reply.trim()) replies.push(result.reply.trim().slice(0, MAX_REPLY)); else quiet++;
          }
        } catch (error) {
          abort.throwIfAborted();
          outcome = { text: (error instanceof Error ? error.message : "Tool failed").slice(0, MAX_TOOL_ERROR), isError: true };
        }
      }
      abort.throwIfAborted();
      failed ||= outcome.isError;
      deliver({ type: "tool-end", id: call.toolCallId, name: call.toolName, isError: outcome.isError, elapsedMs: Math.round(performance.now() - started) });
      results.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: toolOutput(outcome) });
    }
    return { results, ...(!failed && replies.length ? { reply: replies.join("\n\n") } : !failed && quiet === calls.length ? { reply: "" } : {}) };
  }

  return {
    run(input, signal, emit) {
      if (closing) return Promise.reject(new Error("Kernel is closed"));
      if (running) return Promise.reject(new Error("Kernel is busy; cancel first"));
      if (signal.aborted) return Promise.resolve({ stopReason: "cancelled" });
      const state = running = { steering: [] as string[] };
      active = turn(input, signal, emit, state).finally(() => { running = undefined; active = undefined; });
      return active;
    },
    steer(text) {
      if (!running || closing || !text.trim() || Buffer.byteLength(text) > MAX_STEER) return false;
      running.steering.push(text);
      return true;
    },
    async aside(question, signal, onText) {
      if (closing) throw new Error("Kernel is closed");
      const words = question.trim();
      if (!words || Buffer.byteLength(words) > MAX_STEER) throw new KumiError("request", "Ask a side question of at most 16 KiB.");
      const context = running?.context?.() ?? history;
      const fitted = fit(context, [user(`${ASIDE_NOTE}\n\n${words}`)], budgetNow());
      // The conversation in plain words, its calls and their results written out: then no tools are
      // offered at all, which every provider takes (some can't be told "none" with calls in the conversation).
      const messages = plainWords([...fitted.history, ...fitted.turn]);
      const request = binding.prepare({ instructions, messages, tools: [], sessionId });
      const abort = AbortSignal.any([signal, lifetime.signal]);
      for (let attempt = 0; ; attempt++) {
        let delivered = false;
        try {
          const { stream: parts } = await binding.model.doStream({ ...request, abortSignal: abort });
          const result = await consume(parts, abort, (text) => { delivered = true; onText(text); });
          return result.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
        } catch (error) {
          const wait = attempt < MAX_RETRIES && !delivered && !abort.aborted ? retryDelayMs(error, attempt) : undefined;
          if (wait === undefined) throw abort.aborted || error instanceof KumiError ? error : describeFailure(error, binding.id);
          await delay(wait, undefined, { signal: abort });
        }
      }
    },
    checkpoint() {
      if (running) throw new Error("Kernel is busy; checkpoint between turns");
      return { version: 1, messages: structuredClone(history), origin: binding.id, tools: toolsKey };
    },
    transcript() { return transcriptOf(history); },
    close() {
      return closing ??= (async () => { lifetime.abort(); await active?.catch(() => {}); })();
    },
  };
}

/** Longest a call's input or result runs in a side question's plain-words copy of the conversation. */
const PLAIN_PART = 4 * 1024;

/**
 * The conversation as words only, for a side question: what was said, each tool call as "[called
 * name {input}]", each result as "[name returned: …]" (from the producer's side), reasoning and
 * replay metadata left out.
 */
export function plainWords(messages: readonly LanguageModelV4Message[]): LanguageModelV4Message[] {
  const clip = (text: string) => (text.length > PLAIN_PART ? `${text.slice(0, PLAIN_PART)}…` : text);
  const said = (role: "user" | "assistant", text: string): LanguageModelV4Message[] => (text.trim() ? [{ role, content: [{ type: "text", text }] }] : []);
  return messages.flatMap((message): LanguageModelV4Message[] => {
    if (message.role === "system") return [];
    if (message.role === "tool") {
      return said("user", message.content.map((part) => (part.type === "tool-result" ? `[${part.toolName} returned: ${clip(outputWords(part.output))}]` : "")).filter(Boolean).join("\n"));
    }
    if (message.role === "assistant") {
      return said("assistant", message.content.map((part) => (part.type === "text" ? part.text : part.type === "tool-call" ? `[called ${part.toolName} ${clip(JSON.stringify(part.input))}]` : "")).filter(Boolean).join("\n"));
    }
    return said("user", message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
  });
}

function outputWords(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
  if (output.type === "content") return output.value.map((item) => (item.type === "text" ? item.text : "")).filter(Boolean).join("\n");
  return "";
}

/** Assemble one streamed response into replayable assistant content, preserving provider metadata. */
/** A call's input as the model writes it. */
interface InputStream { start(id: string, name: string): void; delta(id: string, delta: string): void }
/** A reply's first call, running while it's written; `begun` is when its work started (0 before). */
interface Early { name: string; begun: number; call: StreamingCall }

async function consume(stream: ReadableStream<LanguageModelV4StreamPart>, abort: AbortSignal, onText: (text: string) => void, input?: InputStream): Promise<StepResult> {
  type Block = { type: "text" | "reasoning"; text: string; metadata?: SharedV4ProviderMetadata } | { type: "tool-call"; call: LanguageModelV4ToolCall };
  const blocks: Block[] = [];
  const open = new Map<string, Extract<Block, { text: string }>>();
  const block = (type: "text" | "reasoning", id: string, metadata: SharedV4ProviderMetadata | undefined) => {
    let found = open.get(`${type}:${id}`);
    if (!found) { found = { type, text: "" }; open.set(`${type}:${id}`, found); blocks.push(found); }
    if (metadata) found.metadata = merge(found.metadata, metadata);
    return found;
  };
  let finish: { usage: LanguageModelV4Usage; finishReason: LanguageModelV4FinishReason } | undefined;
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  abort.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value: part } = await reader.read();
      abort.throwIfAborted();
      if (done) break;
      switch (part.type) {
        case "text-start": case "text-end": block("text", part.id, part.providerMetadata); break;
        case "text-delta": {
          block("text", part.id, part.providerMetadata).text += part.delta;
          if (part.delta) onText(part.delta);
          break;
        }
        case "reasoning-start": case "reasoning-end": block("reasoning", part.id, part.providerMetadata); break;
        case "reasoning-delta": block("reasoning", part.id, part.providerMetadata).text += part.delta; break;
        case "tool-input-start": if (!part.providerExecuted) input?.start(part.id, part.toolName); break;
        case "tool-input-delta": if (part.delta) input?.delta(part.id, part.delta); break;
        case "tool-call": if (!part.providerExecuted) blocks.push({ type: "tool-call", call: part }); break;
        case "finish": finish = { usage: part.usage, finishReason: part.finishReason }; break;
        case "error": throw part.error ?? new KumiError("provider", "The provider reported a stream error.");
        default: break;
      }
    }
  } finally {
    abort.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (!finish) throw new KumiError("protocol", "The model response ended before it finished; the turn was discarded.");
  const reason = finish.finishReason.unified;
  if (reason === "error") throw new KumiError("provider", "The provider ended the response with an error.");
  if (reason === "content-filter") throw new KumiError("provider", "The provider's content filter stopped the response.");
  const content: StepResult["content"] = [];
  const calls: StepResult["calls"] = [];
  for (const item of blocks) {
    if (item.type === "tool-call") {
      const input = parseArguments(item.call.input);
      calls.push({ call: item.call, input });
      content.push({ type: "tool-call", toolCallId: item.call.toolCallId, toolName: item.call.toolName, input: input ?? {},
        ...(item.call.providerMetadata ? { providerOptions: item.call.providerMetadata } : {}) });
    } else if (item.text || (item.type === "reasoning" && item.metadata)) {
      // Reasoning may carry only encrypted/signature metadata; providers need it replayed verbatim.
      content.push({ type: item.type, text: item.text, ...(item.metadata ? { providerOptions: item.metadata } : {}) });
    }
  }
  return { content, calls, usage: finish.usage };
}

function parseArguments(raw: string): JsonObject | undefined {
  try {
    const value: unknown = raw.trim() ? JSON.parse(raw) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
  } catch { return undefined; }
}

function merge(current: SharedV4ProviderMetadata | undefined, next: SharedV4ProviderMetadata): SharedV4ProviderMetadata {
  const merged: SharedV4ProviderMetadata = { ...current };
  for (const [provider, values] of Object.entries(next)) merged[provider] = { ...merged[provider], ...values };
  return merged;
}

function add(total: Usage, usage: LanguageModelV4Usage) {
  total.inputTokens += usage.inputTokens.total ?? 0;
  total.outputTokens += usage.outputTokens.total ?? 0;
  total.cacheReadTokens += usage.inputTokens.cacheRead ?? 0;
  total.cacheWriteTokens += usage.inputTokens.cacheWrite ?? 0;
}

function user(text: string): LanguageModelV4Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function restore(checkpoint: KernelCheckpoint, model: string, tools: string): LanguageModelV4Message[] {
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.messages)) throw new Error("Unsupported checkpoint version.");
  const messages = withoutImages(structuredClone(checkpoint.messages) as LanguageModelV4Message[]);
  if (!checkpoint.origin) return messages;
  // Reasoning belongs to the model that wrote it, and Claude's to the tools it saw as well: another
  // model, or other tools, continue from the words, tool calls and results. (Older saves name only
  // the provider.)
  const sameModel = checkpoint.origin === model || checkpoint.origin === model.split("/")[0];
  const sameTools = checkpoint.tools === undefined || checkpoint.tools === tools;
  return sameModel && sameTools ? messages : withoutReasoning(messages);
}

/**
 * The conversation without the models' reasoning or any provider's replay metadata: what was said,
 * the tool calls and their results. A copy; messages left with nothing in them go.
 */
export function withoutReasoning(messages: readonly LanguageModelV4Message[]): LanguageModelV4Message[] {
  const plain = <T extends { providerOptions?: unknown }>(part: T): T => { const { providerOptions: _metadata, ...rest } = part; return rest as T; };
  return messages.flatMap((message) => {
    if (message.role === "system") return [message];
    const content = (message.content as { type: string; providerOptions?: unknown }[]).filter((part) => part.type !== "reasoning").map(plain);
    return content.length ? [{ ...plain(message as { providerOptions?: unknown }), content } as LanguageModelV4Message] : [];
  });
}

/** A tool's result as the model reads it: its words, then each image after its caption. */
function toolOutput(outcome: { text: string; isError: boolean; images?: readonly ToolImage[] }): LanguageModelV4ToolResultOutput {
  if (outcome.isError) return { type: "error-text", value: outcome.text };
  const images = (outcome.images ?? []).filter((image) => IMAGE_TYPES.has(image.mediaType) && image.data.byteLength > 0).slice(0, MAX_TOOL_IMAGES);
  if (!images.length) return { type: "text", value: outcome.text };
  return { type: "content", value: [{ type: "text", text: outcome.text }, ...images.flatMap((image) => [
    ...(image.caption ? [{ type: "text" as const, text: image.caption.slice(0, 1000) }] : []),
    // A copy, as a plain byte array: a Buffer would measure (and save) as a list of numbers.
    { type: "file" as const, data: { type: "data" as const, data: Uint8Array.from(image.data) }, mediaType: image.mediaType }])] };
}

/**
 * A turn without the images its tools showed, each result saying how many it had: they served
 * that turn, and kept, they'd cost every later request (and a saved conversation) their size. The
 * reasoning written after the first goes too, since it was written seeing them. The same array
 * when there were none.
 */
export function withoutImages(messages: LanguageModelV4Message[]): LanguageModelV4Message[] {
  const cleared = putAwayImages(messages);
  if (cleared === messages) return messages;
  const first = cleared.findIndex((message, index) => message !== messages[index]);
  return [...cleared.slice(0, first), ...withoutReasoning(cleared.slice(first))];
}

/** Resolve with the work, or reject as soon as the signal aborts; a late settlement is ignored. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
