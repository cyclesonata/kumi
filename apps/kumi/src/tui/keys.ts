/**
 * Decodes what a terminal sends in raw mode: typed text, keys with modifiers (xterm and
 * CSI u encodings), bracketed pastes, SGR mouse reports and focus changes. Sequences can
 * arrive split across reads; a lone Escape is only a key once nothing follows it.
 */

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type InputEvent =
  | ({ type: "key"; name: string } & Modifiers)
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | ({ type: "mouse"; action: "press" | "release" | "drag" | "move" | "wheel"; button: "left" | "middle" | "right" | "none"; direction?: "up" | "down"; x: number; y: number } & Modifiers)
  | { type: "focus"; focused: boolean };

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const ARROWS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const SS3: Record<string, string> = { ...ARROWS, P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Record<number, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};
const NONE: Modifiers = { ctrl: false, alt: false, shift: false };

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) + meta(8), meta read as alt. */
function modifiers(parameter: string | undefined): Modifiers {
  const bits = Math.max(0, (Number(parameter ?? 1) || 1) - 1);
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2) || Boolean(bits & 8), ctrl: Boolean(bits & 4) };
}

const lines = (text: string) => text.replace(/\r\n?/g, "\n");

export class InputParser {
  private buffer = "";
  private pasted: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emit: (event: InputEvent) => void, private readonly escapeDelayMs = 25) {}

  push(chunk: string): void {
    this.cancelTimer();
    // Terminals without bracketed paste deliver a multi-line paste in one read; Enter
    // inside it must not send the message.
    if (this.pasted === undefined && !this.buffer && !chunk.includes("\u001b") && /[\r\n][^\r\n]/.test(chunk)) {
      this.emit({ type: "paste", text: lines(chunk) });
      return;
    }
    this.buffer += chunk;
    this.parse(false);
  }

  /** Stop the pending Escape timer; call when input ends. */
  dispose(): void {
    this.cancelTimer();
  }

  private parse(timedOut: boolean): void {
    while (this.buffer) {
      if (this.pasted !== undefined) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          let keep = 0;
          for (let length = Math.min(PASTE_END.length - 1, this.buffer.length); length > 0; length--) {
            if (this.buffer.endsWith(PASTE_END.slice(0, length))) { keep = length; break; }
          }
          this.pasted += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return;
        }
        this.pasted += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.emit({ type: "paste", text: lines(this.pasted) });
        this.pasted = undefined;
        continue;
      }
      const code = this.buffer.charCodeAt(0);
      if (code === 0x1b) {
        const used = this.escape(timedOut);
        if (used === 0) {
          this.timer = setTimeout(() => { this.timer = undefined; this.parse(true); }, this.escapeDelayMs);
          return;
        }
        this.buffer = this.buffer.slice(used);
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        this.control(this.buffer[0]!, NONE);
        this.buffer = this.buffer.slice(1);
        continue;
      }
      let end = 1;
      while (end < this.buffer.length) {
        const next = this.buffer.charCodeAt(end);
        if (next < 0x20 || next === 0x7f) break;
        end++;
      }
      this.emit({ type: "text", text: this.buffer.slice(0, end) });
      this.buffer = this.buffer.slice(end);
    }
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private key(name: string, mods: Partial<Modifiers> = {}): void {
    this.emit({ type: "key", name, ...NONE, ...mods });
  }

  /** Characters consumed from an escape at the start of the buffer, or 0 to wait for more. */
  private escape(timedOut: boolean): number {
    const buffer = this.buffer;
    if (buffer.length === 1) {
      if (!timedOut) return 0;
      this.key("escape");
      return 1;
    }
    const second = buffer[1]!;
    if (second === "[") return this.csi(timedOut);
    if (second === "O") {
      if (buffer.length === 2 && !timedOut) return 0;
      const name = buffer.length > 2 ? SS3[buffer[2]!] : undefined;
      if (name) { this.key(name); return 3; }
      this.key("o", { alt: true, shift: true });
      return 2;
    }
    if (second === "\u001b") { this.key("escape"); return 1; }
    const code = second.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      this.control(second, { ...NONE, alt: true });
      return 2;
    }
    const character = String.fromCodePoint(buffer.codePointAt(1)!);
    const lower = character.toLowerCase();
    this.key(lower, { alt: true, shift: lower !== character });
    return 1 + character.length;
  }

  private csi(timedOut: boolean): number {
    const buffer = this.buffer;
    let index = 2;
    while (index < buffer.length) {
      const code = buffer.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) break;
      index++;
    }
    if (index >= buffer.length) {
      if (!timedOut && buffer.length < 64) return 0;
      return buffer.length; // truncated or garbled; drop it rather than type it
    }
    const params = buffer.slice(2, index);
    const final = buffer[index]!;
    const length = index + 1;
    if (buffer.startsWith(PASTE_START)) { this.pasted = ""; return length; }
    if (params === "201" && final === "~") return length;
    if (params.startsWith("<") && (final === "M" || final === "m")) { this.mouse(params.slice(1), final === "M"); return length; }
    if (params === "" && (final === "I" || final === "O")) { this.emit({ type: "focus", focused: final === "I" }); return length; }
    if (final === "Z") { this.key("tab", { shift: true }); return length; }
    const parts = params.split(";");
    if (ARROWS[final]) { this.key(ARROWS[final]!, modifiers(parts[1])); return length; }
    if ("PQRS".includes(final)) { this.key(SS3[final]!, modifiers(parts[1])); return length; }
    if (final === "~") {
      const number = Number(parts[0]);
      if (number === 27 && parts.length >= 3) this.codeKey(Number(parts[2]), modifiers(parts[1]));
      else if (TILDE[number]) this.key(TILDE[number]!, modifiers(parts[1]));
      return length;
    }
    if (final === "u") {
      const code = Number(parts[0]!.split(":")[0]);
      const [mods, event] = (parts[1] ?? "1").split(":");
      if (event !== "3") this.codeKey(code, modifiers(mods));
      return length;
    }
    return length; // an unknown sequence is ignored, never typed
  }

  private codeKey(code: number, mods: Modifiers): void {
    const named: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace", 8: "backspace" };
    if (named[code]) { this.key(named[code]!, mods); return; }
    if (!Number.isInteger(code) || code < 32) return;
    const character = String.fromCodePoint(code);
    if (!mods.ctrl && !mods.alt) this.emit({ type: "text", text: mods.shift ? character.toUpperCase() : character });
    else this.key(code === 32 ? "space" : character.toLowerCase(), mods);
  }

  private control(character: string, mods: Modifiers): void {
    switch (character) {
      case "\r": this.key("enter", mods); return;
      case "\n": this.key("j", { ...mods, ctrl: true }); return;
      case "\t": this.key("tab", mods); return;
      case "\u007f":
      case "\b": this.key("backspace", mods); return;
      case "\u0000": this.key("space", { ...mods, ctrl: true }); return;
    }
    const code = character.charCodeAt(0);
    if (code >= 1 && code <= 26) { this.key(String.fromCharCode(code + 96), { ...mods, ctrl: true }); return; }
    const symbols: Record<number, string> = { 0x1c: "\\", 0x1d: "]", 0x1e: "^", 0x1f: "_" };
    if (symbols[code]) this.key(symbols[code]!, { ...mods, ctrl: true });
  }

  private mouse(params: string, pressed: boolean): void {
    const [bits = 0, column = 1, row = 1] = params.split(";").map(Number);
    const mods = { shift: Boolean(bits & 4), alt: Boolean(bits & 8), ctrl: Boolean(bits & 16) };
    const x = column - 1;
    const y = row - 1;
    if (bits & 64) {
      if ((bits & 3) < 2) this.emit({ type: "mouse", action: "wheel", button: "none", direction: bits & 1 ? "down" : "up", x, y, ...mods });
      return;
    }
    const button = (["left", "middle", "right", "none"] as const)[bits & 3]!;
    const action = bits & 32 ? (button === "none" ? "move" : "drag") : pressed ? "press" : "release";
    this.emit({ type: "mouse", action, button, x, y, ...mods });
  }
}
