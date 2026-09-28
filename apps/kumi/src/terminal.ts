import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import stringWidth from "string-width";
import { since, type SessionController, type SessionEvent } from "@kumi/runtime";
import { safeError } from "./config.js";
import { KeyInput, type TerminalInput } from "./input.js";
import { sanitizeText, StreamingText } from "./text.js";

interface Options {
  controller: SessionController;
  input: TerminalInput;
  output: Writable & { isTTY?: boolean; columns?: number };
  model: string;
  mode: "live" | "inference-only";
  /** Shown once under the header, e.g. how to connect Live. */
  startupNotice?: string;
  secrets?: readonly string[];
  closeTimeoutMs?: number;
}
export interface Terminal {
  run(): Promise<number>;
  handleEvent(event: SessionEvent): void;
  interrupt(): void;
  close(): Promise<number>;
}
const HELP = "/help · /status · /undo · /refresh · /new · /quit | Ctrl-C: cancel work; idle: exit. EOF exits. No history is persisted.";

/** One synchronous render transaction at a time; Writable preserves byte ordering/backpressure. */
class Presentation {
  private tail = "";
  private prefix = "assistant> ";
  private renderedRows = 0;
  private pipeLineOpen = false;
  private closed = false;
  constructor(private readonly rl: Interface, private readonly out: Options["output"], private readonly tty: boolean) {
    rl.once("close", () => { this.closed = true; });
  }
  private readonly segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  private rows(text: string) {
    const columns = Math.max(2, this.out.columns ?? 80);
    let rows = 1; let column = 0;
    for (const { segment } of this.segments.segment(text)) {
      const width = stringWidth(segment);
      if (!width) continue;
      // A wide glyph at the final column wraps with an extra blank cell.
      if (column + width > columns) { rows++; column = 0; }
      column += width;
    }
    return rows;
  }
  private frame(stable: string, partial = "", restoreInput = true) {
    if (!this.tty) { this.out.write(stable + partial); return; }
    if (this.closed) {
      const rows = this.renderedRows + this.rl.getCursorPos().rows;
      this.out.write(`\r${rows ? `\u001b[${rows}A` : ""}\u001b[0J${stable}${partial}`);
      this.renderedRows = 0;
      return;
    }
    const line = this.rl.line; const cursor = this.rl.cursor;
    // Use documented readline editing operations to clear its wrapped buffer.
    // Restore suffix, Home, then prefix: the exact original cursor is preserved,
    // including wide/combining characters, without mutating readonly properties.
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.out.write(`\r${this.renderedRows ? `\u001b[${this.renderedRows}A` : ""}\u001b[0J${stable}${partial ? `${partial}\n` : ""}`);
    this.renderedRows = partial ? this.rows(partial) : 0;
    if (!restoreInput) return;
    this.rl.prompt(true);
    if (line) {
      this.rl.write(line.slice(cursor));
      this.rl.write(null, { ctrl: true, name: "a" });
      this.rl.write(line.slice(0, cursor));
    }
  }
  text(text: string) {
    if (!text) return;
    if (!this.tty) {
      this.out.write((this.pipeLineOpen ? "" : this.prefix) + text);
      this.pipeLineOpen = !text.endsWith("\n"); this.prefix = "";
      return;
    }
    this.tail += text;
    const lines = this.tail.split("\n");
    const complete = lines.slice(0, -1);
    const stable = complete.map((line, index) => `${index === 0 ? this.prefix : ""}${line}\n`).join("");
    this.tail = lines.at(-1)!;
    if (complete.length) this.prefix = "";
    this.frame(stable, this.tail ? this.prefix + this.tail : "");
  }
  notice(text: string, final = false) {
    if (!this.tty) {
      this.out.write(`${this.pipeLineOpen ? "\n" : ""}${text}\n`);
      this.pipeLineOpen = false;
    } else {
      this.frame(`${this.tail ? this.prefix + this.tail + "\n" : ""}${text}\n`, "", !final);
      this.tail = "";
    }
    this.prefix = "assistant> ";
  }
  submitted() {
    // readline has already committed the user's line and moved down. Any displayed
    // assistant fragment is now stable above it; do not redraw/duplicate that fragment.
    this.tail = ""; this.renderedRows = 0; this.prefix = "assistant> ";
  }
}

export function createTerminal(options: Options): Terminal {
  const { controller, input, output } = options;
  const secrets = options.secrets ?? [];
  const text = new StreamingText(secrets);
  let rl: Interface | undefined;
  let keys: KeyInput | undefined;
  let presentation: Presentation | undefined;
  let started = false;
  let closing = false;
  let cancelling = false;
  let suppressOutput = false;
  let displayedBytes = 0;
  let startedAt = performance.now();
  let firstTextMs: number | undefined;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const line = (message: string) => sanitizeText(message, secrets).replaceAll("\n", " ").slice(0, 2048);
  const notice = (message: string) => { if (!output.destroyed) presentation?.notice(line(message)); };
  const reportError = (error: unknown) => notice(`[error] ${safeError(error, secrets)}`);
  const busy = () => ["running", "cancelling"].includes(controller.status().state);

  async function finish(code = 0): Promise<number> {
    if (closing) return done;
    closing = true; suppressOutput = true; text.discard();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([controller.close(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded")), options.closeTimeoutMs ?? 6_000);
      })]);
      if (!output.destroyed) presentation?.notice("Kumi closed. Ephemeral conversation discarded.", true);
    } catch (error) {
      code = 1;
      if (!output.destroyed) presentation?.notice(line(`[error] ${safeError(error, secrets)}`), true);
    }
    finally {
      clearTimeout(timer);
      rl?.close(); keys?.destroy(); input.pause();
      resolveDone(code);
    }
    return done;
  }
  function interrupt() {
    if (closing) return;
    if (!busy()) { void finish(); return; }
    if (cancelling) return;
    cancelling = true; suppressOutput = true; text.discard();
    notice("[cancelling] Cancelling current work; Live transport is untouched.");
    void Promise.resolve().then(() => controller.cancel()).catch(reportError).finally(() => { cancelling = false; });
  }
  async function submitted(inputLine: string) {
    if (closing) return;
    presentation?.submitted();
    const command = inputLine.trim();
    if (!command) { if (input.isTTY && output.isTTY) rl?.prompt(true); return; }
    if (command === "/quit") { await finish(); return; }
    if (command === "/help") { notice(HELP); return; }
    if (command === "/status") {
      const status = controller.status();
      notice(`[status] ${status.state}; MCP/Live: ${status.connection}; turns ${status.turns}/${status.maxTurns}; ${status.observation ?? "No current Live observation"}`);
      return;
    }
    if (busy()) { notice("[busy] Busy; cancel first. No second turn was submitted."); return; }
    try {
      if (command === "/undo") {
        const change = await controller.undo();
        if (change) notice(change.state === "undone" ? `[undo] Undid: ${change.title}` : `[undo] Kept: ${change.title}. ${change.note ?? ""}`.trim());
      } else if (command === "/refresh") await controller.refresh();
      else if (command === "/new") await controller.newConversation();
      else if (command.startsWith("/")) notice("Unknown command. Use /help.");
      else await controller.submit(inputLine);
    } catch (error) { if (!closing) reportError(error); }
    finally { if (!closing && input.isTTY && output.isTTY) rl?.prompt(true); }
  }
  function handleEvent(event: SessionEvent) {
    if (closing) return;
    switch (event.type) {
      case "state":
        if (event.state === "running") { suppressOutput = false; displayedBytes = 0; text.discard(); startedAt = performance.now(); firstTextMs = undefined; }
        if (event.state === "cancelling") { suppressOutput = true; text.discard(); }
        break;
      case "connection": notice(`[connection] MCP/Live: ${event.state}${event.state !== "connected" ? "; no verified current Live observation" : ""}`); break;
      case "observation": notice(`[observation] ${event.label}`); break;
      case "catch-up": {
        const { catchUp } = event;
        const when = since(catchUp.lastSeenAt, Date.now());
        notice(catchUp.lines.length ? `[since last time · ${when}] ${catchUp.lines.join("; ")}${catchUp.more ? `; and ${catchUp.more} more` : ""}` : `[since last time · ${when}] Nothing changed.`);
        break;
      }
      case "change": {
        const { state, title, note } = event.change;
        if (state === "applied") notice(`[change] ${title} (/undo takes it back)`);
        else if (state === "unsure") notice(`[change] Check Live: ${title}. ${note ?? "Live didn't confirm it."}`);
        else if (state === "kept") notice(`[change] Kept: ${title}. ${note ?? ""}`.trim());
        else if (state === "expired") notice(`[change] No undo anymore: ${title}. ${note ?? ""}`.trim());
        break;
      }
      case "notice": notice(event.message); break;
      case "error": reportError(new Error(event.message)); text.discard(); break;
      case "text": {
        if (suppressOutput) return;
        firstTextMs ??= Math.round(performance.now() - startedAt);
        displayedBytes += Buffer.byteLength(event.text);
        if (displayedBytes > 256 * 1024) { notice("Assistant output exceeded the terminal bound; cancelling."); interrupt(); return; }
        presentation?.text(text.push(event.text));
        break;
      }
      case "tool-start": if (!suppressOutput) notice(`[tool] ${event.name} started`); break;
      case "tool-end": if (!suppressOutput) notice(`[tool] ${event.name} ${event.isError ? "error" : "success"} · ${event.elapsedMs} ms`); break;
      case "turn-complete": {
        if (event.result.stopReason !== "cancelled" && !suppressOutput) presentation?.text(text.finish()); else text.discard();
        const usage = event.result.usage;
        notice(`[${event.result.stopReason}] first text ${firstTextMs === undefined ? "unavailable" : `${firstTextMs} ms`}; total ${event.elapsedMs} ms; ${usage ? `reported tokens in/out ${usage.inputTokens}/${usage.outputTokens}; cache read/write ${usage.cacheReadTokens}/${usage.cacheWriteTokens}${event.result.stopReason === "cancelled" ? " (partial before cancellation)" : ""}` : "usage unavailable"}; cost unavailable`);
        break;
      }
    }
  }
  return {
    run() {
      if (started || closing) return done;
      started = true;
      const tty = Boolean(input.isTTY && output.isTTY);
      if (tty) keys = new KeyInput(input);
      rl = createInterface({ input: keys ?? input, output, terminal: tty, prompt: "kumi> ", historySize: 0, crlfDelay: Infinity });
      presentation = new Presentation(rl, output, tty);
      rl.on("line", (value) => { void submitted(value).catch(reportError); });
      rl.on("SIGINT", interrupt);
      rl.on("close", () => { void finish(); });
      input.on("error", () => { void finish(1); }); output.on("error", () => { void finish(1); });
      notice(`Kumi · ${options.model} · ${options.mode === "inference-only" ? "MCP disconnected / No Live access" : "MCP connecting / Live unverified"}`);
      notice("Ephemeral session: quitting loses conversation history. /help for commands.");
      if (options.startupNotice) notice(options.startupNotice);
      void Promise.resolve().then(() => { if (!closing) return controller.start(); }).catch(async (error: unknown) => {
        if (!closing) { reportError(error); await finish(1); }
      });
      return done;
    },
    handleEvent, interrupt,
    close: () => finish(),
  };
}
