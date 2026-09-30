/**
 * Owns the terminal while Kumi is on screen: raw input, the alternate screen, bracketed
 * paste, mouse and focus reporting, no autowrap. Restoring is idempotent and also runs on
 * process exit and before a crash is printed, so a producer is never left with a broken
 * terminal they would need to `reset`.
 */
import { writeSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { InputParser, type InputEvent } from "./keys.js";

export type TtyInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };
export type TtyOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number; fd?: number };

// \u001b[>1u asks terminals that support it (kitty, Ghostty, WezTerm, iTerm2) to report keys
// unambiguously, so Shift+Enter is distinct from Enter and Escape needs no timeout. Others ignore it.
const ENTER = "\u001b[?1049h\u001b[?7l\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[>1u";
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
export const RESTORE = "\u001b[?2026l\u001b[0m\u001b[<u\u001b[?1006l\u001b[?1002l\u001b[?1000l\u001b[?1004l\u001b[?2004l\u001b[?7h\u001b[?25h\u001b[?1049l";

export interface TtyOptions {
  input: TtyInput;
  output: TtyOutput;
  onInput: (event: InputEvent) => void;
  onResize: () => void;
  /** Mouse reporting stops the terminal's own text selection; on by default. */
  mouse?: boolean;
}

export class Tty {
  private active = false;
  private wasRaw = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly parser: InputParser;
  private readonly data = (chunk: Buffer | string) => {
    this.parser.push(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  };
  private readonly resize = () => this.options.onResize();
  private readonly emergency = () => this.restore(true);

  constructor(private readonly options: TtyOptions) {
    this.parser = new InputParser(options.onInput);
  }

  get size(): { columns: number; rows: number } {
    return { columns: Math.max(1, this.options.output.columns ?? 80), rows: Math.max(1, this.options.output.rows ?? 24) };
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const { input, output } = this.options;
    this.wasRaw = Boolean(input.isRaw);
    input.setRawMode?.(true);
    input.on("data", this.data);
    input.resume();
    output.on("resize", this.resize);
    process.on("exit", this.emergency);
    process.on("uncaughtExceptionMonitor", this.emergency);
    output.write(ENTER + (this.options.mouse === false ? "" : MOUSE_ON));
  }

  write(data: string): void {
    if (this.active && data) this.options.output.write(data);
  }

  /** Put the terminal back as it was. `sync` writes immediately, for exit and crash paths. */
  restore(sync = false): void {
    if (!this.active) return;
    this.active = false;
    const { input, output } = this.options;
    this.parser.dispose();
    input.removeListener("data", this.data);
    output.removeListener("resize", this.resize);
    process.removeListener("exit", this.emergency);
    process.removeListener("uncaughtExceptionMonitor", this.emergency);
    try {
      if (sync && typeof output.fd === "number") writeSync(output.fd, RESTORE);
      else output.write(RESTORE);
    } catch { /* the terminal may already be gone */ }
    try { input.setRawMode?.(this.wasRaw); } catch { /* likewise */ }
    input.pause();
  }
}
