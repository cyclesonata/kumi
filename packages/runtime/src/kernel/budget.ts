/**
 * Keeps a conversation within what a model can take. Live reads go stale as the producer works, so
 * they go first: earlier turns' larger tool results shrink to their opening and a note, and the Live
 * observation attached to earlier requests is dropped (the producer's words stay). Only when that
 * isn't enough do the earliest exchanges go. Clearing happens past thresholds, not on every request,
 * so providers' prompt caches keep working in between.
 */
import type { LanguageModelV4Message } from "@ai-sdk/provider";

export interface ContextBudget {
  /** Bytes of conversation (as JSON, roughly 3 per token) past which earlier turns are cleared. */
  clearAt: number;
  /** Bytes never sent: past this, all earlier reads and then this turn's older ones are cleared, then the earliest exchanges dropped. */
  limit: number;
}

/** Roughly 50k and 130k tokens, leaving room for instructions and tools in every supported model's window. */
export const DEFAULT_BUDGET: ContextBudget = { clearAt: 160 * 1024, limit: 400 * 1024 };

/** How the session attaches each turn's Live observation to the producer's words. */
export const OBSERVATION_MARKER = "\n\n<current_observation_untrusted>";
/** Starts the first kept message once the earliest exchanges are gone. */
export const SHORTENED = "[Kumi removed the earlier part of this conversation to save room.]\n\n";
const CLEARED = " … [Kumi cleared the rest of this earlier result to save room; read Live again if you need it.]";
/** Results this small stay whole: change confirmations, refusals, short answers. */
const SMALL = 1024;
/** What's kept of a cleared result; change results start with what changed. */
const HEAD = 200;
/** What an image costs, as bytes of conversation: a 1280×720 frame is about 1.2k tokens. */
const IMAGE_BYTES = 4 * 1024;
/** The most images a request carries; past this, this turn's earliest are put away. */
export const MAX_IMAGES = 40;
const putAway = (count: number) => `[${count === 1 ? "An image was" : `${count} images were`} shown here; ${count === 1 ? "it's" : "they're"} no longer attached (the tool shows ${count === 1 ? "it" : "them"} again when asked).]`;

/** Bytes as sent, with each image counted at what it costs a model rather than its size. */
const bytes = (value: unknown) => {
  let images = 0;
  const json = JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? (images++, "") : item));
  return Buffer.byteLength(json) + images * IMAGE_BYTES;
};

type ToolContent = Extract<LanguageModelV4Message, { role: "tool" }>["content"][number];
type Output = Extract<ToolContent, { type: "tool-result" }>["output"];
const imageCount = (output: Output) => (output.type === "content" ? output.value.filter((item) => item.type === "file").length : 0);
/** A result's words, with a line where its images were. */
const wordsOf = (output: Extract<Output, { type: "content" }>) => {
  const images = imageCount(output);
  return [...output.value.flatMap((item) => (item.type === "text" ? [item.text] : [])), ...(images ? [putAway(images)] : [])].join("\n");
};

/**
 * The messages with the images tool results showed put away, all but the latest `keep`: a result
 * keeps its words and says how many images it had. The same array when nothing changed.
 */
export function putAwayImages(messages: LanguageModelV4Message[], keep = 0): LanguageModelV4Message[] {
  const count = (message: LanguageModelV4Message) => (message.role === "tool" ? message.content.reduce((sum, part) => sum + (part.type === "tool-result" ? imageCount(part.output) : 0), 0) : 0);
  let excess = messages.reduce((sum, message) => sum + count(message), 0) - keep;
  if (excess <= 0) return messages;
  return messages.map((message) => {
    if (excess <= 0 || message.role !== "tool" || !count(message)) return message;
    const content = message.content.map((part) => {
      if (excess <= 0 || part.type !== "tool-result" || part.output.type !== "content" || !imageCount(part.output)) return part;
      excess -= imageCount(part.output);
      return { ...part, output: { type: "text" as const, value: wordsOf(part.output) } };
    });
    return { ...message, content };
  });
}
const lastIndex = (messages: readonly LanguageModelV4Message[], role: LanguageModelV4Message["role"]) => {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === role) return index;
  return -1;
};
/** Where the turn before this one starts: its opening message carries the Live observation, which steering doesn't. */
function previousTurn(messages: readonly LanguageModelV4Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes(OBSERVATION_MARKER))) return index;
  }
  return lastIndex(messages, "user");
}

/** A copy of messages[0, end) with large tool results cut down and, if asked, observations removed; the same array when nothing changed. */
function clearUntil(messages: LanguageModelV4Message[], end: number, observations: boolean): LanguageModelV4Message[] {
  let changed = false;
  const cleared = messages.map((message, index): LanguageModelV4Message => {
    if (index >= end) return message;
    if (message.role === "tool") {
      let touched = false;
      const content = message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const output = part.output;
        // Words and pictures: the pictures go with the rest.
        const value = output.type === "text" || output.type === "error-text" ? output.value : output.type === "content" ? wordsOf(output) : undefined;
        if (value === undefined || (output.type !== "content" && (value.endsWith(CLEARED) || Buffer.byteLength(value) <= SMALL))) return part;
        touched = true;
        const kept = value.endsWith(CLEARED) || Buffer.byteLength(value) <= SMALL ? value : value.slice(0, HEAD).replace(/[\uD800-\uDBFF]$/, "") + CLEARED;
        return { ...part, output: output.type === "content" ? { type: "text" as const, value: kept } : { ...output, value: kept } };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    }
    if (message.role === "user" && observations) {
      let touched = false;
      const content = message.content.map((part) => {
        const at = part.type === "text" ? part.text.indexOf(OBSERVATION_MARKER) : -1;
        if (part.type !== "text" || at < 0) return part;
        touched = true;
        return { ...part, text: part.text.slice(0, at) };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    }
    return message;
  });
  return changed ? cleared : messages;
}

/**
 * The earliest whole exchanges removed until what's left takes at most `room` bytes; what's kept
 * starts where the producer spoke. Nothing is kept when even the last exchange doesn't fit.
 */
export function dropEarliest<T extends { role?: unknown }>(messages: readonly T[], room: number): T[] {
  const sizes = messages.map((message) => bytes(message) + 1);
  let total = sizes.reduce((sum, size) => sum + size, 1);
  let start = 0;
  while (start < messages.length && total > room) {
    do total -= sizes[start++]!; while (start < messages.length && messages[start]!.role !== "user");
  }
  return messages.slice(start);
}

/** The conversation's first message, marked as following a removed part (once). */
export function noteShortened(messages: LanguageModelV4Message[]): LanguageModelV4Message[] {
  const [first, ...rest] = messages;
  // Saved conversations are data from disk: anything unexpected stays as it is.
  if (first?.role !== "user" || !Array.isArray(first.content)) return messages;
  const text = first.content.find((part) => part.type === "text");
  if (text?.text.startsWith(SHORTENED)) return messages;
  const content = text ? first.content.map((part) => (part === text ? { ...text, text: SHORTENED + text.text } : part))
    : [{ type: "text" as const, text: SHORTENED.trim() }, ...first.content];
  return [{ ...first, content }, ...rest];
}

/**
 * The settled history and the running turn, within the budget. Arrays come back unchanged when
 * nothing had to go; otherwise the caller keeps the result, since the clearing now belongs to the conversation.
 */
export function fit(history: LanguageModelV4Message[], turn: LanguageModelV4Message[], budget: ContextBudget): { history: LanguageModelV4Message[]; turn: LanguageModelV4Message[] } {
  // A request carries only so many images: this turn's earliest go first.
  turn = putAwayImages(turn, MAX_IMAGES);
  const turnBytes = () => bytes(turn);
  if (bytes(history) + turnBytes() <= budget.clearAt) return { history, turn };
  // Earlier turns first, keeping the one just before this whole: the producer may refer back to it.
  history = clearUntil(history, Math.max(0, previousTurn(history)), true);
  if (bytes(history) + turnBytes() <= budget.limit) return { history, turn };
  history = clearUntil(history, history.length, true);
  if (bytes(history) + turnBytes() <= budget.limit) return { history, turn };
  // This turn's older reads, keeping its latest results and the observation it started with.
  turn = clearUntil(turn, Math.max(0, lastIndex(turn, "tool")), false);
  if (bytes(history) + turnBytes() <= budget.limit) return { history, turn };
  // Then whole exchanges from the front, down to three quarters of the limit so this doesn't recur on every request.
  const kept = dropEarliest(history, Math.max(0, Math.floor(budget.limit * 0.75) - turnBytes()));
  if (kept.length === history.length) return { history, turn };
  return kept.length ? { history: noteShortened(kept), turn } : { history: [], turn: noteShortened(turn) };
}
