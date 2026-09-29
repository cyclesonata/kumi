/**
 * What the producer typed, for the up arrow, kept as a shell keeps it: in a file, so it survives
 * /new, reconnecting and restarting. Secrets stay out of it as they stay off the screen: the
 * producer's own keys and tokens, and anything shaped like a key that was pasted in.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizeText } from "./text.js";

const MAX_ENTRIES = 500;
const MAX_ENTRY = 4_096;
/** Key-shaped text: providers' API keys and tokens, and long runs of letters and digits like them. */
const KEYS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g,
];
const LABELLED = /\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+/gi;

/** `text` as the history keeps it: what the screen shows, with key-shaped text taken out too. */
export function historyText(text: string, secrets: readonly string[] = []): string {
  let kept = sanitizeText(text, secrets);
  for (const pattern of KEYS) kept = kept.replace(pattern, "[redacted]");
  return kept.replace(LABELLED, "$1$2[redacted]").trim().slice(0, MAX_ENTRY);
}

export interface InputHistory {
  /** Oldest first. */
  readonly entries: readonly string[];
  add(text: string): void;
}

/** The history in `file` (JSON lines, readable only by this user); in memory only without one. */
export function openInputHistory(file: string | undefined, secrets: readonly string[] = []): InputHistory {
  let entries: string[] = [];
  if (file) {
    try {
      entries = readFileSync(file, "utf8").split("\n").flatMap((line) => {
        try { const value: unknown = JSON.parse(line); return typeof value === "string" && historyText(value, secrets) ? [historyText(value, secrets)] : []; } catch { return []; }
      }).slice(-MAX_ENTRIES);
    } catch { entries = []; }
  }
  let lines = entries.length;
  return {
    get entries() { return entries; },
    add(text) {
      const kept = historyText(text, secrets);
      if (!kept || kept === entries.at(-1)) return;
      entries.push(kept);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        // Past twice its size, the file is written again with the latest entries.
        if (++lines > 2 * MAX_ENTRIES) { writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 }); lines = entries.length; }
        else appendFileSync(file, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
      } catch { /* the history is a convenience; typing goes on without it */ }
    },
  };
}
