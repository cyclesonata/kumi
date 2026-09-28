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

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
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
        if (part.type !== "tool-result" || (part.output.type !== "text" && part.output.type !== "error-text")) return part;
        const { value } = part.output;
        if (value.endsWith(CLEARED) || Buffer.byteLength(value) <= SMALL) return part;
        touched = true;
        return { ...part, output: { ...part.output, value: value.slice(0, HEAD).replace(/[\uD800-\uDBFF]$/, "") + CLEARED } };
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
