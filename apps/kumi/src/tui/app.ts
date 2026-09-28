/**
 * Kumi's full-screen terminal app: a header, the conversation, the Live pane (FOCUS, NOW,
 * HISTORY) and the input box, drawn over a SessionController. See docs/en/KUMI_TUI.md.
 */
import type { ConnectionState, SessionController, SessionEvent } from "@kumi/runtime";
import { safeError } from "../config.js";
import { sanitizeText, StreamingText } from "../text.js";
import { Editor, type EditorLayout } from "./editor.js";
import type { InputEvent } from "./keys.js";
import { Renderer, type Cursor } from "./render.js";
import { FrameScheduler } from "./scheduler.js";
import { Screen, type Rect } from "./screen.js";
import { detectColorDepth, palette, StyleTable, type ColorDepth, type Style } from "./style.js";
import { stepLabel, Transcript, type Entry, type Row } from "./transcript.js";
import { Tty, type TtyInput, type TtyOutput } from "./tty.js";
import { textWidth, truncate } from "./width.js";

export interface TuiOptions {
  controller: SessionController;
  input: TtyInput;
  output: TtyOutput;
  model: string;
  mode: "live" | "inference-only";
  startupNotice?: string;
  secrets?: readonly string[];
  closeTimeoutMs?: number;
  colorDepth?: ColorDepth;
  /** Milliseconds between animation frames; tests shorten it. */
  frameMs?: number;
}

type Assistant = Extract<Entry, { kind: "assistant" }>;

const COMMANDS = [
  { name: "/new", about: "Start a fresh conversation" },
  { name: "/refresh", about: "Read your Live Set again" },
  { name: "/status", about: "What Kumi is connected to" },
  { name: "/help", about: "Keys and commands" },
  { name: "/quit", about: "Close Kumi" },
] as const;

const HELP = "enter sends · ctrl+j or alt+enter starts a new line · esc stops Kumi · page up/down or the mouse wheel scroll · ctrl+c clears the box, then quits · type / for commands";
const WIDE = 100;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FAREWELL = "Kumi closed. This conversation wasn't saved.";

const st = {
  ground: { bg: palette.ground } as Style,
  surface: { bg: palette.surface } as Style,
  raised: { bg: palette.raised } as Style,
  selected: { bg: palette.selected } as Style,
  bright: { fg: palette.bright } as Style,
  title: { fg: palette.bright, bold: true } as Style,
  text: { fg: palette.text } as Style,
  dim: { fg: palette.dim } as Style,
  faint: { fg: palette.faint } as Style,
  label: { fg: palette.faint, bold: true } as Style,
  accent: { fg: palette.accent } as Style,
  pulse: { fg: palette.pulse } as Style,
  warn: { fg: palette.warn } as Style,
};

/** "Current open Set: Night Drive — Remote Script · real-live" → "Night Drive". */
export function setNameFrom(label: string): string | undefined {
  const match = /^Current open Set: (.*) — [^—]*$/.exec(label);
  return match?.[1]?.trim() || undefined;
}

export class TuiApp {
  private readonly tty: Tty;
  private readonly renderer: Renderer;
  private readonly scheduler: FrameScheduler;
  private readonly table = new StyleTable();
  private readonly editor = new Editor();
  private readonly transcript = new Transcript();
  private readonly secrets: readonly string[];
  private readonly stream: StreamingText;
  private current: Assistant | undefined;
  private connection: ConnectionState;
  private setName: string | undefined;
  private scroll = 0;
  private lastTotal = 0;
  private page = 10;
  private menuIndex = 0;
  private menuDismissed = false;
  private started = false;
  private closing = false;
  private cancelling = false;
  private suppress = false;
  private failed = false;
  private bytes = 0;
  /** A submitted message waiting for its turn to start; other operations also report "running". */
  private pendingTurn = false;
  private activity = "connecting to Live";
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: TuiOptions) {
    this.secrets = options.secrets ?? [];
    this.stream = new StreamingText(this.secrets);
    this.connection = options.mode === "inference-only" ? "disconnected" : "connecting";
    this.renderer = new Renderer(options.colorDepth ?? detectColorDepth());
    this.scheduler = new FrameScheduler(() => this.draw(), options.frameMs ?? 16);
    this.tty = new Tty({
      input: options.input, output: options.output,
      onInput: (event) => this.onInput(event),
      onResize: () => { this.renderer.invalidate(); this.scheduler.request(); },
    });
    this.done = new Promise<number>((resolve) => { this.resolveDone = resolve; });
  }

  run(): Promise<number> {
    if (this.started || this.closing) return this.done;
    this.started = true;
    this.tty.start();
    this.options.input.once("end", () => { void this.finish(0); });
    this.options.output.once("error", () => { void this.finish(1); });
    if (this.options.startupNotice) this.notice(this.options.startupNotice, "info");
    this.scheduler.request();
    void Promise.resolve().then(() => { if (!this.closing) return this.options.controller.start(); }).catch((error: unknown) => {
      if (!this.closing) void this.finish(1, `Kumi couldn't start: ${safeError(error, this.secrets)}`);
    });
    return this.done;
  }

  /** Stop Kumi's work, or close when there is none (Ctrl-C from outside the window). */
  interrupt(): void {
    if (this.closing) return;
    if (this.busy) this.cancel();
    else void this.finish(0);
  }

  close(): Promise<number> {
    return this.finish(0);
  }

  /** Draw any pending frame now; for tests. */
  flush(): void {
    this.scheduler.flush();
  }

  handleEvent(event: SessionEvent): void {
    if (this.closing) return;
    switch (event.type) {
      case "state":
        if (event.state === "running") {
          if (this.pendingTurn) {
            this.pendingTurn = false;
            this.suppress = false; this.failed = false; this.bytes = 0; this.stream.discard();
            this.current = this.transcript.add({ kind: "assistant", text: "", steps: [], status: "running" }) as Assistant;
            this.scroll = 0;
          }
        } else if (event.state === "cancelling") {
          this.suppress = true; this.stream.discard();
        } else if (event.state === "idle" && this.pendingTurn) {
          this.pendingTurn = false;
        } else if (this.current) {
          this.current.status = this.failed ? "failed" : "stopped";
          this.transcript.touch(this.current);
          this.current = undefined;
        }
        this.scheduler.setAnimating(event.state === "running" || event.state === "cancelling");
        break;
      case "connection":
        if (this.connection === "connected" && event.state !== "connected") this.notice("Live disconnected. Kumi can still talk, but can't see your Set until Live is back.", "warn");
        this.connection = event.state;
        break;
      case "observation":
        this.setName = setNameFrom(event.label);
        break;
      case "notice":
        this.notice(event.message, "info");
        break;
      case "error":
        this.failed = true;
        this.stream.discard();
        this.notice(event.message, "warn");
        break;
      case "text":
        if (this.suppress || !this.current) return;
        this.bytes += Buffer.byteLength(event.text);
        if (this.bytes > MAX_OUTPUT_BYTES) {
          this.notice("That answer got too long to show, so Kumi stopped it.", "warn");
          this.cancel();
          return;
        }
        this.current.text += this.stream.push(event.text);
        this.transcript.touch(this.current);
        break;
      case "tool-start":
        if (!this.current || this.suppress) break;
        this.current.steps.push({ id: event.id, label: stepLabel(event.name), state: "running" });
        this.transcript.touch(this.current);
        break;
      case "tool-end": {
        const step = this.current?.steps.find((candidate) => candidate.id === event.id);
        if (!step || !this.current) break;
        step.state = event.isError ? "error" : "done";
        step.ms = event.elapsedMs;
        this.transcript.touch(this.current);
        break;
      }
      case "turn-complete": {
        const entry = this.current;
        if (!entry) break;
        const cancelled = event.result.stopReason === "cancelled";
        if (!cancelled && !this.suppress) entry.text += this.stream.finish();
        else this.stream.discard();
        entry.status = cancelled ? "stopped" : "done";
        entry.elapsedMs = event.elapsedMs;
        this.transcript.touch(entry);
        this.current = undefined;
        if (event.result.stopReason === "max-steps") this.notice("Kumi reached its step limit for one answer. Ask it to carry on.", "info");
        break;
      }
      default:
        break;
    }
    this.scheduler.request();
  }

  private get busy(): boolean {
    const state = this.options.controller.status().state;
    return state === "running" || state === "cancelling";
  }

  private notice(text: string, tone: "info" | "warn"): void {
    this.transcript.add({ kind: "notice", text: sanitizeText(text, this.secrets).replace(/\s*\n\s*/g, " ").slice(0, 2048), tone });
    this.scheduler.request();
  }

  private cancel(): void {
    if (this.cancelling || this.closing) return;
    this.cancelling = true;
    this.suppress = true;
    this.stream.discard();
    void Promise.resolve().then(() => this.options.controller.cancel())
      .catch((error: unknown) => this.notice(safeError(error, this.secrets), "warn"))
      .finally(() => { this.cancelling = false; this.scheduler.request(); });
  }

  private async finish(code = 0, message?: string): Promise<number> {
    if (this.closing) return this.done;
    this.closing = true;
    this.suppress = true;
    this.stream.discard();
    this.scheduler.dispose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.options.controller.close(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("closing took too long")), this.options.closeTimeoutMs ?? 6_000);
      })]);
    } catch (error) {
      code = 1;
      message ??= `Kumi didn't close cleanly: ${safeError(error, this.secrets)}`;
    } finally {
      clearTimeout(timer);
      this.tty.restore();
      if (!this.options.output.destroyed) this.options.output.write(`${sanitizeText(message ?? FAREWELL, this.secrets)}\n`);
      this.resolveDone(code);
    }
    return this.done;
  }

  // ---- input

  private onInput(event: InputEvent): void {
    if (this.closing) return;
    if (event.type === "text" || event.type === "paste") {
      this.editor.insert(sanitizeText(event.text));
      this.menuDismissed = false;
    } else if (event.type === "key") {
      this.key(event);
    } else if (event.type === "mouse" && event.action === "wheel") {
      this.scrollBy(event.direction === "up" ? 3 : -3);
    }
    this.scheduler.request();
  }

  private key(event: Extract<InputEvent, { type: "key" }>): void {
    const { name, ctrl, alt, shift } = event;
    const menu = this.menu();
    const width = this.inputWidth();
    if (ctrl && name === "c") {
      if (this.busy) this.cancel();
      else if (!this.editor.isEmpty) this.editor.clear();
      else void this.finish(0);
      return;
    }
    if (ctrl && name === "d") {
      if (this.editor.isEmpty && !this.busy) void this.finish(0);
      else this.editor.delete();
      return;
    }
    if (name === "escape") {
      if (menu.length) this.menuDismissed = true;
      else if (this.busy) this.cancel();
      return;
    }
    if (menu.length && (name === "up" || name === "down")) {
      this.menuIndex = (this.menuIndex + (name === "up" ? -1 : 1) + menu.length) % menu.length;
      return;
    }
    if (menu.length && name === "tab") { this.editor.set(menu[this.menuIndex]!.name); return; }
    if (name === "enter" && !alt && !shift) {
      if (menu.length) this.editor.set(menu[this.menuIndex]!.name);
      void this.submit();
      return;
    }
    if (name === "enter" || (ctrl && name === "j")) { this.editor.insert("\n"); return; }
    if (name === "backspace") { if (alt || ctrl) this.editor.deleteWordLeft(); else this.editor.backspace(); return; }
    if (name === "delete") { this.editor.delete(); return; }
    if (name === "left") { if (alt || ctrl) this.editor.wordLeft(); else this.editor.left(); return; }
    if (name === "right") { if (alt || ctrl) this.editor.wordRight(); else this.editor.right(); return; }
    if (alt && name === "b") { this.editor.wordLeft(); return; }
    if (alt && name === "f") { this.editor.wordRight(); return; }
    if (name === "up") { this.editor.vertical(width, -1); return; }
    if (name === "down") { this.editor.vertical(width, 1); return; }
    if (name === "home" || (ctrl && name === "a")) { this.editor.home(); return; }
    if (name === "end" || (ctrl && name === "e")) { this.editor.end(); return; }
    if (ctrl && name === "k") { this.editor.killToEnd(); return; }
    if (ctrl && name === "u") { this.editor.killToStart(); return; }
    if (ctrl && name === "w") { this.editor.deleteWordLeft(); return; }
    if (name === "pageup") { this.scrollBy(this.page); return; }
    if (name === "pagedown") { this.scrollBy(-this.page); return; }
    if (ctrl && name === "l") this.renderer.invalidate();
  }

  private menu(): readonly { name: string; about: string }[] {
    const text = this.editor.text;
    if (this.menuDismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    const matches = COMMANDS.filter((command) => command.name.startsWith(text));
    if (this.menuIndex >= matches.length) this.menuIndex = 0;
    return matches;
  }

  private async submit(): Promise<void> {
    const raw = this.editor.text;
    const command = raw.trim();
    if (!command) return;
    const { controller } = this.options;
    if (command === "/quit") { this.editor.clear(); await this.finish(0); return; }
    if (command === "/help") { this.editor.clear(); this.notice(HELP, "info"); return; }
    if (command === "/status") {
      this.editor.clear();
      const status = controller.status();
      this.notice(`${status.state === "idle" ? "Ready" : status.state} · Live ${status.connection} · ${this.options.model} · ${status.turns} of ${status.maxTurns} turns${status.observation ? ` · ${status.observation}` : ""}`, "info");
      return;
    }
    if (this.busy) { this.notice("Kumi is still working. Press esc to stop it first.", "info"); return; }
    this.editor.clear();
    this.scroll = 0;
    try {
      if (command === "/refresh") {
        this.activity = "reading your Set";
        await controller.refresh();
      } else if (command === "/new") {
        this.activity = "starting fresh";
        await controller.newConversation();
        this.transcript.clear();
        this.current = undefined;
      } else if (command.startsWith("/")) this.notice(`There's no ${command.split(/\s/)[0]} command. Type / to see them.`, "info");
      else {
        this.transcript.add({ kind: "user", text: sanitizeText(raw, this.secrets).trim() });
        this.activity = "thinking";
        this.pendingTurn = true;
        this.scheduler.request();
        await controller.submit(raw);
      }
    } catch (error) {
      // Refused before it started (busy, closed): no turn is coming.
      this.pendingTurn = false;
      if (!this.closing) this.notice(safeError(error, this.secrets), "warn");
    }
    this.scheduler.request();
  }

  private scrollBy(lines: number): void {
    this.scroll = Math.max(0, this.scroll + lines);
  }

  // ---- drawing

  private layoutFor(columns: number): { pane: number; left: number } {
    const pane = columns >= WIDE ? Math.min(46, Math.max(36, Math.floor(columns * 0.34))) : 0;
    return { pane, left: columns - pane };
  }

  private inputWidth(): number {
    return Math.max(1, this.layoutFor(this.tty.size.columns).left - 6);
  }

  private draw(): void {
    if (!this.tty.isActive) return;
    const { columns, rows } = this.tty.size;
    const screen = new Screen(columns, rows, this.table);
    screen.fill(screen.bounds, st.ground);
    if (columns < 24 || rows < 8) {
      screen.put(1, 0, truncate("Make this window bigger for Kumi", columns - 2), st.dim);
      this.tty.write(this.renderer.frame(screen));
      return;
    }
    const { pane, left } = this.layoutFor(columns);
    this.drawHeader(screen, columns);
    const layout = this.editor.layout(Math.max(1, left - 6));
    const visibleRows = Math.min(5, layout.rows.length);
    const boxHeight = visibleRows + 2;
    const boxTop = rows - 1 - boxHeight;
    const dock = pane ? 0 : 2;
    const conversation: Rect = { x: 0, y: 2, width: left, height: Math.max(1, boxTop - dock - 3) };
    this.page = Math.max(1, conversation.height - 2);
    this.drawConversation(screen, conversation);
    if (pane) this.drawPane(screen, { x: left, y: 1, width: pane, height: rows - 1 });
    else this.drawDock(screen, { x: 0, y: boxTop - dock - 1, width: columns, height: dock });
    const cursor = this.drawComposer(screen, { x: 1, y: boxTop, width: left - 2, height: boxHeight }, layout, visibleRows);
    this.drawMenu(screen, boxTop, left);
    this.tty.write(this.renderer.frame(screen, this.closing ? undefined : cursor));
  }

  private status(): { dot: Style; text: string } {
    if (this.options.mode === "inference-only" || this.connection === "disconnected" || this.connection === "error") return { dot: st.warn, text: "Live not connected" };
    if (this.connection === "connecting") return { dot: st.faint, text: "connecting to Live…" };
    return { dot: st.accent, text: "Live" };
  }

  private drawHeader(screen: Screen, columns: number): void {
    const status = this.status();
    const start = columns - 2 - textWidth(`● ${status.text}`);
    let x = screen.put(2, 0, "Kumi", st.title);
    if (this.setName) {
      x = screen.put(x, 0, "  ·  ", st.faint);
      screen.put(x, 0, truncate(this.setName, Math.max(0, start - x - 2)), st.text);
    }
    screen.put(start, 0, "●", status.dot);
    screen.put(start + 1, 0, ` ${status.text}`, st.dim);
  }

  private drawConversation(screen: Screen, area: Rect): void {
    const textX = area.x + 3;
    const width = Math.max(1, area.width - 5);
    const rows = this.transcript.rows(width);
    if (!rows.length) { this.drawWelcome(screen, textX, area.y + 2, width); return; }
    const total = rows.length;
    if (this.scroll > 0 && total > this.lastTotal) this.scroll += total - this.lastTotal;
    this.lastTotal = total;
    this.scroll = Math.min(this.scroll, Math.max(0, total - area.height));
    const start = Math.max(0, total - area.height - this.scroll);
    const clip: Rect = { x: area.x, y: area.y, width: area.width, height: area.height };
    rows.slice(start, start + area.height).forEach((row, index) => this.drawRow(screen, row, textX, area.y + index, width, clip));
    if (this.scroll > 0) {
      const hint = "newer below · page down";
      screen.fill({ x: area.x, y: area.y + area.height - 1, width: area.width, height: 1 }, st.ground);
      screen.put(area.x + area.width - 2 - textWidth(hint), area.y + area.height - 1, hint, st.faint);
    }
  }

  private drawRow(screen: Screen, row: Row, x: number, y: number, width: number, clip: Rect): void {
    if (row.band) screen.fill({ x: x - 1, y, width: Math.min(row.band.width, width + 2), height: 1 }, { bg: row.band.bg });
    let column = x;
    for (const span of row.spans) column = screen.put(column, y, span.text, span.style, clip);
    if (row.trailing) {
      const at = x + Math.min(width, 46) - textWidth(row.trailing.text);
      if (at > column) screen.put(at, y, row.trailing.text, row.trailing.style, clip);
    }
  }

  private drawWelcome(screen: Screen, x: number, y: number, width: number): void {
    const line = (row: number, text: string, style: Style) => screen.put(x, y + row, truncate(text, width), style);
    if (this.connection === "connected" && this.setName) {
      line(0, `Kumi can see ${this.setName}.`, st.dim);
      line(2, "Try", st.faint);
      line(3, "  “What's on this track?”", st.text);
      line(4, "  “How is my Set laid out?”", st.text);
      line(5, "  “Why might my low end sound muddy?”", st.text);
    } else {
      line(0, "Ask anything about production.", st.dim);
      line(2, "  “How do I make my kick punchier?”", st.text);
    }
    line(7, "Conversations aren't saved yet.", st.faint);
  }

  private nowLine(): { dot?: Style; label: string; detail: string; detailStyle: Style } {
    if (this.closing) return { label: "", detail: "Closing…", detailStyle: st.dim };
    const state = this.options.controller.status().state;
    if (state === "cancelling" || this.cancelling) return { dot: st.faint, label: "stopping", detail: "Stopping…", detailStyle: st.dim };
    if (state === "running") {
      const blink = Math.floor(performance.now() / 500) % 2 === 0;
      const step = this.current?.steps.at(-1);
      return { dot: blink ? st.accent : st.pulse, label: "working", detail: step?.state === "running" ? step.label : this.current ? "thinking" : this.activity, detailStyle: st.dim };
    }
    return { label: "", detail: "Ready", detailStyle: st.faint };
  }

  private focusLines(): { text: string; style: Style }[] {
    if (this.connection === "connected" && this.setName) return [{ text: this.setName, style: st.bright }, { text: "Your selection will show here", style: st.faint }];
    if (this.connection === "connecting") return [{ text: "Connecting to Live…", style: st.dim }];
    return [{ text: "Live isn't connected", style: st.dim }];
  }

  private drawPane(screen: Screen, area: Rect): void {
    screen.fill(area, st.surface);
    const x = area.x + 2;
    const width = area.width - 4;
    const put = (row: number, text: string, style: Style) => screen.put(x, area.y + row, truncate(text, width), style);
    put(1, "FOCUS", st.label);
    this.focusLines().forEach((line, index) => put(2 + index, line.text, line.style));
    put(6, "NOW", st.label);
    const now = this.nowLine();
    if (now.dot) {
      const label = ` ${now.label}`;
      const at = x + width - textWidth(label) - 1;
      screen.put(at, area.y + 6, "●", now.dot);
      screen.put(at + 1, area.y + 6, label, st.dim);
    }
    put(7, now.detail, now.detailStyle);
    put(10, "HISTORY", st.label);
    put(11, "Nothing changed yet", st.faint);
  }

  private drawDock(screen: Screen, area: Rect): void {
    if (area.height <= 0) return;
    screen.fill(area, st.surface);
    const focus = this.focusLines()[0]!;
    const now = this.nowLine();
    const right = now.dot ? ` ${now.label}` : "";
    screen.put(2, area.y, truncate(focus.text, Math.max(1, area.width - 16)), focus.style);
    if (now.dot) {
      const at = area.width - 2 - textWidth(right) - 1;
      screen.put(at, area.y, "●", now.dot);
      screen.put(at + 1, area.y, right, st.dim);
    }
    if (area.height > 1) screen.put(2, area.y + 1, truncate(now.detail, area.width - 4), now.detailStyle);
  }

  private drawComposer(screen: Screen, box: Rect, layout: EditorLayout, visibleRows: number): Cursor {
    screen.fill(box, st.raised);
    const x = box.x + 2;
    const width = Math.max(1, box.width - 4);
    const first = Math.max(0, Math.min(layout.cursorRow - visibleRows + 1, layout.rows.length - visibleRows));
    if (this.editor.isEmpty) {
      const placeholder = this.connection === "connected" ? "Ask Kumi about your Set" : "Ask Kumi anything";
      screen.put(x, box.y + 1, truncate(placeholder, width), st.faint);
    } else {
      layout.rows.slice(first, first + visibleRows).forEach((row, index) => screen.put(x, box.y + 1 + index, row, st.bright, box));
    }
    const hint = this.menu().length ? "enter to choose · esc to close" : this.busy ? "esc to stop" : "enter to send";
    if (textWidth(hint) + 2 < width) screen.put(box.x + box.width - 2 - textWidth(hint), box.y + box.height - 1, hint, st.faint);
    return { x: x + layout.cursorColumn, y: box.y + 1 + layout.cursorRow - first };
  }

  private drawMenu(screen: Screen, boxTop: number, left: number): void {
    const items = this.menu();
    if (!items.length) return;
    const width = Math.min(46, left - 2);
    const top = boxTop - items.length - 1;
    if (top < 2) return;
    screen.fill({ x: 1, y: top - 1, width, height: items.length + 1 }, st.raised);
    items.forEach((item, index) => {
      const y = top + index;
      const chosen = index === this.menuIndex;
      if (chosen) screen.fill({ x: 1, y, width, height: 1 }, st.selected);
      screen.put(3, y, item.name, chosen ? st.accent : st.text);
      if (chosen) screen.put(14, y, truncate(item.about, Math.max(1, width - 15)), st.bright);
    });
  }
}

export function createTui(options: TuiOptions): TuiApp {
  return new TuiApp(options);
}
