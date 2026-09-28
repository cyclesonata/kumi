/**
 * Kumi's full-screen terminal app: a header, the conversation, the Live pane (FOCUS, NOW,
 * HISTORY) and the input box, drawn over a SessionController. See docs/en/KUMI_TUI.md.
 */
import { since, type CatchUp, type ChangeRecord, type ConnectionState, type LiveFocus, type SessionController, type SessionEvent } from "@kumi/runtime";
import { safeError } from "../config.js";
import { sanitizeText, StreamingText } from "../text.js";
import { Editor, type EditorLayout } from "./editor.js";
import type { InputEvent } from "./keys.js";
import { Renderer, type Cursor } from "./render.js";
import { FrameScheduler } from "./scheduler.js";
import { Screen, type Rect } from "./screen.js";
import { detectColorDepth, hex, palette, StyleTable, type ColorDepth, type Rgb, type Style } from "./style.js";
import { stepLabel, Transcript, type Entry, type Row } from "./transcript.js";
import { Tty, type TtyInput, type TtyOutput } from "./tty.js";
import { textWidth, truncate } from "./width.js";
import { wrap } from "./wrap.js";

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
  { name: "/undo", about: "Undo Kumi's last change" },
  { name: "/refresh", about: "Read your Live Set again" },
  { name: "/copy", about: "Copy Kumi's last answer" },
  { name: "/status", about: "What Kumi is connected to" },
  { name: "/help", about: "Keys and commands" },
  { name: "/quit", about: "Close Kumi" },
] as const;

const HELP = "enter sends · ctrl+j or alt+enter starts a new line · esc stops Kumi · page up/down or the mouse wheel scroll · click undo in HISTORY, or /undo, to take back a change · /copy copies the last answer; to select text yourself, hold Shift while dragging (Option in iTerm2) · ctrl+c clears the box, then quits · type / for commands";
/** How long NOW shows a change Kumi just made. */
const CHANGE_FLASH_MS = 4_000;
const WIDE = 100;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FAREWELL = "Kumi closed. Conversations about saved Sets continue next time.";

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

/** A track colour for the focus chip, lightened when too dark to see on Kumi's background. */
export function chipColor(color: string | undefined): Rgb {
  if (!color) return palette.dim;
  let rgb: Rgb;
  try { rgb = hex(color); } catch { return palette.dim; }
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (luminance >= 0.3) return rgb;
  const mix = (channel: number) => Math.round(channel + (255 - channel) * 0.45);
  return [mix(rgb[0]), mix(rgb[1]), mix(rgb[2])];
}

/**
 * The focus path, most specific last: track, then the clip in the Clip view, or the
 * selected device and its last clicked parameter, plus where in Live that is.
 */
export function focusPath(focus: LiveFocus): { crumbs: string[]; value?: string; context: string } {
  const crumbs: string[] = [];
  let value: string | undefined;
  if (focus.track) crumbs.push(focus.track.name);
  if (focus.detail === "Clip" && focus.clip !== undefined) {
    crumbs.push(focus.clip || "Untitled clip");
  } else if (focus.detail === "Device" && focus.device) {
    crumbs.push(focus.device);
    const parameter = focus.parameter;
    if (parameter && (!parameter.owner || parameter.owner === focus.device)) {
      crumbs.push(parameter.name);
      value = parameter.value;
    }
  } else if (focus.scene) {
    crumbs.push(focus.scene);
  }
  const context = [focus.view, focus.detail ? `${focus.detail} view` : undefined,
    focus.selectedNotes ? `${focus.selectedNotes} ${focus.selectedNotes === 1 ? "note" : "notes"} selected` : undefined]
    .filter((part): part is string => Boolean(part)).join(" · ");
  return { crumbs, ...(value ? { value } : {}), context };
}

/** Fit crumbs into `width` cells: shorten the middle first ("Keys › … › Rate"), then the last. */
export function fitCrumbs(crumbs: readonly string[], width: number): string[] {
  const joined = (parts: readonly string[]) => textWidth(parts.join(" › "));
  if (joined(crumbs) <= width || crumbs.length === 0) return [...crumbs];
  if (crumbs.length > 2) {
    const collapsed = [crumbs[0]!, "…", crumbs[crumbs.length - 1]!];
    if (joined(collapsed) <= width) return collapsed;
    return [truncate(crumbs[0]!, 12), "…", truncate(crumbs[crumbs.length - 1]!, Math.max(1, width - textWidth(truncate(crumbs[0]!, 12)) - 6))];
  }
  return crumbs.length === 2 ? [truncate(crumbs[0]!, 12), truncate(crumbs[1]!, Math.max(1, width - textWidth(truncate(crumbs[0]!, 12)) - 3))] : [truncate(crumbs[0]!, width)];
}

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
  private focus: LiveFocus | null = null;
  /** What changed in the Set while Kumi wasn't running. */
  private catchUp: CatchUp | undefined;
  /** Kumi's changes in the order they happened; each keeps its latest state. */
  private changes: ChangeRecord[] = [];
  private lastChange: { id: string; at: number } | undefined;
  private undoing = false;
  /** Clickable areas from the last frame. */
  private hits: { x: number; y: number; width: number; action: () => void }[] = [];
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
        // The session says what happened and what Kumi does about it (a notice).
        this.connection = event.state;
        break;
      case "observation":
        this.setName = setNameFrom(event.label);
        break;
      case "focus":
        this.focus = event.focus;
        break;
      case "resumed": {
        this.notice(`Continuing your conversation from ${since(event.savedAt, Date.now())}. /new starts fresh.`, "info");
        for (const line of event.lines) {
          const text = sanitizeText(line.text, this.secrets).slice(0, 16 * 1024);
          this.transcript.add(line.role === "user" ? { kind: "user", text } : { kind: "assistant", text, steps: [], status: "done" });
        }
        break;
      }
      case "catch-up":
        this.catchUp = event.catchUp;
        // The welcome screen shows it; once the conversation has started, it becomes a note.
        if (!this.transcript.isEmpty && !(event.catchUp.afterReconnect && !event.catchUp.lines.length)) this.notice(catchUpText(event.catchUp), "info");
        break;
      case "change": {
        const index = this.changes.findIndex((change) => change.id === event.change.id);
        if (index >= 0) this.changes[index] = event.change;
        else {
          this.changes.push(event.change);
          if (this.changes.length > 500) this.changes.shift();
          this.lastChange = { id: event.change.id, at: performance.now() };
          // NOW shows the change for a moment, then one more frame puts it back.
          setTimeout(() => { if (!this.closing) this.scheduler.request(); }, CHANGE_FLASH_MS + 20).unref?.();
        }
        break;
      }
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
    } else if (event.type === "mouse" && event.action === "press" && event.button === "left") {
      this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width)?.action();
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
    if (command === "/undo") { this.editor.clear(); await this.undo(); return; }
    if (command === "/copy") { this.editor.clear(); this.copyLastAnswer(); return; }
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

  /**
   * Copy the last answer through the terminal's clipboard sequence (OSC 52), which most modern
   * terminals honour; the text is Kumi's own answer, already free of control characters.
   */
  private copyLastAnswer(): void {
    const answer = [...this.transcript.entries].reverse().find((entry): entry is Assistant => entry.kind === "assistant" && entry.text.trim().length > 0);
    if (!answer) { this.notice("There's no answer to copy yet.", "info"); return; }
    const text = sanitizeText(answer.text, this.secrets).trim();
    if (Buffer.byteLength(text) > 64 * 1024) { this.notice("That answer is too long to copy this way; hold Shift and drag to select it.", "info"); return; }
    this.tty.write(`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`);
    this.notice("Copied Kumi's last answer. If it didn't arrive, your terminal may not allow it: hold Shift and drag to select instead.", "info");
  }

  /** Undo one change (the latest undoable one without an id) and say how it went. */
  private async undo(id?: string): Promise<void> {
    if (this.closing || this.undoing) return;
    if (this.busy) { this.notice("Kumi is still working. Press esc to stop it first, then undo.", "info"); return; }
    if (!id && !this.changes.some((change) => change.state === "applied")) { this.notice("There's nothing of Kumi's to undo.", "info"); return; }
    this.undoing = true;
    this.activity = "undoing";
    this.scheduler.request();
    try {
      const change = await this.options.controller.undo(id);
      if (change?.state === "undone") this.notice(`Undid: ${change.title}`, "info");
      else if (change) this.notice(`Kept: ${change.title}. ${change.note ?? ""}`.trim(), "warn");
    } catch (error) {
      if (!this.closing) this.notice(safeError(error, this.secrets), "warn");
    } finally {
      this.undoing = false;
      this.scheduler.request();
    }
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
    this.hits = [];
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
    const rows: { text: string; style: Style }[] = [];
    const add = (text = "", style: Style = st.text) => rows.push({ text, style });
    if (this.connection === "connected" && this.setName) {
      add(`Kumi can see ${this.setName}.`, st.dim);
      const catchUp = this.catchUp?.set === this.setName ? this.catchUp : undefined;
      if (catchUp) {
        add();
        if (!catchUp.lines.length) add(`Nothing changed since you were last here, ${since(catchUp.lastSeenAt, Date.now())}.`, st.dim);
        else {
          add(`Since you were last here · ${since(catchUp.lastSeenAt, Date.now())}`, st.faint);
          for (const change of catchUp.lines) add(`  • ${change}`, st.text);
          if (catchUp.more) add(`  and ${catchUp.more} more ${catchUp.more === 1 ? "change" : "changes"}`, st.faint);
        }
      }
      add();
      add("Try", st.faint);
      add("  “What's on this track?”");
      add("  “Set the tempo to 124”");
      add("  “Why might my low end sound muddy?”");
    } else {
      add("Ask anything about production.", st.dim);
      add();
      add("  “How do I make my kick punchier?”");
    }
    add();
    add("Kumi keeps the conversation for each saved Set.", st.faint);
    rows.forEach((row, index) => { if (row.text) screen.put(x, y + index, truncate(row.text, width), row.style); });
  }

  /** The change NOW is showing, for a few seconds after Kumi makes it. */
  private flashing(): ChangeRecord | undefined {
    if (!this.lastChange || performance.now() - this.lastChange.at >= CHANGE_FLASH_MS) return undefined;
    return this.changes.find((change) => change.id === this.lastChange!.id);
  }

  private nowLine(): { dot?: Style; label: string; detail: string; detailStyle: Style } {
    if (this.closing) return { label: "", detail: "Closing…", detailStyle: st.dim };
    const state = this.options.controller.status().state;
    if (state === "cancelling" || this.cancelling) return { dot: st.faint, label: "stopping", detail: "Stopping…", detailStyle: st.dim };
    const flash = this.lastChange && performance.now() - this.lastChange.at < CHANGE_FLASH_MS ? this.changes.find((change) => change.id === this.lastChange!.id) : undefined;
    if (state === "running") {
      const blink = Math.floor(performance.now() / 500) % 2 === 0;
      const step = this.current?.steps.at(-1);
      if (flash && step?.state !== "running") return { dot: blink ? st.accent : st.pulse, label: "working", detail: `✓ ${flash.title}`, detailStyle: st.bright };
      return { dot: blink ? st.accent : st.pulse, label: "working", detail: step?.state === "running" ? step.label : this.current ? "thinking" : this.activity, detailStyle: st.dim };
    }
    if (flash) return { label: "", detail: `✓ ${flash.title}`, detailStyle: st.bright };
    return { label: "", detail: "Ready", detailStyle: st.faint };
  }

  private focusLines(): { text: string; style: Style }[] {
    if (this.connection === "connected" && this.setName) return [{ text: this.setName, style: st.bright }, { text: "Your selection will show here", style: st.faint }];
    if (this.connection === "connecting") return [{ text: "Connecting to Live…", style: st.dim }];
    return [{ text: "Live isn't connected", style: st.dim }];
  }

  /** Draw "■ Track › Device › Parameter" (and, in the pane, where in Live) when focus is known. */
  private drawFocusPath(screen: Screen, x: number, y: number, width: number, withContext: boolean): boolean {
    if (this.connection !== "connected" || !this.focus?.track) return false;
    const { crumbs, value, context } = focusPath(this.focus);
    const room = Math.max(1, width - 2);
    // The path stays whole where possible; a parameter's value moves to the second line when tight.
    const inline = value !== undefined && textWidth(`${crumbs.join(" › ")} · ${value}`) <= room;
    const parts = fitCrumbs(crumbs, inline ? room - textWidth(` · ${value}`) : room);
    let column = screen.put(x, y, "■", { fg: chipColor(this.focus.track.color) });
    column = screen.put(column, y, " ", st.text);
    parts.forEach((part, index) => {
      if (index > 0) column = screen.put(column, y, " › ", st.faint);
      column = screen.put(column, y, part, index === parts.length - 1 && parts.length > 1 ? st.bright : st.text);
    });
    if (inline) screen.put(column, y, ` · ${value}`, st.bright);
    const second = [inline ? undefined : value, context].filter(Boolean).join(" · ");
    if (withContext && second) screen.put(x + 2, y + 1, truncate(second, Math.max(1, width - 2)), st.dim);
    return true;
  }

  private drawPane(screen: Screen, area: Rect): void {
    screen.fill(area, st.surface);
    const x = area.x + 2;
    const width = area.width - 4;
    const put = (row: number, text: string, style: Style) => screen.put(x, area.y + row, truncate(text, width), style);
    put(1, "FOCUS", st.label);
    if (!this.drawFocusPath(screen, x, area.y + 2, width, true)) this.focusLines().forEach((line, index) => put(2 + index, line.text, line.style));
    put(6, "NOW", st.label);
    const now = this.nowLine();
    if (now.dot) {
      const label = ` ${now.label}`;
      const at = x + width - textWidth(label) - 1;
      screen.put(at, area.y + 6, "●", now.dot);
      screen.put(at + 1, area.y + 6, label, st.dim);
    }
    put(7, now.detail, now.detailStyle);
    const picture = this.flashing() ? changePicture(this.flashing()!, width) : undefined;
    if (picture) {
      let column = x;
      for (const part of picture) column = screen.put(column, area.y + 8, part.text, part.style);
    }
    put(10, "HISTORY", st.label);
    this.drawHistory(screen, { x, y: area.y + 11, width, height: Math.max(0, area.height - 12) });
  }

  /** Kumi's changes, newest first, each with its own undo. */
  private drawHistory(screen: Screen, area: Rect): void {
    if (area.height <= 0) return;
    if (!this.changes.length) { screen.put(area.x, area.y, truncate("Nothing changed yet", area.width), st.faint); return; }
    const newest = [...this.changes].reverse();
    let y = area.y;
    let shown = 0;
    for (const change of newest) {
      const action = change.state === "applied" ? "undo" : change.state === "undone" ? "undone" : change.state === "kept" ? "kept" : change.state === "expired" ? "no undo" : "check Live";
      const actionStyle = change.state === "applied" ? st.accent : change.state === "undone" || change.state === "expired" ? st.faint : st.warn;
      const actionX = area.x + area.width - textWidth(action);
      const titleStyle = change.state === "undone" || change.state === "expired" ? st.faint : st.text;
      // A title gets two lines, so the values ("0.0 dB → -2.0 dB") aren't the part cut off.
      const lines = wrap([{ text: change.title, style: titleStyle }], Math.max(1, actionX - area.x - 3)).map((spans) => spans.map((span) => span.text).join(""));
      const rows = Math.min(2, lines.length);
      const left = newest.length - shown;
      if (y + rows > area.y + area.height - (left > 1 ? 1 : 0)) break;
      const marker = change.state === "undone" || change.state === "expired" ? { text: "○", style: st.faint }
        : change.state === "unsure" ? { text: "●", style: st.warn }
        : change.track ? { text: "■", style: { fg: chipColor(change.track.color) } as Style } : { text: "✓", style: st.accent };
      screen.put(area.x, y, marker.text, marker.style);
      screen.put(area.x + 2, y, lines[0] ?? "", titleStyle);
      if (rows > 1) screen.put(area.x + 2, y + 1, truncate(lines.slice(1).join(" "), Math.max(1, area.width - 2)), titleStyle);
      screen.put(actionX, y, action, actionStyle);
      if (change.state === "applied") this.hits.push({ x: actionX, y, width: textWidth(action), action: () => { void this.undo(change.id); } });
      y += rows; shown++;
    }
    if (shown < newest.length) screen.put(area.x, y, truncate(`${newest.length - shown} earlier`, area.width), st.faint);
  }

  private drawDock(screen: Screen, area: Rect): void {
    if (area.height <= 0) return;
    screen.fill(area, st.surface);
    const focus = this.focusLines()[0]!;
    const now = this.nowLine();
    const right = now.dot ? ` ${now.label}` : "";
    if (!this.drawFocusPath(screen, 2, area.y, Math.max(1, area.width - 16), false)) screen.put(2, area.y, truncate(focus.text, Math.max(1, area.width - 16)), focus.style);
    if (now.dot) {
      const at = area.width - 2 - textWidth(right) - 1;
      screen.put(at, area.y, "●", now.dot);
      screen.put(at + 1, area.y, right, st.dim);
    }
    const last = this.changes.at(-1);
    if (area.height > 1) {
      if (!this.busy && last?.state === "applied") {
        const hint = "undo";
        const at = area.width - 2 - textWidth(hint);
        screen.put(2, area.y + 1, truncate(`✓ ${last.title}`, Math.max(1, at - 4)), st.text);
        screen.put(at, area.y + 1, hint, st.accent);
        this.hits.push({ x: at, y: area.y + 1, width: textWidth(hint), action: () => { void this.undo(last.id); } });
      } else screen.put(2, area.y + 1, truncate(now.detail, area.width - 4), now.detailStyle);
    }
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

/**
 * A change's before and after as positions, like a fader or a knob seen side on:
 * "██████░░░░ → ████░░░░░░". Only for values with a known span.
 */
export function changePicture(change: ChangeRecord, width: number): { text: string; style: Style }[] | undefined {
  if (change.from === undefined || change.to === undefined || !change.range) return undefined;
  const [min, max] = change.range;
  if (!(max > min)) return undefined;
  const cells = Math.max(4, Math.min(12, Math.floor((width - 3) / 2)));
  const bar = (value: number) => {
    const filled = Math.round(Math.min(1, Math.max(0, (value - min) / (max - min))) * cells);
    return "█".repeat(filled) + "░".repeat(cells - filled);
  };
  return [{ text: bar(change.from), style: st.faint }, { text: " → ", style: st.faint }, { text: bar(change.to), style: st.accent }];
}

/** A catch-up as one line for the conversation. */
export function catchUpText(catchUp: CatchUp, now = Date.now()): string {
  const when = since(catchUp.lastSeenAt, now);
  if (catchUp.afterReconnect) return `While Live was away, ${catchUp.set} changed: ${catchUp.lines.join("; ")}${catchUp.more ? `; and ${catchUp.more} more` : ""}.`;
  if (!catchUp.lines.length) return `Nothing changed in ${catchUp.set} since you were last here, ${when}.`;
  return `Since you were last here (${when}): ${catchUp.lines.join("; ")}${catchUp.more ? `; and ${catchUp.more} more` : ""}.`;
}

export function createTui(options: TuiOptions): TuiApp {
  return new TuiApp(options);
}
