/**
 * Kumi's full-screen terminal app: a header, the conversation, the Live pane (FOCUS, NOW,
 * HISTORY) and the input box, drawn over a SessionController. See docs/en/KUMI_TUI.md.
 */
import {
  FORGET_RECIPE_TOOL, FORGET_TOOL, KumiError, PROVIDER_INFO, REMEMBER_TOOL, SAVE_RECIPE_TOOL, since, type CatchUp, type ChangeRecord, type ConnectionState, type DevicePlacement, type Effort, type LiveFocus, type ModelInfo, type ProviderId,
  type SessionController, type SessionEvent,
} from "@kumi/runtime";
import { safeError } from "../config.js";
import { openBrowser } from "../login.js";
import type { ModelControl } from "../models.js";
import { sanitizeText, StreamingText } from "../text.js";
import { Editor, type EditorLayout } from "./editor.js";
import { Picker, type PickerItem } from "./picker.js";
import type { InputEvent } from "./keys.js";
import { Renderer, type Cursor } from "./render.js";
import { FrameScheduler } from "./scheduler.js";
import { Screen, type Rect } from "./screen.js";
import { detectColorDepth, hex, palette, StyleTable, type ColorDepth, type Rgb, type Style } from "./style.js";
import { doingLabel, stepLabel, Transcript, type Entry, type Row } from "./transcript.js";
import { Tty, type TtyInput, type TtyOutput } from "./tty.js";
import { textWidth, truncate } from "./width.js";
import { wrap } from "./wrap.js";

export interface TuiOptions {
  controller: SessionController;
  input: TtyInput;
  output: TtyOutput;
  /** The model and its sign-ins, for /model, /effort, /login and /logout; without it those aren't offered. */
  models?: ModelControl;
  mode: "live" | "inference-only";
  startupNotice?: string;
  secrets?: readonly string[];
  closeTimeoutMs?: number;
  colorDepth?: ColorDepth;
  /** Milliseconds between animation frames; tests shorten it. */
  frameMs?: number;
}

type Assistant = Extract<Entry, { kind: "assistant" }>;

/**
 * What's open above the input box: a list to choose from, a key being pasted (never shown), or a
 * ChatGPT sign-in waiting in the browser.
 */
type Panel =
  | { kind: "pick"; picker: Picker; choose(item: PickerItem): void | Promise<void> }
  | { kind: "key"; provider: ProviderId; secret: string; checking?: boolean; status?: { text: string; tone: "info" | "warn" }; then?: () => void | Promise<void> }
  | { kind: "chatgpt"; url?: string; abort: AbortController; then?: () => void | Promise<void> };

/** A row of a panel: text, a dimmer detail beside it, a note at the right edge. */
interface PanelLine {
  text: string;
  style: Style;
  detail?: { text: string; style: Style };
  right?: { text: string; style: Style };
  /** The selected row. */
  band?: boolean;
  indent?: number;
  /** Labels in a list share a column, so their details line up. */
  labelWidth?: number;
}

/** For efforts whose provider doesn't describe them. */
const EFFORT_WORDS: Record<Effort, string> = { low: "Fastest; lighter thinking", medium: "Balanced", high: "Thorough", xhigh: "More thorough still", max: "As hard as it can" };

const COMMANDS = [
  { name: "/new", about: "Start a fresh conversation" },
  { name: "/undo", about: "Undo Kumi's last change" },
  { name: "/stop", about: "Stop Live: clips, the transport and recording" },
  { name: "/refresh", about: "Read your Live Set again" },
  { name: "/copy", about: "Copy Kumi's last answer" },
  { name: "/model", about: "Choose the model Kumi talks to" },
  { name: "/effort", about: "How hard the model thinks" },
  { name: "/login", about: "Sign in to a provider" },
  { name: "/memory", about: "What Kumi remembers" },
  { name: "/recipes", about: "Your saved ways of working" },
  { name: "/logout", about: "Sign out of a provider" },
  { name: "/status", about: "What Kumi is connected to" },
  { name: "/help", about: "Keys and commands" },
  { name: "/quit", about: "Close Kumi" },
] as const;

/** Kumi's tools that act in Live without changing the Set. */
const ACTION_TOOLS: ReadonlySet<string> = new Set(["play", "fire_scene", "launch_clip", "record", "jump_to_locator", "select", "show"]);
/** Offered only with a ModelControl to answer them. */
const MODEL_COMMANDS: readonly string[] = ["/model", "/effort", "/login", "/logout"];

const HELP = "enter sends · ctrl+j or alt+enter starts a new line · esc stops Kumi · page up/down or the mouse wheel scroll · click undo in HISTORY, or /undo, to take back a change · /copy copies the last answer; to select text yourself, hold Shift while dragging (Option in iTerm2) · /model and /effort choose the model and how hard it thinks; /login and /logout sign in and out · /memory shows what Kumi remembers; /recipes your saved ways of working · ctrl+c clears the box, then quits · type / for commands";
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
  /** Kept out of everything shown; keys pasted into Kumi join it. */
  private readonly secrets: string[];
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
  /** The latest thing Kumi did in Live that isn't a change (playing, recording), for NOW. */
  private lastAction: { title: string; at: number; glyph: string } | undefined;
  /** Kumi is watching the producer work in Live (watch_me), until they say they're done. */
  private watching = false;
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
  /** A message typed while Kumi was connecting or reading the Set; sent as soon as it's ready. */
  private queued: string | undefined;
  private activity = "connecting to Live";
  private panel: Panel | undefined;
  /** The model is writing a plan of changes (the call's id), which starts running as it's written. */
  private planning: string | undefined;
  /** Changes Kumi made in the answer under way, for NOW. */
  private turnChanges = 0;
  /** The last message sent, to send again after a sign-in it was waiting for. */
  private lastSent: string | undefined;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  /** How many colours the terminal shows; some pictures need more than a few. */
  private readonly depth: ColorDepth;

  constructor(private readonly options: TuiOptions) {
    this.secrets = [...(options.secrets ?? [])];
    this.stream = new StreamingText(this.secrets);
    this.connection = options.mode === "inference-only" ? "disconnected" : "connecting";
    this.depth = options.colorDepth ?? detectColorDepth();
    this.renderer = new Renderer(this.depth);
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
    void Promise.resolve().then(() => this.checkModel()).catch((error: unknown) => this.panelFailed(error));
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
            this.planning = undefined; this.turnChanges = 0;
          }
        } else if (event.state === "cancelling") {
          this.suppress = true; this.stream.discard();
        } else if (event.state === "idle" && this.pendingTurn) {
          this.pendingTurn = false;
        } else if (event.state === "idle" && this.queued !== undefined) {
          const raw = this.queued; this.queued = undefined;
          void Promise.resolve().then(() => this.send(raw));
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
          if (this.current) this.turnChanges++;
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
        if (event.kind) this.offerFix(event.kind, event.provider);
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
      case "remembered": {
        const where = event.scope === "producer" ? "about you" : event.pending ? `once ${this.setName ?? "this Set"} is saved` : "";
        this.notice(`${event.replaced ? "Kumi updated a note" : "Kumi will remember"}${where ? ` ${where}` : ""}: ${event.note.text}`, "info");
        break;
      }
      case "forgot":
        this.notice(`Kumi forgot: ${event.note.text}`, "info");
        break;
      case "action": {
        const glyph = event.recording === true ? "●" : event.playing === true ? "▶" : event.playing === false || event.recording === false ? "■" : "›";
        this.lastAction = { title: sanitizeText(event.title, this.secrets).slice(0, 120), at: performance.now(), glyph };
        setTimeout(() => { if (!this.closing) this.scheduler.request(); }, CHANGE_FLASH_MS + 20).unref?.();
        break;
      }
      case "watching":
        this.watching = event.on;
        this.scheduler.request();
        break;
      case "recipe": {
        const steps = `${event.steps} ${event.steps === 1 ? "step" : "steps"}`;
        const text = event.action === "saved" ? `Kumi saved the recipe “${event.name}” (${steps})` : event.action === "updated" ? `Kumi updated the recipe “${event.name}” (${steps})`
          : event.action === "running" ? `Running your recipe “${event.name}” (${steps})` : `Kumi forgot the recipe “${event.name}”`;
        this.notice(text, "info");
        break;
      }
      case "heard":
        // What Kumi heard came first: it goes above the answer that says what it means.
        this.transcript.insertBefore({ kind: "heard", file: sanitizeText(event.file, this.secrets).slice(0, 120), summary: sanitizeText(event.summary, this.secrets).slice(0, 200), bands: event.bands,
          ...(event.compared ? { compared: { reference: sanitizeText(event.compared.reference, this.secrets).slice(0, 120), summary: sanitizeText(event.compared.summary, this.secrets).slice(0, 200), differences: event.compared.differences } } : {}) }, this.current);
        break;
      case "tool-input":
        // A plan takes seconds to write; its changes start as it's written.
        if (this.current && !this.suppress && event.name === "make_changes") this.planning = event.id;
        break;
      case "tool-start":
        if (this.planning === event.id) this.planning = undefined;
        // Keeping notes and recipes shows as a line of its own, not a step.
        if (!this.current || this.suppress || [REMEMBER_TOOL, FORGET_TOOL, SAVE_RECIPE_TOOL, FORGET_RECIPE_TOOL].includes(event.name)) break;
        this.current.steps.push({ id: event.id, tool: event.name, label: stepLabel(event.name), state: "running" });
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
    // A ChatGPT sign-in waiting on the browser stops listening; a half-typed key is dropped.
    if (this.panel?.kind === "chatgpt") this.panel.abort.abort();
    if (this.panel?.kind === "key") this.panel.secret = "";
    this.panel = undefined;
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
    if (this.panel && (event.type === "text" || event.type === "paste" || event.type === "key")) { this.panelInput(event); this.scheduler.request(); return; }
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
    const matches = COMMANDS.filter((command) => command.name.startsWith(text) && (this.options.models || !MODEL_COMMANDS.includes(command.name))
      && (command.name !== "/memory" || this.options.controller.memory !== undefined) && (command.name !== "/recipes" || this.options.controller.recipes !== undefined)
      && (command.name !== "/stop" || this.options.controller.stopLive !== undefined));
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
    // The model and its sign-ins can change any time: an answer running now finishes as it started.
    if (this.options.models && MODEL_COMMANDS.includes(command)) {
      this.editor.clear();
      const open = { "/model": () => this.openModels(), "/effort": () => this.openEffort(), "/login": () => this.openLogin(), "/logout": () => this.openLogout() }[command]!;
      await open().catch((error: unknown) => this.panelFailed(error));
      return;
    }
    if (command === "/recipes" && controller.recipes) {
      this.editor.clear();
      await this.openRecipes().catch((error: unknown) => this.panelFailed(error));
      return;
    }
    if (command === "/memory" && controller.memory) {
      this.editor.clear();
      await this.openMemory().catch((error: unknown) => this.panelFailed(error));
      return;
    }
    // Stopping Live works any time. An answer in progress (a plan recording, say) stops too, so
    // its later steps can't start Live again.
    if (command === "/stop" && controller.stopLive) {
      this.editor.clear();
      if (this.connection !== "connected") { this.notice("Live isn't connected, so there's nothing for Kumi to stop.", "info"); return; }
      if (this.busy) await controller.cancel().catch(() => {});
      if (!await controller.stopLive()) this.notice("Kumi couldn't stop Live just now; press space in Live to stop it.", "warn");
      return;
    }
    if (command === "/status") {
      this.editor.clear();
      const status = controller.status();
      this.notice(`${status.state === "idle" ? "Ready" : status.state} · Live ${status.connection} · ${this.modelLabel() ?? "no model"} · ${status.maxTurns ? `${status.turns} of ${status.maxTurns} turns` : `${status.turns} ${status.turns === 1 ? "turn" : "turns"}`}${status.observation ? ` · ${status.observation}` : ""}`, "info");
      return;
    }
    // Connecting or reading the Set (not answering): keep the message and send it when Kumi is ready.
    if (this.busy && !this.current && !this.pendingTurn && !command.startsWith("/") && this.queued === undefined) {
      this.editor.clear();
      this.transcript.add({ kind: "user", text: sanitizeText(raw, this.secrets).trim() });
      this.queued = raw; this.lastSent = raw;
      this.activity = "getting ready";
      this.scheduler.request();
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
        this.watching = false;
        // A fresh start is a new bridge connection: earlier changes stay listed, without their undo.
        this.changes = this.changes.map((change) => change.state === "applied" || change.state === "unsure"
          ? { ...change, state: "expired", note: "Kumi started fresh (/new), so it can't undo this; Live's own undo still can." } : change);
      } else if (command.startsWith("/")) this.notice(`There's no ${command.split(/\s/)[0]} command. Type / to see them.`, "info");
      else {
        this.transcript.add({ kind: "user", text: sanitizeText(raw, this.secrets).trim() });
        this.lastSent = raw;
        await this.send(raw);
        return;
      }
    } catch (error) {
      // Refused before it started (busy, closed): no turn is coming.
      this.pendingTurn = false;
      if (!this.closing) this.notice(safeError(error, this.secrets), "warn");
    }
    this.scheduler.request();
  }

  // ---- the model, and signing in

  /** The model for the header and /status: "Claude Sonnet 5.5 · high". */
  private modelLabel(): string | undefined {
    const current = this.options.models?.current();
    if (!current) return undefined;
    if (!current.model) return "no model chosen";
    const name = current.name ?? current.model.slice(current.model.indexOf("/") + 1);
    return current.effort ? `${name} · ${current.effort}` : name;
  }

  private closePanel(): void {
    const panel = this.panel;
    if (panel?.kind === "chatgpt") panel.abort.abort();
    if (panel?.kind === "key") panel.secret = "";
    this.panel = undefined;
    this.scheduler.request();
  }

  private panelFailed(error: unknown): void {
    this.closePanel();
    if (!this.closing) this.notice(safeError(error, this.secrets), "warn");
  }

  private panelInput(event: InputEvent): void {
    const panel = this.panel!;
    if (event.type === "key") {
      const { name, ctrl } = event;
      if (name === "escape" || (ctrl && name === "c")) { this.closePanel(); return; }
      if (panel.kind === "pick") {
        if (name === "up") panel.picker.move(-1);
        else if (name === "down" || name === "tab") panel.picker.move(1);
        else if (name === "backspace") panel.picker.erase();
        else if (name === "enter") {
          const item = panel.picker.selected();
          if (item) void Promise.resolve().then(() => panel.choose(item)).catch((error: unknown) => this.panelFailed(error));
        }
      } else if (panel.kind === "key" && !panel.checking) {
        if (name === "backspace") panel.secret = panel.secret.slice(0, -1);
        else if (ctrl && name === "u") panel.secret = "";
        else if (name === "enter" && panel.secret) void this.submitKey(panel);
      }
      return;
    }
    if (event.type !== "text" && event.type !== "paste") return;
    // The sign-in link, through the terminal's clipboard, for a browser that didn't open by itself.
    if (panel.kind === "chatgpt" && panel.url && event.text.toLowerCase() === "c") {
      this.tty.write(`\u001b]52;c;${Buffer.from(panel.url, "utf8").toString("base64")}\u0007`);
      this.notice("Copied the sign-in link.", "info");
      return;
    }
    if (panel.kind === "pick") panel.picker.type(event.text);
    // A key is one word: spaces and line breaks a paste brings along go.
    else if (panel.kind === "key" && !panel.checking) { panel.secret = (panel.secret + event.text.replace(/[\s\x00-\x1f\x7f]/g, "")).slice(0, 4096); delete panel.status; }
  }

  /** /model: every provider's models, from their own lists, under whether Kumi is signed in there. */
  private async openModels(): Promise<void> {
    const models = this.options.models;
    if (!models) return;
    const picker = new Picker("Choose a model", [{ label: "Reading your sign-ins…", inert: true }], { filterable: true });
    this.panel = { kind: "pick", picker, choose: (item) => this.chooseModelItem(item) };
    this.scheduler.request();
    const statuses = await this.options.models!.providers();
    const lists = new Map<ProviderId, ModelInfo[] | "refused" | "unreadable">();
    const current = models.current().model;
    const signInItem = (provider: typeof statuses[number], again = false): PickerItem => ({
      label: `Sign in to ${provider.name}${again ? " again" : ""}`, detail: provider.signIn === "chatgpt" ? "with your ChatGPT plan" : "with an API key",
      value: `signin:${provider.id}`, note: "sign in", noteTone: "accent" });
    const build = (): PickerItem[] => statuses.flatMap((provider): PickerItem[] => {
      const listed = lists.get(provider.id);
      const heading: PickerItem = { heading: true, label: provider.name, noteTone: listed === "refused" ? "warn" : "faint",
        note: listed === "refused" ? provider.via === "environment" ? `${provider.keyEnv} not accepted` : "sign-in not accepted"
          : provider.via === "environment" ? `key from ${provider.keyEnv}` : provider.signedIn ? "signed in" : "not signed in" };
      if (!provider.signedIn) return [heading, signInItem(provider)];
      if (listed === undefined) return [heading, { label: "Reading its models…", inert: true }];
      if (listed === "refused") return [heading, signInItem(provider, true)];
      if (listed === "unreadable") return [heading, { label: "Couldn't read its models just now; try /model again.", inert: true }];
      if (!listed.length) return [heading, { label: "It lists no models for this sign-in.", inert: true }];
      return [heading, ...listed.map((model): PickerItem => ({ label: model.name, ...(model.description ? { detail: model.description } : {}), value: model.id,
        ...(model.id === current ? { note: "current", noteTone: "accent" as const } : {}) }))];
    });
    const update = () => {
      if (this.panel?.kind !== "pick" || this.panel.picker !== picker) return;
      picker.setItems(build()); picker.select(current); this.scheduler.request();
    };
    update();
    await Promise.all(statuses.filter((provider) => provider.signedIn).map(async (provider) => {
      try { lists.set(provider.id, await models.models(provider.id)); }
      catch (error) { lists.set(provider.id, error instanceof KumiError && error.kind === "auth" ? "refused" : "unreadable"); }
      update();
    }));
  }

  private async chooseModelItem(item: PickerItem): Promise<void> {
    const models = this.options.models!;
    const value = item.value!;
    if (value.startsWith("signin:")) { this.signIn(value.slice("signin:".length) as ProviderId, () => this.openModels()); return; }
    try {
      await models.choose(value);
    } catch (error) {
      // Its provider isn't signed in: sign in there first, then use it.
      if (error instanceof KumiError && error.kind === "auth" && error.provider) { this.signIn(error.provider as ProviderId, () => this.chooseModelItem(item)); return; }
      throw error;
    }
    this.closePanel();
    const current = models.current();
    const effort = current.effort ? `, at ${current.effort} effort` : current.defaultEffort ? `, at its usual ${current.defaultEffort} effort` : "";
    this.notice(`Kumi talks to ${current.name ?? value} from your next message${effort}.${current.pinned ? " KUMI_MODEL is set, so this lasts until Kumi closes." : ""}`, "info");
  }

  /** /effort: the levels the current model takes, with its own default first. */
  private async openEffort(): Promise<void> {
    const models = this.options.models!;
    let current = models.current();
    if (!current.model) { await this.openModels(); return; }
    if (current.provider) await models.models(current.provider).catch(() => undefined);
    current = models.current();
    const name = current.name ?? current.model!;
    if (!current.efforts.length) { this.notice(`${name} has no effort setting to choose.`, "info"); return; }
    const items: PickerItem[] = [
      { label: current.defaultEffort ? `Default (${current.defaultEffort})` : "Default", detail: "The model's own setting", value: "default", ...(!current.effort ? { note: "current", noteTone: "accent" } : {}) },
      ...current.efforts.map((level): PickerItem => ({ label: level.effort, detail: level.description ?? EFFORT_WORDS[level.effort], value: level.effort,
        ...(current.effort === level.effort ? { note: "current", noteTone: "accent" as const } : {}) })),
    ];
    const picker = new Picker(`How hard ${name} thinks · lower answers sooner`, items);
    picker.select(current.effort ?? "default");
    this.panel = { kind: "pick", picker, choose: async (item) => {
      const effort = item.value === "default" ? undefined : item.value as Effort;
      await models.setEffort(effort);
      this.closePanel();
      this.notice(effort ? `${name} thinks at ${effort} effort from your next message.` : `${name} uses its own effort from your next message.`, "info");
    } };
    this.scheduler.request();
  }

  /** /login: each provider, and how Kumi signs in there. */
  private async openLogin(): Promise<void> {
    const statuses = await this.options.models!.providers();
    const picker = new Picker("Sign in to", statuses.map((provider): PickerItem => ({
      label: provider.name, detail: provider.signIn === "chatgpt" ? "with your ChatGPT plan" : "with an API key", value: provider.id,
      note: provider.via === "environment" ? `key from ${provider.keyEnv}` : provider.signedIn ? "signed in" : "sign in", noteTone: provider.signedIn ? "faint" : "accent" })));
    this.panel = { kind: "pick", picker, choose: (item) => this.signIn(item.value as ProviderId) };
    this.scheduler.request();
  }

  /** /logout: the sign-ins Kumi keeps; a key from the environment is Kumi's to use, not to remove. */
  private async openLogout(): Promise<void> {
    const models = this.options.models!;
    const statuses = (await this.options.models!.providers()).filter((provider) => provider.signedIn);
    if (!statuses.length) { this.notice("You're not signed in to any provider.", "info"); return; }
    const picker = new Picker("Sign out of", statuses.map((provider): PickerItem => ({
      label: provider.name, value: provider.id, ...(provider.via === "environment" ? { inert: true, detail: `Its key comes from ${provider.keyEnv}; unset it to sign out` }
        : { detail: provider.via === "chatgpt" ? "Your ChatGPT sign-in" : "The key saved in Kumi" }) })));
    this.panel = { kind: "pick", picker, choose: (item) => {
      const provider = item.value as ProviderId; const name = PROVIDER_INFO[provider].name;
      const { keyEnv } = PROVIDER_INFO[provider];
      const shared = PROVIDER_INFO[provider].credential === "opencode" ? " (OpenCode Zen and Go share it)" : "";
      const confirm = new Picker(`Sign out of ${name}?`, [
        { label: "Sign out", detail: `Kumi forgets this sign-in${shared}`, value: "yes" },
        { label: "Keep it", value: "no" },
      ]);
      this.panel = { kind: "pick", picker: confirm, choose: async (answer) => {
        this.closePanel();
        if (answer.value !== "yes") return;
        const removed = await models.signOut(provider);
        const still = (await models.providers()).find((status) => status.id === provider)?.via === "environment" ? ` ${keyEnv} is still set, so Kumi uses that key now.` : "";
        this.notice(`${removed ? `Signed out of ${name}.` : `Kumi had no sign-in for ${name} to remove.`}${still}`, "info");
      } };
      this.scheduler.request();
    } };
    this.scheduler.request();
  }

  /** /memory: the notes Kumi keeps, about the producer and this Set; choosing one offers to forget it. */
  private async openMemory(): Promise<void> {
    const { controller } = this.options;
    const memory = await controller.memory?.();
    if (!memory) return;
    const now = Date.now();
    const rows = (notes: typeof memory.producer): PickerItem[] => notes.slice().reverse().map((note) => ({ label: note.text, value: note.id, note: since(note.at, now), noteTone: "faint" }));
    const setName = memory.setName ?? "this Set";
    const items: PickerItem[] = [
      { heading: true, label: "About you" },
      ...(memory.producer.length ? rows(memory.producer) : [{ label: "Nothing yet", inert: true }]),
      { heading: true, label: `About ${setName}` },
      ...(!memory.saved ? [{ label: "Kept once the Set is saved", inert: true }] : memory.set.length ? rows(memory.set) : [{ label: "Nothing yet", inert: true }]),
    ];
    const picker = new Picker("What Kumi remembers · what you tell it that Live can't show", items, { filterable: true });
    this.panel = { kind: "pick", picker, choose: (item) => {
      const confirm = new Picker("Forget this note?", [
        { label: "Forget it", detail: item.label, value: "yes" },
        { label: "Keep it", value: "no" },
      ]);
      this.panel = { kind: "pick", picker: confirm, choose: async (answer) => {
        this.closePanel();
        if (answer.value !== "yes") return;
        if (!await controller.forget?.(item.value!)) this.notice("That note was already gone.", "info");
      } };
      this.scheduler.request();
    } };
    this.scheduler.request();
  }

  /**
   * /recipes: the producer's saved ways of working. Choosing one runs it (straight away when it
   * has no blanks; otherwise the box is filled in to say what to run it on) or forgets it.
   */
  private async openRecipes(): Promise<void> {
    const { controller } = this.options;
    const recipes = await controller.recipes?.() ?? [];
    const now = Date.now();
    const items: PickerItem[] = recipes.length ? recipes.map((recipe) => ({ label: recipe.name, detail: recipe.about, value: recipe.name,
      note: recipe.used ? `used ${since(recipe.lastUsed ?? recipe.created, now)}` : `${recipe.steps} steps`, noteTone: "faint" as const }))
      : [{ label: "None yet: ask Kumi to save a way of working, or say “watch me” and do it in Live", inert: true }];
    const picker = new Picker("Your recipes · ways of working Kumi replays without planning again", items, { filterable: true });
    this.panel = { kind: "pick", picker, choose: (item) => {
      const recipe = recipes.find((candidate) => candidate.name === item.value)!;
      const blanks = recipe.params.map((param) => param.about || param.name).join(", ");
      const actions = new Picker(`“${recipe.name}” · ${recipe.steps} steps`, [
        { label: recipe.params.length ? "Run it on…" : "Run it now", detail: recipe.params.length ? `Kumi needs: ${blanks}` : recipe.about, value: "run" },
        { label: "Forget it", value: "forget" },
        { label: "Keep it", value: "keep" },
      ]);
      this.panel = { kind: "pick", picker: actions, choose: async (answer) => {
        this.closePanel();
        if (answer.value === "forget") { if (!await controller.forgetRecipe?.(recipe.name)) this.notice("That recipe was already gone.", "info"); return; }
        if (answer.value !== "run") return;
        // With blanks, the producer says what to run it on, in their own words.
        if (recipe.params.length) { this.editor.set(`Run my recipe “${recipe.name}” on `); this.scheduler.request(); return; }
        if (this.busy) { this.notice("Kumi is still working. Press esc to stop it first.", "info"); return; }
        this.activity = `running “${recipe.name}”`;
        const outcome = await controller.runRecipe?.(recipe.name).catch((error: unknown) => ({ text: safeError(error, this.secrets), isError: true }));
        if (outcome) this.notice(outcome.isError ? `The recipe stopped: ${outcome.text}` : outcome.text, outcome.isError ? "warn" : "info");
      } };
      this.scheduler.request();
    } };
    this.scheduler.request();
  }

  /** Sign in to `provider` (a pasted key, or ChatGPT in the browser), then carry on with `then`. */
  private signIn(provider: ProviderId, then?: () => void | Promise<void>): void {
    const models = this.options.models;
    if (!models) return;
    if (PROVIDER_INFO[provider].signIn === "api-key") {
      this.panel = { kind: "key", provider, secret: "", ...(then ? { then } : {}) };
      this.scheduler.request();
      return;
    }
    const abort = new AbortController();
    const panel: Extract<Panel, { kind: "chatgpt" }> = { kind: "chatgpt", abort, ...(then ? { then } : {}) };
    this.panel = panel;
    this.scheduler.request();
    void models.signInChatGPT({ signal: abort.signal, onUrl: (url) => { panel.url = url; openBrowser(url); this.scheduler.request(); } })
      .then(async () => {
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.notice("Signed in to ChatGPT.", "info");
        await panel.then?.();
      })
      .catch((error: unknown) => {
        if (this.panel === panel) this.panel = undefined;
        if (!abort.signal.aborted && !this.closing) this.notice(`The ChatGPT sign-in didn't finish: ${safeError(error, this.secrets)}`, "warn");
      })
      .finally(() => this.scheduler.request());
  }

  /** Check the pasted key with its provider; keep it unless the provider refuses it. */
  private async submitKey(panel: Extract<Panel, { kind: "key" }>): Promise<void> {
    const models = this.options.models!;
    const name = PROVIDER_INFO[panel.provider].name;
    const key = panel.secret;
    panel.checking = true; panel.status = { text: `Checking the key with ${name}…`, tone: "info" };
    this.scheduler.request();
    let verdict: "ok" | "refused" | "unreachable";
    try { verdict = await models.saveKey(panel.provider, key); }
    catch (error) { panel.checking = false; panel.status = { text: safeError(error, [...this.secrets, key]), tone: "warn" }; this.scheduler.request(); return; }
    if (verdict === "refused") {
      panel.checking = false; panel.secret = "";
      panel.status = { text: `${name} didn't accept that key. Paste it again, or esc to leave it.`, tone: "warn" };
      this.scheduler.request();
      return;
    }
    this.secrets.push(key);
    panel.secret = "";
    if (this.panel === panel) this.panel = undefined;
    this.notice(verdict === "ok" ? `Signed in to ${name}.` : `Kept your ${name} key; ${name} didn't answer just now, so it isn't checked yet.`, "info");
    try { await panel.then?.(); } catch (error) { this.panelFailed(error); }
    this.scheduler.request();
  }

  /** After a failed answer, the fix for what failed: sign in there, or another model. */
  private offerFix(kind: string, provider: string | undefined): void {
    const models = this.options.models;
    if (!models || this.panel) return;
    if (kind === "config" && !models.current().model) { void this.openModels().catch((error: unknown) => this.panelFailed(error)); return; }
    if (kind === "model" || kind === "config") {
      this.panel = { kind: "pick", picker: new Picker("Choose another model?", [{ label: "Choose a model", value: "model" }, { label: "Not now", value: "later" }]),
        choose: (item) => { this.closePanel(); if (item.value === "model") return this.openModels(); } };
      this.scheduler.request();
      return;
    }
    if (kind !== "auth" || !provider || !(provider in PROVIDER_INFO)) return;
    const info = PROVIDER_INFO[provider as ProviderId];
    this.panel = { kind: "pick", picker: new Picker(`Sign in to ${info.name}?`, [
      { label: "Sign in now", detail: info.signIn === "chatgpt" ? "with your ChatGPT plan, in the browser" : "with an API key", value: "signin" },
      { label: "Choose another model", value: "model" },
      { label: "Not now", value: "later" },
    ]), choose: (item) => {
      this.closePanel();
      if (item.value === "signin") this.signIn(provider as ProviderId, () => this.resend());
      else if (item.value === "model") return this.openModels();
    } };
    this.scheduler.request();
  }

  /** Send the message that was waiting for a sign-in again, when nothing's running. */
  private resend(): void {
    if (!this.lastSent || this.busy) return;
    this.notice("Sending your message again.", "info");
    void this.send(this.lastSent);
  }

  /**
   * At startup. No model yet: the first one a signed-in provider lists, said so; signed in
   * nowhere, the choice of where. A model whose provider isn't signed in: the offer to sign in.
   */
  private async checkModel(): Promise<void> {
    const models = this.options.models;
    if (!models || this.panel || this.closing) return;
    const current = models.current();
    if (!current.model) {
      const chosen = await models.chooseDefault();
      if (this.closing) return;
      if (chosen) { this.notice(`Kumi talks to ${chosen.name}, ${PROVIDER_INFO[chosen.provider].name}'s first choice. /model changes it.`, "info"); return; }
      this.notice("Sign in to a provider to talk to its models: ChatGPT with your plan, or others with an API key.", "info");
      if (!this.panel) await this.openModels();
      return;
    }
    const status = (await models.providers()).find((provider) => provider.id === current.provider);
    if (status && !status.signedIn) this.offerFix("auth", status.id);
  }

  /** Start a turn for a message already shown in the conversation. */
  private async send(raw: string): Promise<void> {
    if (this.closing) return;
    this.activity = "thinking";
    this.pendingTurn = true;
    this.scheduler.request();
    try { await this.options.controller.submit(raw); }
    catch (error) {
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
    let cursor: Cursor | undefined = this.drawComposer(screen, { x: 1, y: boxTop, width: left - 2, height: boxHeight }, layout, visibleRows);
    if (this.panel) cursor = this.drawPanel(screen, this.panel, boxTop, left);
    else this.drawMenu(screen, boxTop, left);
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
    // The model gives way to the Set's name when the window is narrow.
    let end = start - 2;
    const model = this.modelLabel();
    if (model) {
      const text = truncate(model, 36);
      const at = start - 3 - textWidth(text);
      if (at - (x + (this.setName ? Math.min(textWidth(this.setName), 16) + 5 : 0)) >= 2) {
        screen.put(at, 0, text, this.options.models?.current().model ? st.faint : st.warn);
        end = at - 3;
      }
    }
    if (this.setName) {
      x = screen.put(x, 0, "  ·  ", st.faint);
      screen.put(x, 0, truncate(this.setName, Math.max(0, end - x)), st.text);
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
      const dot = blink ? st.accent : st.pulse;
      const running = this.current?.steps.at(-1)?.state === "running" ? this.current.steps.at(-1) : undefined;
      // How many changes this answer has made so far; a plan's show one by one as they land.
      const label = this.turnChanges ? `working · ${this.turnChanges} ${this.turnChanges === 1 ? "change" : "changes"}` : "working";
      const action = this.lastAction && performance.now() - this.lastAction.at < CHANGE_FLASH_MS ? this.lastAction : undefined;
      if (action && (!flash || action.at > this.lastChange!.at) && (!running || running.tool === "make_changes" || ACTION_TOOLS.has(running.tool ?? ""))) return { dot, label, detail: `${action.glyph} ${action.title}`, detailStyle: st.bright };
      if (flash && (!running || running.tool === "make_changes")) return { dot, label, detail: `✓ ${flash.title}`, detailStyle: st.bright };
      if (running) return { dot, label, detail: doingLabel(running.tool, running.label), detailStyle: st.dim };
      if (this.planning) return { dot, label, detail: "writing the plan", detailStyle: st.dim };
      return { dot, label, detail: this.current ? "thinking" : this.activity, detailStyle: st.dim };
    }
    if (flash) return { label: "", detail: `✓ ${flash.title}`, detailStyle: st.bright };
    const action = this.lastAction && performance.now() - this.lastAction.at < CHANGE_FLASH_MS ? this.lastAction : undefined;
    if (action) return { label: "", detail: `${action.glyph} ${action.title}`, detailStyle: st.bright };
    // Between "watch me" and "done", NOW says so: the producer is working in Live meanwhile.
    if (this.watching) return { dot: st.accent, label: "watching", detail: "Watching your changes in Live; tell Kumi when you're done", detailStyle: st.text };
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
    const picture = this.flashing() ? changePicture(this.flashing()!, width, this.depth) : undefined;
    picture?.slice(0, 2).forEach((line, row) => {
      let column = x;
      for (const part of line) column = screen.put(column, area.y + 8 + row, part.text, part.style);
    });
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
    const hint = this.panel?.kind === "pick" ? "↑↓ to move · enter to choose · esc to close" : this.panel?.kind === "key" ? "enter to save · esc to cancel"
      : this.panel?.kind === "chatgpt" ? (this.panel.url ? "c copies the link · esc to cancel" : "esc to cancel")
      : this.menu().length ? "enter to choose · esc to close" : this.busy ? "esc to stop" : "enter to send";
    if (textWidth(hint) + 2 < width) screen.put(box.x + box.width - 2 - textWidth(hint), box.y + box.height - 1, hint, st.faint);
    return { x: x + layout.cursorColumn, y: box.y + 1 + layout.cursorRow - first };
  }

  /**
   * The open panel, raised above the input box like the / menu: a title, then a list that keeps
   * the selection in view, or a key box that shows dots only. Returns where the cursor goes (in the
   * key box; nowhere otherwise).
   */
  private drawPanel(screen: Screen, panel: Panel, boxTop: number, left: number): Cursor | undefined {
    const width = Math.min(76, left - 2);
    const x = 3;
    const inner = width - 4;
    // Rows between the header and the input box, less the panel's padding.
    const space = boxTop - 5;
    const lines: PanelLine[] = [];
    // A sentence wraps rather than being cut off.
    const say = (text: string, style: Style) => {
      for (const row of wrap([{ text, style }], inner)) lines.push({ text: row.map((span) => span.text).join("").trimEnd(), style });
    };
    let cursorAt: { line: number; column: number } | undefined;
    if (panel.kind === "pick") {
      const { picker } = panel;
      const visible = picker.visible();
      const selected = picker.selected();
      const filter = picker.filter ? `filter: ${picker.filter}` : picker.options.filterable ? "type to filter" : undefined;
      lines.push({ text: picker.title, style: st.title, ...(filter ? { right: { text: filter, style: picker.filter ? st.bright : st.faint } } : {}) });
      if (!visible.length) lines.push({ text: `Nothing matches “${picker.filter}”.`, style: st.faint });
      const rows = Math.max(1, Math.min(14, space - 2));
      const at = selected ? visible.indexOf(selected) : 0;
      let first = Math.max(0, Math.min(at - Math.floor(rows / 2), visible.length - rows));
      // The selection's heading comes along when it's just above the window.
      if (first > 0 && visible[first - 1]?.heading && at - first < rows - 1) first--;
      const shown = visible.slice(first, first + rows);
      const labelWidth = Math.min(28, Math.max(0, ...shown.filter((item) => !item.heading && item.detail).map((item) => textWidth(item.label))));
      shown.forEach((item, index) => {
        const note = item.note ? { text: item.note, style: item.noteTone === "accent" ? st.accent : item.noteTone === "warn" ? st.warn : st.faint } : undefined;
        const more = index === 0 && first > 0 ? `↑ ${first} more` : index === shown.length - 1 && first + rows < visible.length ? `↓ ${visible.length - first - rows} more` : undefined;
        const right = note ?? (more ? { text: more, style: st.faint } : undefined);
        if (item.heading) { lines.push({ text: item.label, style: st.label, ...(right ? { right } : {}) }); return; }
        const chosen = item === selected;
        lines.push({ text: item.label, style: item.inert ? st.faint : chosen ? st.accent : st.text, indent: 2, band: chosen, labelWidth,
          ...(item.detail ? { detail: { text: item.detail, style: chosen ? st.bright : st.dim } } : {}), ...(right ? { right } : {}) });
      });
    } else if (panel.kind === "key") {
      const info = PROVIDER_INFO[panel.provider];
      lines.push({ text: `Sign in to ${info.name}`, style: st.title });
      say(`Paste your ${info.name} API key. It stays hidden, even here.`, st.dim);
      const dots = "•".repeat(Math.min(panel.secret.length, Math.max(8, inner - 20)));
      lines.push({ text: dots, style: st.bright, band: true, ...(panel.secret ? { right: { text: `${panel.secret.length} characters`, style: st.faint } } : {}) });
      if (!panel.checking) cursorAt = { line: lines.length - 1, column: textWidth(dots) };
      if (panel.status) say(panel.status.text, panel.status.tone === "warn" ? st.warn : st.dim);
      else if (info.keyPage) say(`Make one at ${info.keyPage}.`, st.faint);
      say(`Kumi checks it with ${info.name}, then keeps it in ~/.kumi, readable only by you.`, st.faint);
    } else {
      lines.push({ text: "Sign in to ChatGPT", style: st.title });
      if (!panel.url) say("Starting the sign-in…", st.dim);
      else {
        say("Finish in your browser. If it didn't open, open this link (c copies it):", st.dim);
        const parts = chunk(panel.url, inner);
        // A very long link keeps its start; c still copies all of it.
        for (const part of parts.slice(0, Math.max(1, space - 4))) lines.push({ text: part, style: st.accent });
        lines.push({ text: "Waiting for the browser…", style: st.faint });
      }
    }
    // Padding above, a gap under the title, padding below; the gap goes when space is short.
    const gap = lines.length + 3 <= boxTop - 2 ? 1 : 0;
    const height = lines.length + gap + 2;
    const top = Math.max(1, boxTop - 1 - height);
    screen.fill({ x: 1, y: top, width, height: Math.min(height, boxTop - 1 - top) }, st.raised);
    const rowOf = (index: number) => top + 1 + index + (index > 0 ? gap : 0);
    lines.forEach((line, index) => {
      const y = rowOf(index);
      if (y >= boxTop - 1) return;
      if (line.band) screen.fill({ x: 1, y, width, height: 1 }, st.selected);
      const start = x + (line.indent ?? 0);
      const end = x + inner - (line.right ? textWidth(line.right.text) + 2 : 0);
      const label = truncate(line.text, Math.max(1, end - start));
      let column = screen.put(start, y, label, line.style);
      if (line.detail) {
        column = Math.max(column, start + (line.labelWidth ?? 0)) + 2;
        if (column < end) screen.put(column, y, truncate(line.detail.text, end - column), line.detail.style);
      }
      if (line.right) screen.put(x + inner - textWidth(line.right.text), y, line.right.text, line.right.style);
    });
    return cursorAt && rowOf(cursorAt.line) < boxTop - 1 ? { x: x + cursorAt.column, y: rowOf(cursorAt.line) } : undefined;
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
/** NOW's picture of a change, a line or two: a value moving within its span, or a new clip's notes. */
export function changePicture(change: ChangeRecord, width: number, depth: ColorDepth = "truecolor"): { text: string; style: Style }[][] | undefined {
  if (change.clip) return clipPicture(change.clip, width);
  if (change.devices) return devicesPicture(change.devices, width);
  if (change.colors) {
    // Swatches need colours: 16 fold Live's 70 into a few (two different colours could look the same), and none show nothing.
    if (depth === "16" || depth === "none") return undefined;
    // Drawn like HISTORY's chips, so dark colours stay visible on the pane.
    const swatch = (color: string): { text: string; style: Style } => ({ text: "████", style: { fg: chipColor(color) } });
    return [[...(change.colors.from ? [swatch(change.colors.from), { text: " → ", style: st.faint }] : []), swatch(change.colors.to)]];
  }
  if (change.from === undefined || change.to === undefined || !change.range) return undefined;
  const [min, max] = change.range;
  if (!(max > min)) return undefined;
  const cells = Math.max(4, Math.min(12, Math.floor((width - 3) / 2)));
  const bar = (value: number) => {
    const filled = Math.round(Math.min(1, Math.max(0, (value - min) / (max - min))) * cells);
    return "█".repeat(filled) + "░".repeat(cells - filled);
  };
  return [[{ text: bar(change.from), style: st.faint }, { text: " → ", style: st.faint }, { text: bar(change.to), style: st.accent }]];
}

type Span = { text: string; style: Style };

/**
 * Devices in the order sound goes through them, "Operator → Reverb → Saturator", the one at
 * `lit` bright. When they don't fit, the lit one stays and the far ends give way to "…".
 */
function deviceRow(devices: string[], lit: number | undefined, room: number): Span[] {
  const names = devices.map((name) => truncate(name || "Device", 16));
  if (!names.length) return [{ text: "empty", style: st.faint }];
  const arrow = " → "; const cost = (from: number, to: number) => names.slice(from, to + 1).reduce((sum, name) => sum + textWidth(name), 0) + arrow.length * (to - from) + (from > 0 ? 4 : 0) + (to < names.length - 1 ? 4 : 0);
  let first = lit !== undefined && lit >= 0 && lit < names.length ? lit : names.length - 1; let last = first;
  for (let grew = true; grew;) {
    grew = false;
    if (last < names.length - 1 && cost(first, last + 1) <= room) { last++; grew = true; }
    if (first > 0 && cost(first - 1, last) <= room) { first--; grew = true; }
  }
  const spans: Span[] = first > 0 ? [{ text: "…", style: st.faint }, { text: arrow, style: st.faint }] : [];
  names.slice(first, last + 1).forEach((name, offset) => {
    if (offset) spans.push({ text: arrow, style: st.faint });
    spans.push({ text: name, style: first + offset === lit ? st.accent : st.dim });
  });
  if (last < names.length - 1) spans.push({ text: arrow, style: st.faint }, { text: "…", style: st.faint });
  return spans;
}

/**
 * Where a loaded device went, in two lines at most: a track's devices in a row, or a rack's
 * chains stacked like the parallel branches they are, the chain it went into and a neighbour,
 * with the new device (or a new, empty chain's name) lit.
 */
function devicesPicture(placement: DevicePlacement, width: number): Span[][] | undefined {
  const chains = placement.chains ?? [];
  if (!chains.length) return placement.devices?.length ? [deviceRow(placement.devices, placement.index, width)] : undefined;
  const focus = Math.min(chains.length - 1, Math.max(0, placement.chain ?? 0));
  const shown = chains.length === 1 ? [focus] : focus < chains.length - 1 ? [focus, focus + 1] : [focus - 1, focus];
  const more = chains.length - shown.length;
  const nameWidth = Math.min(10, Math.max(...shown.map((index) => textWidth(chains[index]!.name))));
  const newChain = placement.index === undefined;
  return shown.map((index, line) => {
    const glyph = shown.length === 1 ? "╶ " : line === 0 ? "╭ " : "╰ ";
    const name = truncate(chains[index]!.name, nameWidth); const tail = line === shown.length - 1 && more ? `  +${more}` : "";
    const room = Math.max(8, width - 2 - nameWidth - 2 - tail.length);
    return [{ text: glyph, style: st.faint }, { text: name + " ".repeat(Math.max(0, nameWidth - textWidth(name))) + "  ", style: index === focus ? newChain ? st.accent : st.text : st.faint },
      ...deviceRow(chains[index]!.devices, index === focus && !newChain ? placement.index : undefined, room), ...(tail ? [{ text: tail, style: st.faint }] : [])];
  });
}

/** Braille dots for a cell's 2×4 grid, by row then column. */
const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const;

/**
 * A clip as a tiny piano roll in braille, two rows high: time runs across, higher notes sit
 * higher, louder notes are brighter. Up to eight different pitches get a lane each, spread out;
 * more share lanes by pitch.
 */
function clipPicture(clip: NonNullable<ChangeRecord["clip"]>, width: number): { text: string; style: Style }[][] | undefined {
  if (!(clip.length > 0) || !clip.notes.length) return undefined;
  const cells = Math.max(8, Math.min(32, width));
  const columns = cells * 2;
  const pitches = [...new Set(clip.notes.map((note) => note.pitch))].sort((a, b) => b - a);
  const high = pitches[0]!; const low = pitches[pitches.length - 1]!;
  const lane = (pitch: number) => pitches.length === 1 ? 3
    : pitches.length <= 8 ? Math.round(pitches.indexOf(pitch) * 7 / (pitches.length - 1)) : Math.round((high - pitch) * 7 / (high - low));
  // The loudest velocity at each dot, 0 where there's no note.
  const dots = Array.from({ length: 8 }, () => Array<number>(columns).fill(0));
  for (const note of clip.notes) {
    const first = Math.min(columns - 1, Math.max(0, Math.floor(note.start / clip.length * columns)));
    const last = Math.max(first, Math.min(columns - 1, Math.ceil((note.start + note.duration) / clip.length * columns) - 1));
    const row = dots[lane(note.pitch)]!;
    for (let column = first; column <= last; column++) row[column] = Math.max(row[column]!, note.velocity);
  }
  return [0, 1].map((textRow) => {
    const spans: { text: string; style: Style }[] = [];
    for (let cell = 0; cell < cells; cell++) {
      let bits = 0; let loudest = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
        const velocity = dots[textRow * 4 + dy]![cell * 2 + dx]!;
        if (velocity) { bits |= BRAILLE[dy]![dx]!; loudest = Math.max(loudest, velocity); }
      }
      const style = loudest >= 64 ? st.accent : st.dim;
      const text = String.fromCharCode(0x2800 + bits);
      const previous = spans[spans.length - 1];
      if (previous && previous.style === style) previous.text += text; else spans.push({ text, style });
    }
    return spans;
  });
}

/** `text` in pieces of `width` cells, for a link that must stay whole to be copied. */
function chunk(text: string, width: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += Math.max(1, width)) parts.push(text.slice(at, at + Math.max(1, width)));
  return parts;
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
