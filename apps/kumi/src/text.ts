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
