import type { WebEvent } from "@kumi/runtime";

/** Incremental terminal sanitizer: escape sequences and secret prefixes may span chunks. */
export class StreamingText {
  private state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  private pending = "";
  constructor(private readonly secrets: readonly string[] = []) {}

  push(input: string): string {
    let clean = "";
    for (const character of input) {
      const code = character.codePointAt(0)!;
      if (this.state === "string") {
        if (code === 7 || code === 0x9c) this.state = "text";
        else if (code === 27) this.state = "string-escape";
        continue;
      }
      if (this.state === "string-escape") {
        this.state = character === "\\" || code === 7 ? "text" : code === 27 ? "string-escape" : "string";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 27) this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        this.state = character === "[" ? "csi" : ["]", "P", "^", "_", "X"].includes(character) ? "string" : code === 27 ? "escape" : "text";
        continue;
      }
      if (code === 27) { this.state = "escape"; continue; }
      if (code === 0x9b) { this.state = "csi"; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = "string"; continue; }
      if (character === "\n") clean += character;
      else if (character === "\t") clean += "    ";
      else if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && !/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(character)) clean += character;
    }
    this.pending += clean;
    for (const secret of this.secrets) if (secret) this.pending = this.pending.replaceAll(secret, "[redacted]");
    let retain = 0;
    for (const secret of this.secrets) {
      for (let length = Math.min(secret.length - 1, this.pending.length); length > retain; length--) {
        if (this.pending.endsWith(secret.slice(0, length))) { retain = length; break; }
      }
    }
    const visible = this.pending.slice(0, this.pending.length - retain);
    this.pending = retain ? this.pending.slice(-retain) : "";
    return visible;
  }
  finish(): string { const text = this.pending; this.discard(); return text; }
  discard(): void { this.pending = ""; this.state = "text"; }
}
export function sanitizeText(text: string, secrets: readonly string[] = []): string {
  const stream = new StreamingText(secrets); return stream.push(text) + stream.finish();
}

/**
 * A search or a page Kumi read, in a line's words: "Searched the web for", “the words”, "8 results";
 * "Read", “its title”, "where it is · what it is". `clean` makes a page's words safe to show.
 */
export function webWords(event: WebEvent, clean: (text: string, max: number) => string): { lead: string; title: string; detail: string } {
  if (event.action === "searched") {
    const results = event.results ?? 0;
    const noun = event.where === "github" ? (results === 1 ? "repository" : "repositories") : results === 1 ? "result" : "results";
    return { lead: `Searched ${event.where === "github" ? "GitHub" : "the web"} for`, title: `“${clean(event.title, 120)}”`, detail: results ? `${results} ${noun}` : "nothing found" };
  }
  let place = "";
  let path = "";
  try { const url = new URL(event.url ?? ""); place = url.hostname.replace(/^www\./, ""); path = url.pathname.length > 1 ? url.pathname : ""; } catch { /* no address */ }
  const titled = Boolean(event.title) && event.title !== event.url;
  return { lead: "Read", title: titled ? `“${clean(event.title, 120)}”` : clean(`${place}${path}`, 120),
    detail: [titled ? place : "", event.kind && event.kind !== "a page" ? event.kind : "", event.files !== undefined ? `${event.files} ${event.files === 1 ? "file" : "files"}` : ""]
      .filter(Boolean).join(" · ") };
}
