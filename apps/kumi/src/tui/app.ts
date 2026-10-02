/**
 * Kumi's full-screen terminal app: a header, the conversation, the Live pane (FOCUS, NOW,
 * HISTORY) and the input box, drawn over a SessionController. See docs/en/KUMI_TUI.md.
 */
import {
  FORGET_RECIPE_TOOL, FORGET_TOOL, KumiError, PROVIDER_INFO, REMEMBER_TOOL, SAVE_RECIPE_TOOL, since, type CatchUp, type ChangeRecord, type ConnectionState, type ArrangementStrip, type ClipNote, type ClipView, type DevicePlacement, type DeviceTree, type Effort, type LiveFocus, type LiveTransport, type ModelInfo, type ProviderId,
  type GoalStatus, type MatchStatus, type PinnedNode, type RecipeSummary, type SessionController, type SessionEvent, type SessionStrip, type TurnResult,
} from "@kumi/runtime";
import { safeError } from "../config.js";
import type { InputHistory } from "../history.js";
import type { ModelControl } from "../models.js";
import { sanitizeText, StreamingText, webWords } from "../text.js";
import type { UpdateControl } from "../update.js";
import { Editor, type EditorLayout } from "./editor.js";
import { Picker, type PickerItem } from "./picker.js";
import type { InputEvent } from "./keys.js";
import { Renderer, type Cursor } from "./render.js";
import { FrameScheduler } from "./scheduler.js";
import { Screen, type Rect } from "./screen.js";
import { detectColorDepth, hex, palette, StyleTable, type ColorDepth, type Rgb, type Style } from "./style.js";
import { doingLabel, MEMORY_GLYPHS, stepLabel, Transcript, type Entry, type MemoryKind, type Row } from "./transcript.js";
import { renderMarkdown } from "./markdown.js";
import { activityGlyph, activityOf, activityScene, shimmer, type Activity } from "./activity.js";
import { Tty, type TtyInput, type TtyOutput } from "./tty.js";
import { detectIconStyle, icon, trackKind, type IconKind, type IconStyle } from "./icons.js";
import { LOGO_HEIGHT, LOGO_LETTERS, LOGO_RULE, LOGO_WIDTH } from "./logo.js";
import { treeRows, treeWindow, type TreeRow } from "./tree.js";
import { TabPanel, type Tab, type TabRow } from "./tabs.js";
import { textWidth, truncate } from "./width.js";
import { wrap, type Span as TextSpan } from "./wrap.js";

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
  /** What the producer typed before, for the up arrow; kept across /new, reconnects and restarts. */
  history?: InputHistory;
  /** Opens a sign-in link in the producer's browser; without it the link is only shown (tests). */
  openBrowser?: (url: string) => void;
  /** Icons as glyphs or two-letter badges; found from the terminal when left out. */
  icons?: IconStyle;
  /** More tabs after HISTORY in the pane's lower half (none in 1.0; tests add one). */
  tabs?: readonly Tab[];
  /** Which tab showed last, kept across restarts. */
  panelTab?: { load(): string | undefined; save(id: string): void };
  /** Kumi's updates: /update, and a newer Kumi on the welcome screen. Without it, neither shows. */
  updates?: UpdateControl;
}

type Assistant = Extract<Entry, { kind: "assistant" }>;

/**
 * What's open above the input box: a list to choose from, a key being pasted (never shown), or a
 * ChatGPT sign-in waiting in the browser.
 */
type Panel =
  | { kind: "pick"; picker: Picker; choose(item: PickerItem): void | Promise<void> }
  | { kind: "key"; provider: ProviderId; secret: string; checking?: boolean; status?: { text: string; tone: "info" | "warn" }; then?: () => void | Promise<void> }
  | { kind: "chatgpt"; url?: string; abort: AbortController; then?: () => void | Promise<void> }
  /** A side question (/btw) and its answer as it comes; `at` is which of this session's side questions shows. */
  | { kind: "btw"; at: number; scroll: number };

/** A side question asked with /btw, and its answer (never part of the conversation). */
interface Aside { question: string; answer: string; state: "asking" | "done" | "failed"; abort: AbortController }

/** A row of a panel: text, a dimmer detail beside it, a note at the right edge. */
interface PanelLine {
  text: string;
  style: Style;
  detail?: { text: string; style: Style };
  right?: { text: string; style: Style };
  /** The selected row. */
  band?: boolean;
  /** Styled text in place of `text` (a side answer's markdown). */
  spans?: TextSpan[];
  indent?: number;
  /** Labels in a list share a column, so their details line up. */
  labelWidth?: number;
}

/** For efforts whose provider doesn't describe them. */
const EFFORT_WORDS: Record<Effort, string> = { low: "Fastest; lighter thinking", medium: "Balanced", high: "Thorough", xhigh: "More thorough still", max: "As hard as it can" };

const COMMANDS = [
  { name: "/new", about: "Forget this conversation and start fresh" },
  { name: "/btw", about: "Ask something on the side, without interrupting Kumi" },
  { name: "/conversations", about: "Go back to an earlier conversation about this Set" },
  { name: "/reconnect", about: "Connect to Live again, keeping the conversation" },
  { name: "/undo", about: "Undo Kumi's last change" },
  { name: "/stop", about: "Stop Live: clips, the transport and recording" },
  { name: "/refresh", about: "Read your Live Set again" },
  { name: "/copy", about: "Copy Kumi's last answer" },
  { name: "/model", about: "Choose the model Kumi talks to" },
  { name: "/effort", about: "How hard the model thinks" },
  { name: "/login", about: "Sign in to a provider" },
  { name: "/goal", about: "Go after a sound until Kumi gets there" },
  { name: "/memory", about: "What Kumi remembers" },
  { name: "/recipes", about: "Your saved ways of working" },
  { name: "/logout", about: "Sign out of a provider" },
  { name: "/status", about: "What Kumi is connected to" },
  { name: "/update", about: "Get the newest Kumi" },
  { name: "/help", about: "Keys and commands" },
  { name: "/quit", about: "Close Kumi" },
] as const;

const MENU_NAME_WIDTH = Math.max(...COMMANDS.map((command) => command.name.length));

/** Keeping notes and recipes shows as a line of its own, not a step. */
const QUIET_TOOLS: readonly string[] = [REMEMBER_TOOL, FORGET_TOOL, SAVE_RECIPE_TOOL, FORGET_RECIPE_TOOL];
/** Kumi's tools that act in Live without changing the Set. */
const ACTION_TOOLS: ReadonlySet<string> = new Set(["play", "fire_scene", "launch_clip", "record", "jump_to_locator", "select", "show"]);
/** Offered only with a ModelControl to answer them. */
const MODEL_COMMANDS: readonly string[] = ["/model", "/effort", "/login", "/logout"];
/** "/model" or "/nope" is a command; "/Users/me/ref.wav", a file dragged into the terminal, is a message. */
export const isCommand = (text: string) => /^\/[A-Za-z]+(?:\s|$)/.test(text);

const HELP = "enter sends · ctrl+j or alt+enter starts a new line · ↑ and ↓ go through what you sent before · while Kumi works, enter sends a message it reads after the step under way, tab one for after the answer, and alt+↑ takes the last waiting one back · /btw asks something on the side without interrupting · esc stops Kumi · page up/down or the mouse wheel scroll, ctrl+home goes to the start and ctrl+end back · click undo in HISTORY, or /undo, to take back a change · /new starts a fresh conversation, and /conversations goes back to an earlier one · /reconnect connects to Live again, keeping the conversation · /copy copies the last answer; to select text yourself, hold Shift while dragging (Option in iTerm2) · /model and /effort choose the model and how hard it thinks; /login and /logout sign in and out · /memory shows what Kumi remembers (notes, techniques and recipes), and forget in MEMORY drops one; /recipes your saved ways of working · /update gets the newest Kumi · ctrl+c clears the box, then quits · type / for commands";
/** How long NOW shows a change Kumi just made. */
const CHANGE_FLASH_MS = 4_000;
/** How often FOCUS's tree is read again while it shows. */
const TREE_REFRESH_MS = 4_000;
/** And the Arrangement strip, whose playhead moves. */
const STRIP_REFRESH_MS = 1_500;
const WIDE = 100;
/** Past this an answer is stopped: a model writing without end, not an answer to read (a long one is a few tens of KB). */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FAREWELL = "Kumi closed. Each Set's conversation continues next time.";

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

type Touched = "device" | "clip" | "session" | "arrangement";

/**
 * What FOCUS shows, from what the producer last touched in Live: switching Session and Arrangement, a
 * scene, a clip (in the Session; an Arrangement clip shows the Arrangement), or a device. Live's
 * bottom panel nearly always shows a device or a clip, so what changed last says where they are.
 */
export function touchedNext(before: LiveFocus | null, after: LiveFocus | null, was: Touched | undefined): Touched | undefined {
  if (!after) return undefined;
  const clip = (): Touched => (after.view === "Arrangement" ? "arrangement" : "clip");
  const view = (): Touched => (after.view === "Arrangement" ? "arrangement" : "session");
  if (!before) return after.detail === "Clip" ? clip() : after.detail === "Device" ? "device" : view();
  if (after.view !== before.view) return view();
  if (after.sceneIndex !== before.sceneIndex && after.view === "Session") return "session";
  if (after.detail === "Clip" && (before.detail !== "Clip" || after.slotRef !== before.slotRef || after.clip !== before.clip)) return clip();
  if (after.detail === "Device" && (before.detail !== "Device" || after.device !== before.device || after.chain !== before.chain || after.trackRef !== before.trackRef)) return "device";
  return was ?? view();
}

/** "Current open Set: Night Drive — Remote Script · real-live" → "Night Drive". */
export function setNameFrom(label: string): string | undefined {
  const match = /^Current open Set: (.*) — [^—]*$/.exec(label);
  return match?.[1]?.trim() || undefined;
}

/** "3:05": minutes and seconds (hours when it's gone that long). */
const clockOf = (ms: number) => { const whole = Math.max(0, Math.floor(ms / 1000)); const hours = Math.floor(whole / 3600); const minutes = Math.floor((whole % 3600) / 60); const seconds = String(whole % 60).padStart(2, "0"); return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`; };

/** "3.1s": how long a step or an answer has taken. */
const elapsed = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
/** How much of each beat the beat light stays lit. */
const BEAT_LIT = 0.25;
const mixRgb = (from: Rgb, to: Rgb, amount: number): Rgb => [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * amount)) as unknown as Rgb;

/** The icon of what the producer pointed at in Live. */
function pointedIcon(pin: PinnedNode): IconKind {
  if (pin.node === "track") return "midi-track";
  if (pin.node === "scene") return "scene";
  if (pin.node === "clip" || pin.node === "selection" || pin.node === "clip-slot") return "midi-clip";
  if (pin.node === "chain") return "chain";
  return "device";
}

export class TuiApp {
  private readonly tty: Tty;
  private readonly renderer: Renderer;
  private readonly scheduler: FrameScheduler;
  private readonly table = new StyleTable();
  private readonly editor = new Editor();
  /** What this session's answers took, for /status on an API key. */
  private readonly used = { input: 0, output: 0, cached: 0, answers: 0 };
  private readonly icons: IconStyle;
  /** The right pane's lower half: tabs, HISTORY the first. */
  private readonly tabs: TabPanel;
  private tabsArea: Rect | undefined;
  /** FOCUS's device view: the focused track's devices, read when the track or its selected device changes. */
  private tree: DeviceTree | undefined;
  private treeKey: string | undefined;
  private treeReading = false;
  private treeAgain = false;
  /** While the tree or the clip shows, it's read again now and then: what changed in Live by hand shows. */
  private treeRefresh: ReturnType<typeof setInterval> | undefined;
  /** FOCUS's MIDI view: the highlighted Session slot's clip, read when the slot, the clip or the selected notes change. */
  private clip: ClipView | undefined;
  private clipKey: string | undefined;
  private clipReading = false;
  private clipAgain = false;
  /** FOCUS's Session and Arrangement strips: read when what they show changes, and now and then while they show. */
  /** What the producer last touched in Live, which FOCUS shows: a device (the tree), a Session clip, the Session or the Arrangement. */
  private touched: Touched | undefined;
  private strip: { session?: SessionStrip | undefined; arrangement?: ArrangementStrip | undefined; key?: string; reading?: boolean } = {};
  /** The keyboard's place in the tree (Tab moves into it); undefined while typing. */
  private treeCursor: number | undefined;
  /** What the producer points at: shown above the input box and sent with each message until cleared. */
  private pinned: (PinnedNode & { kind: IconKind }) | undefined;
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
  /** A newer Kumi's version, once the startup check or /update found one. */
  private newer: string | undefined;
  /** Kumi's changes in the order they happened; each keeps its latest state. */
  private changes: ChangeRecord[] = [];
  private lastChange: { id: string; at: number } | undefined;
  /** The latest thing Kumi did in Live that isn't a change (playing, recording), for NOW. */
  /** What NOW shows for a moment: something Kumi did in Live, or kept (`memory`: shown whatever tool is running). */
  private lastAction: { title: string; at: number; glyph: string; memory?: boolean } | undefined;
  /** The goal being pursued (or the last one): the dashboard's numbers, and since when. */
  private goal: (GoalStatus & { since: number }) | undefined;
  /** A match run at work: its best score, where it started, and since when. */
  private match: (MatchStatus & { since: number }) | undefined;
  /** What Kumi kept this session (notes, techniques, recipes), oldest first, for MEMORY: each with its forget. */
  private kept: { key: string; what: MemoryKind; title: string; forgotten?: boolean; forget: () => Promise<boolean> }[] = [];
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
  /**
   * Messages typed while Kumi works. "now" ones go into the answer under way at its next step (`taken`
   * once Kumi has them); "after" ones, and any it couldn't take, are sent as Kumi finishes, one an answer.
   */
  private held: { text: string; when: "now" | "after"; taken?: boolean }[] = [];
  /** How the last answer ended, for what happens to messages still waiting. */
  private lastStop: TurnResult["stopReason"] | undefined;
  /** This session's side questions (/btw), oldest first. */
  private asides: Aside[] = [];
  /** Live's transport, for the beat light; a timer draws the light's next change. */
  private transport: LiveTransport | null = null;
  private beatTimer: ReturnType<typeof setTimeout> | undefined;
  private activity = "connecting to Live";
  private panel: Panel | undefined;
  /** The model is writing a plan of changes (the call's id), which starts running as it's written; since when. */
  private planning: string | undefined;
  private planningSince = 0;
  /** When Kumi last became busy, for NOW's animation before an answer begins. */
  private busySince = 0;
  /** Changes Kumi made in the answer under way, for NOW. */
  private turnChanges = 0;
  /** Going through what was sent before with the up arrow: where, and what was being typed. */
  private recall: { index: number; draft: string } | undefined;
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
    this.icons = options.icons ?? detectIconStyle();
    const history: Tab = { id: "history", title: "HISTORY", empty: "Nothing changed yet", badge: () => this.changes.length || undefined, rows: (width) => this.historyRows(width) };
    const goal: Tab = { id: "goal", title: "GOAL", empty: "No goal yet: /goal and what to reach", rows: (width) => this.goalRows(width) };
    this.tabs = new TabPanel([history, ...(options.controller.goal ? [goal] : []), ...(options.tabs ?? [])], options.panelTab?.load(), (id) => options.panelTab?.save(id));
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
  /** A newer Kumi, found as Kumi started: the welcome screen says so, or, once the conversation has begun, a note. */
  offerUpdate(latest: string): void {
    if (this.closing || this.newer === latest) return;
    this.newer = latest;
    if (!this.transcript.isEmpty) this.notice(`Kumi ${latest} is out: /update gets it.`, "info");
    this.scheduler.request();
  }

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
            this.pendingTurn = false; this.lastStop = undefined;
            this.suppress = false; this.failed = false; this.bytes = 0; this.stream.discard();
            this.current = this.transcript.add({ kind: "assistant", text: "", steps: [], status: "running", startedAt: performance.now() }) as Assistant;
            this.scroll = 0;
            this.planning = undefined; this.turnChanges = 0;
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
        if (event.state === "idle") this.afterBusy();
        if ((event.state === "running" || event.state === "cancelling") && !this.busySince) this.busySince = performance.now();
        else if (event.state === "idle") this.busySince = 0;
        this.scheduler.setAnimating(event.state === "running" || event.state === "cancelling");
        break;
      case "connection":
        // The session says what happened and what Kumi does about it (a notice).
        this.connection = event.state;
        // Focus can arrive before the connection says so; the tree is read once it does. Gone, it goes.
        if (event.state === "connected") { this.readTree(true); this.readClip(true); this.readStrip(true); }
        else { this.tree = undefined; this.treeKey = undefined; this.treeCursor = undefined; this.clip = undefined; this.clipKey = undefined; this.strip = {}; }
        break;
      case "observation":
        this.setName = setNameFrom(event.label);
        break;
      case "focus":
        this.touched = touchedNext(this.focus, event.focus, this.touched);
        this.focus = event.focus;
        this.readTree();
        this.readClip();
        this.readStrip();
        break;
      case "pointed":
        // Right-clicked in Live ("Ask Kumi about this"): pinned like a row of FOCUS, for the next message.
        this.pinned = { ...event.pin, kind: pointedIcon(event.pin) };
        this.scheduler.request();
        break;
      case "resumed": {
        const when = since(event.savedAt, Date.now());
        if (event.chosen) this.transcript.add({ kind: "divider", text: `Back to your conversation from ${when}` });
        else if (event.unreadable) this.notice(`Your conversation from ${when}, which this model can't continue:`, "info");
        else this.notice(`Continuing your conversation from ${when}. /new starts fresh.`, "info");
        // The whole conversation comes back, each answer with its steps (repeats folded): nothing's cut.
        let answer: Assistant | undefined;
        for (const line of event.lines) {
          const text = sanitizeText(line.text, this.secrets);
          if (line.role === "user") { answer = undefined; if (text) this.transcript.add({ kind: "user", text }); continue; }
          answer ??= this.transcript.add({ kind: "assistant", text: "", steps: [], status: "done" }) as Assistant;
          if (text) answer.text += `${answer.text ? "\n\n" : ""}${text}`;
          for (const tool of line.tools ?? []) {
            if (!QUIET_TOOLS.includes(tool)) answer.steps.push({ id: `resumed:${answer.steps.length}`, tool, label: stepLabel(tool), state: "done" });
          }
          this.transcript.touch(answer);
        }
        // Its HISTORY comes back too, older than anything this session changed, and without undo.
        const earlier = (event.changes ?? []).filter((change) => !this.changes.some((known) => known.id === change.id));
        if (earlier.length) this.changes = [...earlier, ...this.changes].slice(-500);
        break;
      }
      case "resend":
        // Live is back: the stopped request is one enter away, unless something else is being typed.
        if (this.editor.isEmpty) { this.editor.set(event.text); this.recall = undefined; }
        break;
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
          // A change on the focused track may have added or moved devices.
          if (event.change.track?.name && event.change.track.name === this.focus?.track?.name) this.readTree(true);
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
        const set = this.setName ?? "this Set";
        const about = event.scope === "producer" ? "about you" : event.pending ? `about ${set}, kept once it's saved` : `about ${set}`;
        this.memoryLine("note", `${event.replaced ? "Updated a note" : "Noted"} ${about}: ${event.note.text}`);
        const id = event.note.id;
        this.keep(`note:${event.scope}:${event.pending ? "pending:" : ""}${id}`, "note", event.note.text, async () => Boolean(await this.options.controller.forget?.(id)));
        break;
      }
      case "forgot":
        this.memoryLine("note", `Forgot: ${event.note.text}`);
        this.forgotten(`note:${event.scope}:${event.note.id}`); this.forgotten(`note:${event.scope}:pending:${event.note.id}`);
        break;
      case "lesson": {
        // Kumi's own lesson from a match run: said once, and in HISTORY's kept rows with its forget.
        const key = `lesson:${event.id}`; const id = event.id;
        if (event.action === "forgot") { this.memoryLine("lesson", `Forgot a lesson: ${event.line}`); this.forgotten(key); break; }
        this.memoryLine("lesson", `${event.action === "updated" ? "Updated what I learned" : "Learned from this match"}: ${event.line}`);
        this.keep(key, "lesson", event.line, async () => Boolean(await this.options.controller.forgetLesson?.(id)));
        break;
      }
      case "technique": {
        const { technique } = event;
        this.memoryLine("technique", `${{ kept: "Kept a technique", updated: "Updated a technique", used: "Using your technique", forgot: "Forgot the technique" }[event.action]}: ${technique.name}`);
        const key = `technique:${technique.id}`;
        if (event.action === "kept" || event.action === "updated") this.keep(key, "technique", technique.name, async () => Boolean(await this.options.controller.forgetTechnique?.(technique.id)));
        else if (event.action === "forgot") this.forgotten(key);
        break;
      }
      case "action": {
        const glyph = event.recording === true ? "●" : event.playing === true ? "▶" : event.playing === false || event.recording === false ? "■" : "›";
        this.lastAction = { title: sanitizeText(event.title, this.secrets).slice(0, 120), at: performance.now(), glyph };
        setTimeout(() => { if (!this.closing) this.scheduler.request(); }, CHANGE_FLASH_MS + 20).unref?.();
        break;
      }
      case "transport":
        this.transport = event.transport;
        this.nextBeat();
        break;
      case "watching":
        this.watching = event.on;
        this.scheduler.request();
        break;
      case "recipe": {
        const steps = `${event.steps} ${event.steps === 1 ? "step" : "steps"}`;
        this.memoryLine("recipe", event.action === "saved" ? `Saved a recipe: ${event.name} (${steps})` : event.action === "updated" ? `Updated a recipe: ${event.name} (${steps})`
          : event.action === "running" ? `Running your recipe: ${event.name} (${steps})` : `Forgot the recipe: ${event.name}`);
        const key = `recipe:${event.name.toLowerCase()}`; const name = event.name;
        if (event.action === "saved" || event.action === "updated") this.keep(key, "recipe", name, async () => Boolean(await this.options.controller.forgetRecipe?.(name)));
        else if (event.action === "forgotten") this.forgotten(key);
        break;
      }
      case "heard":
        // What Kumi heard came first: it goes above the answer that says what it means.
        this.transcript.insertBefore({ kind: "heard", file: sanitizeText(event.file, this.secrets).slice(0, 120), summary: sanitizeText(event.summary, this.secrets).slice(0, 200), bands: event.bands,
          ...(event.compared ? { compared: { reference: sanitizeText(event.compared.reference, this.secrets).slice(0, 120), summary: sanitizeText(event.compared.summary, this.secrets).slice(0, 200), differences: event.compared.differences } } : {}) }, this.current);
        break;
      case "goal": {
        // The dashboard is the GOAL tab: shown when a goal starts, then kept up to date.
        if (!this.goal || event.state === "starting") this.tabs.show("goal");
        this.goal = { ...event, since: performance.now() - event.elapsedMs };
        this.scheduler.request();
        break;
      }
      case "match": {
        // A match run: NOW keeps its score and time while it works; the conversation says how it ended.
        this.match = event.state === "running" ? { ...event, since: performance.now() - event.elapsedMs } : undefined;
        if (event.state === "done" && event.best) {
          const why = { reached: "close enough", plateau: "no more gain", budget: "its budget spent", "no-audition": "nothing to compare" }[event.stop ?? "plateau"];
          this.notice(`Matching: ${event.first !== undefined && event.first !== event.best.score ? `${event.first}% → ` : ""}${event.best.score}% (${event.best.label}) · ${clockOf(event.elapsedMs)} · ${why}`, "info");
        }
        this.scheduler.request();
        break;
      }
      case "auditioned": {
        const clean = (text: string, max: number) => sanitizeText(text, this.secrets).replaceAll("\n", " ").slice(0, max);
        // Gaps are the analysis's words; kept short so the round reads in a line.
        const gaps = event.gaps.slice(0, 3).map((gap) => clean(gap.replace(/ \(.*\)$/, "").replace(/ against the reference$/, ""), 48));
        this.transcript.insertBefore({ kind: "auditioned", round: event.round, ...(event.best ? { best: { label: clean(event.best.label, 60), score: event.best.score } } : {}),
          ...(event.previous !== undefined ? { previous: event.previous } : {}), takes: event.takes.slice(0, 8).map((take) => ({ ...take, label: clean(take.label, 40) })), gaps }, this.current);
        break;
      }
      case "watched": {
        // What Kumi saw came first too: above the answer that says what it means.
        const clean = (text: string, max: number) => sanitizeText(text, this.secrets).replaceAll("\n", " ").slice(0, max);
        const words = { captions: "its captions", automatic: "its automatic captions", transcribed: "its speech, transcribed by Kumi", none: "no words" }[event.words];
        this.transcript.insertBefore({ kind: "watched", title: clean(event.title, 160), ...(event.channel ? { channel: clean(event.channel, 80) } : {}), ...(event.duration ? { duration: event.duration } : {}),
          from: event.from, to: event.to, chapters: event.chapters.slice(0, 24).map((chapter) => clean(chapter, 60)), words,
          frames: event.frames.slice(0, 16).filter((frame) => frame.thumb.width > 0 && frame.thumb.width <= 64 && frame.thumb.height > 0 && frame.thumb.height <= 64
            && frame.thumb.rgb.length === frame.thumb.width * frame.thumb.height * 3), ...(event.sound ? { sound: event.sound } : {}),
          notes: event.notes.map((note) => clean(note, 300)), pictures: this.depth === "truecolor" || this.depth === "256" }, this.current);
        break;
      }
      case "web": {
        // What Kumi looked up goes above the answer that uses it, a line each, together.
        const clean = (text: string, max: number) => sanitizeText(text, this.secrets).replace(/\s+/g, " ").trim().slice(0, max);
        const line = webWords(event, clean);
        const at = this.current ? this.transcript.entries.indexOf(this.current) : -1;
        const above = at > 0 ? this.transcript.entries[at - 1] : at === -1 ? this.transcript.entries.at(-1) : undefined;
        if (above?.kind === "web" && above.lines.length < 24) { above.lines.push(line); this.transcript.touch(above); }
        else this.transcript.insertBefore({ kind: "web", lines: [line] }, this.current);
        break;
      }
      case "steer": {
        // Kumi took a message sent while it worked: it shows where it went in, and the answer carries on under it.
        const at = this.held.findIndex((item) => item.when === "now" && item.taken && item.text === event.text);
        if (at >= 0) this.held.splice(at, 1);
        const words = sanitizeText(event.text, this.secrets).trim();
        if (this.current) {
          const before = this.current;
          if (!this.suppress) before.text += this.stream.finish();
          before.status = "done";
          this.transcript.touch(before);
          if (!before.text && !before.steps.length) this.transcript.remove(before);
          this.transcript.add({ kind: "user", text: words });
          this.current = this.transcript.add({ kind: "assistant", text: "", steps: [], status: "running", startedAt: performance.now() }) as Assistant;
        } else this.transcript.add({ kind: "user", text: words });
        break;
      }
      case "doing": {
        const running = this.current?.steps.filter((step) => step.state === "running").at(-1);
        if (running) running.doing = sanitizeText(event.text, this.secrets).replaceAll("\n", " ").slice(0, 80);
        break;
      }
      case "tool-input":
        // A plan takes seconds to write; its changes start as it's written.
        if (this.current && !this.suppress && event.name === "make_changes") { this.planning = event.id; this.planningSince = performance.now(); }
        break;
      case "tool-start":
        if (this.planning === event.id) this.planning = undefined;
        // Keeping notes and recipes shows as a line of its own, not a step.
        if (!this.current || this.suppress || QUIET_TOOLS.includes(event.name)) break;
        this.current.steps.push({ id: event.id, tool: event.name, label: stepLabel(event.name), state: "running", startedAt: performance.now() });
        this.transcript.touch(this.current);
        break;
      case "tool-end": {
        const step = this.current?.steps.find((candidate) => candidate.id === event.id);
        if (!step || !this.current) break;
        step.state = event.isError ? "error" : "done";
        step.ms = event.elapsedMs;
        step.endedAt = performance.now();
        delete step.doing;
        this.transcript.touch(this.current);
        break;
      }
      case "turn-complete": {
        const usage = event.result.usage;
        if (usage) { this.used.input += usage.inputTokens; this.used.output += usage.outputTokens; this.used.cached += usage.cacheReadTokens; this.used.answers++; }
        const entry = this.current;
        this.lastStop = event.result.stopReason;
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
    // Kumi takes a waiting message once it's working on the answer: try again as it moves.
    if ((event.type === "text" || event.type === "tool-start" || event.type === "tool-end" || event.type === "tool-input") && this.held.some((item) => item.when === "now" && !item.taken)) this.steerHeld();
    this.scheduler.request();
  }

  /** A message typed while Kumi works: into the answer under way at its next step ("now"), or after it ("after"). */
  private hold(raw: string, when: "now" | "after"): void {
    this.held.push({ text: raw, when });
    if (when === "now") this.steerHeld();
    this.scheduler.request();
  }

  private steerHeld(): void {
    const { controller } = this.options;
    if (!controller.steer) return;
    for (const item of this.held) if (item.when === "now" && !item.taken) item.taken = controller.steer(item.text);
  }

  /**
   * Kumi is free again. Messages still waiting are sent, one an answer; any Kumi took but didn't get to
   * are sent too. After a stop or a failure they go back into the box instead, to send or not.
   */
  private afterBusy(): void {
    // How the last work ended counts once: a message held during later work is sent as usual.
    const back = this.lastStop === "cancelled" || this.failed;
    this.lastStop = undefined; this.failed = false;
    if (!this.held.length || this.closing) return;
    if (back) {
      const words = this.held.map((item) => item.text);
      this.held = [];
      this.editor.set([...words, ...(this.editor.isEmpty ? [] : [this.editor.text])].join("\n"));
      this.recall = undefined;
      return;
    }
    const next = this.held.shift()!;
    this.transcript.add({ kind: "user", text: sanitizeText(next.text, this.secrets).trim() });
    this.lastSent = next.text;
    this.scroll = 0;
    void Promise.resolve().then(() => this.send(next.text));
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
    this.keepTreeFresh(false);
    clearTimeout(this.wakeTimer); clearTimeout(this.beatTimer);
    this.suppress = true;
    this.stream.discard();
    // A ChatGPT sign-in waiting on the browser stops listening; a half-typed key is dropped.
    if (this.panel?.kind === "chatgpt") this.panel.abort.abort();
    if (this.panel?.kind === "key") this.panel.secret = "";
    this.panel = undefined;
    for (const aside of this.asides) if (aside.state === "asking") aside.abort.abort();
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
      // Typing goes back to the input box.
      this.treeCursor = undefined; this.tabs.leave();
      this.editor.insert(sanitizeText(event.text));
      this.menuDismissed = false;
    } else if (event.type === "key") {
      this.key(event);
    } else if (event.type === "mouse" && event.action === "wheel") {
      // Over the tabbed area it scrolls the tab; anywhere else, the conversation.
      const area = this.tabsArea;
      if (area && event.x >= area.x - 2 && event.x < area.x + area.width + 2 && event.y >= area.y && event.y < area.y + area.height) this.tabs.scrollBy(event.direction === "up" ? -3 : 3);
      else this.scrollBy(event.direction === "up" ? 3 : -3);
    } else if (event.type === "mouse" && event.action === "press" && event.button === "left") {
      this.hits.find((hit) => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width)?.action();
    }
    this.scheduler.request();
  }

  private key(event: Extract<InputEvent, { type: "key" }>): void {
    const { name, ctrl, alt, shift } = event;
    const menu = this.menu();
    const width = this.inputWidth();
    // Shift+Tab moves into the tabbed area (again, to its next tab); there, arrows and pages move, Enter
    // does the row's action (undo), Esc or Tab goes back to typing.
    if (name === "tab" && shift && !ctrl && !alt && !menu.length) {
      this.treeCursor = undefined;
      if (this.tabs.inside) this.tabs.next(); else this.tabs.enter();
      return;
    }
    if (this.tabs.inside) {
      if (name === "escape" || name === "tab") { this.tabs.leave(); return; }
      if (!ctrl && !alt && this.tabs.key(name)) return;
      this.tabs.leave();
    }
    // In FOCUS's tree: arrows move, Enter points at the row, Esc or Tab goes back to typing.
    if (this.treeCursor !== undefined) {
      const rows = this.treeShown();
      if (!rows) this.treeCursor = undefined;
      else if (!ctrl && !alt && (name === "up" || name === "down")) { this.treeCursor = Math.max(0, Math.min(rows.length - 1, this.treeCursor + (name === "up" ? -1 : 1))); return; }
      else if (!ctrl && !alt && name === "enter") { this.pin(rows[Math.min(this.treeCursor, rows.length - 1)]!); this.treeCursor = undefined; return; }
      else if (name === "escape" || name === "tab") { this.treeCursor = undefined; return; }
      else this.treeCursor = undefined;
    }
    // While Kumi works, Tab sends what's typed after the answer under way, rather than into it.
    if (name === "tab" && !menu.length && !ctrl && !alt && this.busy && !this.editor.isEmpty && !isCommand(this.editor.text.trim())) {
      const raw = this.editor.text;
      this.options.history?.add(raw); this.recall = undefined;
      this.editor.clear();
      this.hold(raw, "after");
      return;
    }
    // Tab, outside the command menu, moves into the tree, at what's selected in Live.
    if (name === "tab" && !menu.length && !ctrl && !alt) {
      const shown = this.tree && this.focus?.trackRef === this.tree.trackRef ? (this.treeCursor = 0, this.treeShown()) : undefined;
      if (shown) { const at = shown.findIndex((row) => row.role === "focus"); this.treeCursor = at >= 0 ? at : 0; }
      else this.treeCursor = undefined;
      return;
    }
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
      else if (this.pinned) this.unpin();
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
    // Alt+↑ takes back the last message still waiting (one Kumi hasn't taken yet), to change it.
    if (alt && name === "up" && this.held.some((item) => !item.taken)) {
      const at = this.held.map((item) => !item.taken).lastIndexOf(true);
      const [item] = this.held.splice(at, 1);
      this.editor.set(this.editor.isEmpty ? item!.text : `${item!.text}\n${this.editor.text}`);
      this.recall = undefined;
      return;
    }
    // Up and down move between the box's lines, then (past the first or last) through what was sent before.
    if (name === "up") { if (!this.editor.vertical(width, -1)) this.recallOlder(); return; }
    if (name === "down") { if (!this.editor.vertical(width, 1)) this.recallNewer(); return; }
    // Ctrl+Home and Ctrl+End go to the start of the conversation and back to the latest.
    if (ctrl && name === "home") { this.scroll = Number.MAX_SAFE_INTEGER; return; }
    if (ctrl && name === "end") { this.scroll = 0; return; }
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
      && (command.name !== "/conversations" || this.options.controller.conversations !== undefined) && (command.name !== "/reconnect" || this.options.controller.reconnect !== undefined)
      && (command.name !== "/stop" || this.options.controller.stopLive !== undefined) && (command.name !== "/update" || this.options.updates !== undefined)
      && (command.name !== "/btw" || this.options.controller.aside !== undefined));
    if (this.menuIndex >= matches.length) this.menuIndex = 0;
    return matches;
  }

  private async submit(): Promise<void> {
    const raw = this.editor.text;
    const command = raw.trim();
    if (!command) return;
    const { controller } = this.options;
    // Everything sent goes into the history, as a shell keeps it (secrets kept out).
    this.options.history?.add(raw);
    this.recall = undefined;
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
    if (command === "/conversations" && controller.conversations) {
      this.editor.clear();
      await this.openConversations().catch((error: unknown) => this.panelFailed(error));
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
    if (command === "/update" && this.options.updates) {
      this.editor.clear();
      await this.openUpdate().catch((error: unknown) => this.panelFailed(error));
      return;
    }
    if (command === "/status") {
      this.editor.clear();
      const status = controller.status();
      this.notice(`${status.state === "idle" ? "Ready" : status.state} · Live ${status.connection} · ${this.modelLabel() ?? "no model"} · ${status.maxTurns ? `${status.turns} of ${status.maxTurns} turns` : `${status.turns} ${status.turns === 1 ? "turn" : "turns"}`}${status.observation ? ` · ${status.observation}` : ""}${this.tokensUsed()}`, "info");
      return;
    }
    // A side question, any time: answered on its own, without tools, and kept out of the conversation.
    if ((command === "/btw" || command.startsWith("/btw ")) && controller.aside) {
      this.editor.clear();
      const question = command.slice(4).trim();
      if (question) this.ask(question);
      else if (this.asides.length) this.panel = { kind: "btw", at: this.asides.length - 1, scroll: 0 };
      else this.notice("Ask on the side with /btw and your question: Kumi answers from the conversation so far, without stopping what it's doing.", "info");
      this.scheduler.request();
      return;
    }
    // While Kumi works, a message goes into the answer under way at its next step; while it connects or
    // reads the Set, it waits until Kumi's ready.
    if (this.busy && !isCommand(command)) {
      this.editor.clear();
      if (!this.current && !this.pendingTurn) this.activity = "getting ready";
      this.hold(raw, this.current || this.pendingTurn ? "now" : "after");
      return;
    }
    // /goal stop ends a goal, running or paused; /goal alone shows it (picking a paused one up when Kumi's free).
    if ((command === "/goal stop" || command === "/goal end") && controller.stopGoal) {
      this.editor.clear();
      if (!await controller.stopGoal()) this.notice("There's no goal to stop.", "info");
      return;
    }
    if (command === "/goal" && this.busy && this.goal) { this.editor.clear(); this.tabs.show("goal"); this.scheduler.request(); return; }
    if (this.busy) { this.notice(`Kumi is still working: ${command.split(/\s/)[0]} once it's done, or press esc to stop it first.`, "info"); return; }
    if ((command === "/goal" || command.startsWith("/goal ")) && controller.goal) {
      this.editor.clear();
      const text = command.slice(5).trim();
      if (text) this.transcript.add({ kind: "user", text: sanitizeText(raw, this.secrets).trim() });
      this.tabs.show("goal");
      this.activity = text ? "setting up the goal" : "picking the goal up";
      this.pendingTurn = true; this.scheduler.request();
      await controller.goal(text || undefined).catch((error: unknown) => { this.pendingTurn = false; if (!this.closing) this.notice(safeError(error, this.secrets), "warn"); });
      this.scheduler.request();
      return;
    }
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
        // What's above stays on screen, under a line saying Kumi won't use it. The bridge stays, and
        // with it HISTORY's undo.
        if (!this.transcript.isEmpty) this.transcript.add({ kind: "divider", text: "New conversation. Kumi won't use what's above" });
        this.current = undefined;
        this.watching = false;
        await controller.newConversation();
      } else if (command === "/reconnect" && controller.reconnect) {
        this.activity = "connecting to Live";
        await controller.reconnect();
        // A fresh bridge can't undo the old one's changes: they stay listed, without their undo.
        this.changes = this.changes.map((change) => change.state === "applied" || change.state === "unsure"
          ? { ...change, state: "expired", note: "Kumi reconnected to Live since, so it can't undo this; Live's own undo still can." } : change);
      } else if (isCommand(command)) this.notice(`There's no ${command.split(/\s/)[0]} command. Type / to see them.`, "info");
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
  /**
   * Read the focused track's device tree when the track, or the device selected on it, changes (or,
   * `again`, after a change on it). One read at a time; a change meanwhile reads once more after.
   */
  private readTree(again = false): void {
    const ref = this.focus?.trackRef; const read = this.options.controller.deviceTree;
    if (!ref || !read || this.connection !== "connected") return;
    const key = `${ref}\u0000${this.focus?.device ?? ""}\u0000${this.focus?.chain ?? ""}\u0000${this.focus?.deviceRef ?? ""}`;
    if (!again && key === this.treeKey) return;
    this.treeKey = key;
    if (this.treeReading) { this.treeAgain = true; return; }
    this.treeReading = true;
    void read.call(this.options.controller, ref).then((tree) => { if (tree && tree.trackRef === this.focus?.trackRef) this.tree = tree; }, () => {})
      .finally(() => {
        this.treeReading = false;
        if (this.treeAgain) { this.treeAgain = false; this.readTree(true); }
        if (!this.closing) this.scheduler.request();
      });
  }

  /** Every few seconds while the tree or the clip shows (one read at a time), so what changed in Live by hand shows too. */
  private refreshing: false | "tree" | "clip" | "session" | "arrangement" = false;
  private keepTreeFresh(shown: false | "tree" | "clip" | "session" | "arrangement"): void {
    // The Arrangement's playhead moves, so it's read more often; a change of what shows restarts the timer.
    if (shown !== this.refreshing && this.treeRefresh) { clearInterval(this.treeRefresh); this.treeRefresh = undefined; }
    this.refreshing = shown;
    if (shown && !this.treeRefresh) {
      this.treeRefresh = setInterval(() => {
        if (this.closing) return;
        if (this.focus?.detail === "Clip") this.readClip(true); else if (this.focus?.detail === "Device") this.readTree(true); else this.readStrip(true);
      }, shown === "arrangement" ? STRIP_REFRESH_MS : TREE_REFRESH_MS);
      this.treeRefresh.unref?.();
    } else if (!shown && this.treeRefresh) { clearInterval(this.treeRefresh); this.treeRefresh = undefined; }
  }

  /** Read the highlighted slot's clip when the slot, its name or the selected notes change (or `again`). One read at a time. */
  private readClip(again = false): void {
    const ref = this.focus?.slotRef; const read = this.options.controller.clipView;
    if (!ref || !read || this.connection !== "connected" || this.focus?.detail !== "Clip" || this.focus.view !== "Session") return;
    const key = `${ref}\u0000${this.focus?.clip ?? ""}\u0000${this.focus?.selectedNotes ?? 0}`;
    if (!again && key === this.clipKey) return;
    this.clipKey = key;
    if (this.clipReading) { this.clipAgain = true; return; }
    this.clipReading = true;
    void read.call(this.options.controller, ref).then((clip) => { if (clip?.slotRef === this.focus?.slotRef) this.clip = clip; else if (!clip) this.clip = undefined; }, () => {})
      .finally(() => {
        this.clipReading = false;
        if (this.clipAgain) { this.clipAgain = false; this.readClip(true); }
        if (!this.closing) this.scheduler.request();
      });
  }

  /** Which strip FOCUS shows in place of the path: Live's Session or Arrangement, with no device or clip open. */
  private stripKind(): "session" | "arrangement" | undefined {
    const focus = this.focus;
    if (this.connection !== "connected" || !focus?.track) return undefined;
    if (this.touched === "arrangement" && focus.view === "Arrangement") return "arrangement";
    return this.touched === "session" && focus.view === "Session" && focus.trackRef && focus.sceneIndex !== undefined ? "session" : undefined;
  }

  /** Read the strip FOCUS shows when its track or scene changes (or `again`); one read at a time. */
  private readStrip(again = false): void {
    const kind = this.stripKind(); const focus = this.focus; const controller = this.options.controller;
    if (!kind || !focus) return;
    const key = kind === "session" ? `s\u0000${focus.trackRef}\u0000${focus.sceneIndex}` : "a";
    if ((!again && key === this.strip.key) || this.strip.reading) return;
    this.strip.key = key; this.strip.reading = true;
    const done = () => { this.strip.reading = false; if (!this.closing) this.scheduler.request(); };
    if (kind === "session" && controller.sessionStrip) void controller.sessionStrip(focus.trackRef!, focus.sceneIndex!).then((value) => { this.strip.session = value; }, () => {}).finally(done);
    else if (kind === "arrangement" && controller.arrangementStrip) void controller.arrangementStrip().then((value) => { this.strip.arrangement = value; }, () => {}).finally(done);
    else this.strip.reading = false;
  }

  /** The clip FOCUS draws: Live's Clip view on a MIDI clip in the highlighted Session slot. */
  private clipShown(): ClipView | undefined {
    const focus = this.focus; const clip = this.clip;
    return this.connection === "connected" && focus?.track && focus.detail === "Clip" && this.touched === "clip" && clip && clip.slotRef === focus.slotRef ? clip : undefined;
  }

  /** The tree's rows while FOCUS shows it: Live's Device view on the focused track, or the keyboard in it. */
  private treeShown(): TreeRow[] | undefined {
    const focus = this.focus; const tree = this.tree;
    if (this.connection !== "connected" || !focus?.track || !tree || tree.trackRef !== focus.trackRef) return undefined;
    if ((focus.detail !== "Device" || this.touched !== "device") && this.treeCursor === undefined) return undefined;
    const rows = treeRows(tree, { ...(focus.device ? { device: focus.device } : {}), ...(focus.chain ? { chain: focus.chain } : {}), ...(focus.deviceRef ? { deviceRef: focus.deviceRef } : {}) });
    return rows.length ? rows : undefined;
  }

  /** Point at a row: it's shown above the input box, and "this" in the next messages means it. */
  private pin(row: TreeRow): void {
    const focus = this.focus;
    if (!focus?.trackRef) return;
    this.pinned = { trackRef: focus.trackRef, ref: row.ref, node: row.node, name: row.name, trail: row.trail, siblings: row.siblings, kind: row.kind, ...(focus.track ? { track: focus.track.name } : {}) };
    this.scheduler.request();
  }

  private unpin(): void { this.pinned = undefined; this.scheduler.request(); }

  /**
   * On an API key, what this session's answers took, for /status: tokens, which is what the provider
   * bills (its prices aren't in its model list, so Kumi doesn't guess a cost). A ChatGPT plan isn't
   * billed by the token, so nothing is said there.
   */
  private tokensUsed(): string {
    const provider = this.options.models?.current().provider;
    if (!provider || PROVIDER_INFO[provider].signIn !== "api-key" || !this.used.answers) return "";
    const count = (n: number) => (n < 1_000 ? `${n}` : n < 1_000_000 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);
    return ` · this session: ${count(this.used.input)} tokens in${this.used.cached ? ` (${count(this.used.cached)} cached)` : ""}, ${count(this.used.output)} out`;
  }

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
    if (panel?.kind === "btw") { const aside = this.asides[panel.at]; if (aside?.state === "asking") aside.abort.abort(); }
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
    if (panel.kind === "btw") { this.asideInput(panel, event); return; }
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
    if (panel.kind === "pick") {
      // A "/" to begin with is a command, not a filter (no item starts with one): the list gives way
      // to the input box, where the command menu opens. So /update works from the model list Kumi
      // opens at the start.
      if (!panel.picker.filter && event.text.startsWith("/")) { this.closePanel(); this.onInput(event); return; }
      panel.picker.type(event.text);
    }
    // A key is one word: spaces and line breaks a paste brings along go.
    else if (panel.kind === "key" && !panel.checking) { panel.secret = (panel.secret + event.text.replace(/[\s\x00-\x1f\x7f]/g, "")).slice(0, 4096); delete panel.status; }
  }

  /**
   * The btw panel: esc, enter or space closes it (an answer still coming stops), ↑↓ scroll it, ←→ go
   * through this session's other side questions, c copies the answer.
   */
  private asideInput(panel: Extract<Panel, { kind: "btw" }>, event: InputEvent): void {
    const aside = this.asides[panel.at];
    if (event.type === "key") {
      const { name, ctrl } = event;
      if (name === "escape" || name === "enter" || (ctrl && name === "c")) { this.closePanel(); return; }
      if (name === "up" || name === "pageup") panel.scroll = Math.max(0, panel.scroll - (name === "up" ? 1 : 5));
      else if (name === "down" || name === "pagedown") panel.scroll += name === "down" ? 1 : 5;
      else if (name === "left" && panel.at > 0) { panel.at--; panel.scroll = 0; }
      else if (name === "right" && panel.at < this.asides.length - 1) { panel.at++; panel.scroll = 0; }
      return;
    }
    if (event.type !== "text") return;
    if (event.text === " ") { this.closePanel(); return; }
    if (event.text.toLowerCase() === "c" && aside?.answer.trim()) {
      this.tty.write(`\u001b]52;c;${Buffer.from(aside.answer.trim(), "utf8").toString("base64")}\u0007`);
      this.notice("Copied the side answer.", "info");
    }
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

  /** /update: the newest Kumi, once it's confirmed. Kumi then closes, updates, and opens again with this conversation. */
  private async openUpdate(): Promise<void> {
    const updates = this.options.updates!;
    if (this.busy) { this.notice("Kumi is working: /update once it's done, or press esc to stop it first.", "info"); return; }
    let latest = this.newer;
    if (!latest) {
      this.notice("Looking for a newer Kumi…", "info");
      try { latest = await updates.check(); } catch (error) { this.notice(`${safeError(error, this.secrets)}. Try /update again later.`, "warn"); return; }
      if (!latest) { this.notice(`Kumi is up to date (${updates.current}).`, "info"); return; }
      this.newer = latest;
    }
    const picker = new Picker(`Update to Kumi ${latest}?`, [
      { label: "Update now", detail: "Kumi closes, updates and opens again", value: "yes" },
      { label: "Not now", value: "no" },
    ]);
    this.panel = { kind: "pick", picker, choose: async (answer) => {
      this.closePanel();
      if (answer.value !== "yes") return;
      updates.request();
      await this.finish(0);
    } };
    this.scheduler.request();
  }

  /**
   * /memory: all Kumi keeps: notes about the producer and this Set, techniques and recipes. Choosing a
   * note or a technique offers to forget it; a recipe, to run or forget it.
   */
  private async openMemory(): Promise<void> {
    const { controller } = this.options;
    const [memory, techniques, recipes, lessons] = await Promise.all([controller.memory?.(), controller.techniques?.() ?? Promise.resolve([]), controller.recipes?.() ?? Promise.resolve([]),
      controller.lessons?.() ?? Promise.resolve([])]);
    if (!memory) return;
    const now = Date.now();
    const clean = (text: string, max: number) => sanitizeText(text, this.secrets).replaceAll("\n", " ").slice(0, max);
    const rows = (notes: typeof memory.producer): PickerItem[] => notes.slice().reverse().map((note) => ({ label: note.text, value: `note:${note.id}`, note: since(note.at, now), noteTone: "faint" }));
    const setName = memory.setName ?? "this Set";
    const items: PickerItem[] = [
      { heading: true, label: "About you" },
      ...(memory.producer.length ? rows(memory.producer) : [{ label: "Nothing yet", inert: true }]),
      { heading: true, label: `About ${setName}` },
      ...(!memory.saved ? [{ label: "Kept once the Set is saved", inert: true }] : memory.set.length ? rows(memory.set) : [{ label: "Nothing yet", inert: true }]),
      ...(controller.techniques ? [{ heading: true, label: "Techniques" }, ...(techniques.length
        ? techniques.map((technique): PickerItem => ({ label: clean(technique.name, 60), detail: clean(technique.fits, 160), value: `technique:${technique.id}`, ...(technique.source ? { note: clean(technique.source, 40), noteTone: "faint" as const } : {}) }))
        : [{ label: "None yet: what worked in things Kumi built that you liked", inert: true }])] : []),
      ...(controller.recipes ? [{ heading: true, label: "Recipes" }, ...(recipes.length
        ? recipes.map((recipe): PickerItem => ({ label: recipe.name, detail: recipe.about, value: `recipe:${recipe.name}`, note: `${recipe.steps} steps`, noteTone: "faint" }))
        : [{ label: "None yet", inert: true }])] : []),
      ...(controller.lessons ? [{ heading: true, label: "What Kumi learned matching sounds" }, ...(lessons.length
        ? lessons.map((lesson): PickerItem => ({ label: clean(lesson.line, 160), value: `lesson:${lesson.id}`, note: since(lesson.at, now), noteTone: "faint" }))
        : [{ label: "None yet: what won when Kumi matched a sound to a reference", inert: true }])] : []),
    ];
    const picker = new Picker("What Kumi remembers · notes, techniques and recipes", items, { filterable: true });
    this.panel = { kind: "pick", picker, choose: (item) => {
      const [kind, ...rest] = item.value!.split(":"); const id = rest.join(":");
      if (kind === "recipe") { const recipe = recipes.find((candidate) => candidate.name === id); if (recipe) this.recipeActions(recipe); return; }
      const confirm = new Picker(kind === "technique" ? "Forget this technique?" : kind === "lesson" ? "Forget this lesson?" : "Forget this note?", [
        { label: "Forget it", detail: item.label, value: "yes" },
        { label: "Keep it", value: "no" },
      ]);
      this.panel = { kind: "pick", picker: confirm, choose: async (answer) => {
        this.closePanel();
        if (answer.value !== "yes") return;
        const gone = kind === "technique" ? await controller.forgetTechnique?.(id) : kind === "lesson" ? await controller.forgetLesson?.(id) : await controller.forget?.(id);
        if (!gone) this.notice(`That ${kind === "technique" || kind === "lesson" ? kind : "note"} was already gone.`, "info");
      } };
      this.scheduler.request();
    } };
    this.scheduler.request();
  }

  /** The up arrow: the message sent before the one in the box (what was being typed is kept). */
  private recallOlder(): void {
    const entries = this.options.history?.entries ?? [];
    const index = (this.recall?.index ?? entries.length) - 1;
    if (index < 0) return;
    this.recall = { index, draft: this.recall?.draft ?? this.editor.text };
    this.editor.set(entries[index]!);
    // A recalled command doesn't open the / menu: the arrows keep going through the history.
    this.menuDismissed = true;
  }

  /** The down arrow: the next message sent, and past the last, what was being typed. */
  private recallNewer(): void {
    if (!this.recall) return;
    const entries = this.options.history?.entries ?? [];
    const index = this.recall.index + 1;
    if (index >= entries.length) { this.editor.set(this.recall.draft); this.recall = undefined; return; }
    this.recall = { ...this.recall, index };
    this.editor.set(entries[index]!);
    this.menuDismissed = true;
  }

  /** /conversations: this Set's kept conversations, newest first; choosing one carries it on (this one stays kept). */
  private async openConversations(): Promise<void> {
    const { controller } = this.options;
    const kept = await controller.conversations?.() ?? [];
    const now = Date.now();
    const requests = (count: number) => `${count} ${count === 1 ? "request" : "requests"}`;
    const items: PickerItem[] = kept.length ? kept.map((row) => ({ label: sanitizeText(row.first, this.secrets).replaceAll("\n", " ").slice(0, 120) || "(nothing asked yet)", value: row.id,
      note: `${row.current ? "this one" : since(row.savedAt, now)} · ${requests(row.turns)}`, noteTone: "faint" as const }))
      : [{ label: "None kept yet: a conversation is kept once you've asked something", inert: true }];
    const picker = new Picker(`Conversations about ${this.setName ?? "this Set"}`, items, { filterable: true });
    this.panel = { kind: "pick", picker, choose: async (item) => {
      this.closePanel();
      const row = kept.find((candidate) => candidate.id === item.value);
      if (!row || row.current) return;
      if (this.busy) { this.notice("Kumi is still working. Press esc to stop it first.", "info"); return; }
      this.activity = "going back to it";
      const resumed = await controller.resumeConversation?.(row.id).catch((error: unknown) => { this.notice(safeError(error, this.secrets), "warn"); return true; });
      if (resumed === false) this.notice("That conversation isn't kept any more.", "info");
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
    this.panel = { kind: "pick", picker, choose: (item) => { this.recipeActions(recipes.find((candidate) => candidate.name === item.value)!); } };
    this.scheduler.request();
  }

  /** A recipe chosen in /recipes or /memory: run it (straight away when it has no blanks), forget it, or keep it. */
  private recipeActions(recipe: RecipeSummary): void {
    const { controller } = this.options;
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
    void models.signInChatGPT({ signal: abort.signal, onUrl: (url) => { panel.url = url; this.options.openBrowser?.(url); this.scheduler.request(); } })
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

  /** Ask a side question: its answer streams into the btw panel, and nothing joins the conversation. */
  private ask(question: string): void {
    const aside: Aside = { question: sanitizeText(question, this.secrets), answer: "", state: "asking", abort: new AbortController() };
    this.asides.push(aside);
    if (this.asides.length > 20) this.asides.shift();
    this.panel = { kind: "btw", at: this.asides.length - 1, scroll: 0 };
    const stream = new StreamingText(this.secrets);
    void Promise.resolve().then(() => this.options.controller.aside!(question, (text) => { aside.answer += stream.push(text); this.scheduler.request(); }, aside.abort.signal))
      .then((answer) => { aside.answer += stream.finish(); if (!aside.answer.trim()) aside.answer = sanitizeText(answer, this.secrets); aside.state = "done"; })
      .catch((error: unknown) => { aside.state = "failed"; if (!aside.abort.signal.aborted) aside.answer = safeError(error, this.secrets); })
      .finally(() => { if (!this.closing) this.scheduler.request(); });
  }

  /** Start a turn for a message already shown in the conversation. */
  private async send(raw: string): Promise<void> {
    if (this.closing) return;
    this.activity = "thinking";
    this.pendingTurn = true;
    this.scheduler.request();
    const pinned = this.pinned ? (({ kind: _kind, ...node }) => node)(this.pinned) : undefined;
    try { await this.options.controller.submit(raw, pinned ? { pinned } : undefined); }
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
    // What the producer points at sits just above the input box, taking a line from the conversation;
    // messages waiting for Kumi sit above that.
    const chip = this.pinned ? 1 : 0;
    const waiting = Math.min(3, this.held.length);
    const conversation: Rect = { x: 0, y: 2, width: left, height: Math.max(1, boxTop - dock - 3 - chip - waiting) };
    this.page = Math.max(1, conversation.height - 2);
    this.drawConversation(screen, conversation);
    if (pane) this.drawPane(screen, { x: left, y: 1, width: pane, height: rows - 1 });
    else this.drawDock(screen, { x: 0, y: boxTop - dock - 1, width: columns, height: dock });
    if (chip) this.drawPin(screen, 3, boxTop - dock - 2, left - 6);
    // A panel or the / menu opens over them.
    if (waiting && !this.panel && !this.menu().length) this.drawHeld(screen, 3, boxTop - dock - 1 - chip - waiting, left - 6, waiting);
    let cursor: Cursor | undefined = this.drawComposer(screen, { x: 1, y: boxTop, width: left - 2, height: boxHeight }, layout, visibleRows);
    if (this.panel) cursor = this.drawPanel(screen, this.panel, boxTop, left);
    else this.drawMenu(screen, boxTop, left);
    this.tty.write(this.renderer.frame(screen, this.closing ? undefined : cursor));
  }

  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeTime: number | undefined;
  /** A frame at `at` (performance.now() time), for something that changes by itself then. */
  private wakeAt(at: number, now = performance.now()): void {
    if (this.closing) return;
    if (at <= now + 1) { this.scheduler.request(); return; }
    if (this.wakeTimer && this.wakeTime !== undefined && this.wakeTime <= at) return;
    clearTimeout(this.wakeTimer);
    this.wakeTime = at;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.wakeTime = undefined; if (!this.closing) this.scheduler.request(); }, Math.ceil(at - now));
    this.wakeTimer.unref?.();
  }

  /**
   * Where Live's playhead is now, in beats, followed from the last read at its tempo; with a bar's
   * beats. Undefined while Live isn't playing (or isn't connected).
   */
  private beatNow(now = performance.now()): { beat: number; beatsPerBar?: number; tempo: number } | undefined {
    const transport = this.transport;
    if (!transport?.playing || !transport.tempo || transport.tempo <= 0 || transport.beat === undefined || this.connection !== "connected") return undefined;
    return { beat: transport.beat + Math.max(0, now - transport.at) * transport.tempo / 60_000, tempo: transport.tempo, ...(transport.beatsPerBar ? { beatsPerBar: transport.beatsPerBar } : {}) };
  }

  /** While Live plays, a frame as the light comes on at each beat and as it goes off a quarter of a beat later. */
  private nextBeat(): void {
    clearTimeout(this.beatTimer); this.beatTimer = undefined;
    const now = performance.now(); const at = this.beatNow(now);
    if (!at || this.closing) { this.scheduler.request(); return; }
    const phase = at.beat - Math.floor(at.beat);
    const toEdge = (phase < BEAT_LIT ? BEAT_LIT - phase : 1 - phase) * 60_000 / at.tempo;
    this.beatTimer = setTimeout(() => { this.scheduler.request(); this.nextBeat(); }, Math.max(4, Math.ceil(toEdge) + 1));
    this.beatTimer.unref?.();
    this.scheduler.request();
  }

  /** "● 124 BPM" in yellow, lit on the beat, while Live plays; undefined when it doesn't. */
  private beatLight(): { text: string; dot: Style } | undefined {
    const at = this.beatNow();
    if (!at) return undefined;
    const phase = at.beat - Math.floor(at.beat);
    const bar = at.beatsPerBar && Number.isInteger(at.beatsPerBar) ? at.beatsPerBar : undefined;
    const downbeat = bar !== undefined && Math.floor(at.beat + 1e-6) % bar === 0;
    const lit = phase < BEAT_LIT;
    const tempo = Number.isInteger(at.tempo) ? `${at.tempo}` : at.tempo.toFixed(1);
    return { text: `${tempo} BPM`, dot: { fg: lit ? (downbeat ? palette.beat : mixRgb(palette.beat, palette.offbeat, 0.25)) : palette.offbeat } };
  }

  private status(): { dot: Style; text: string } {
    if (this.options.mode === "inference-only" || this.connection === "disconnected" || this.connection === "error") return { dot: st.warn, text: "Live not connected" };
    if (this.connection === "connecting") return { dot: st.faint, text: "connecting to Live…" };
    return { dot: st.accent, text: "Live" };
  }

  private drawHeader(screen: Screen, columns: number): void {
    const status = this.status();
    let start = columns - 2 - textWidth(`● ${status.text}`);
    // Live playing: a yellow light on the beat, and the tempo, beside Live's own status.
    const light = this.beatLight();
    if (light && start - textWidth(`● ${light.text}`) - 3 > 12) {
      const at = start - 3 - textWidth(`● ${light.text}`);
      screen.put(at, 0, "●", light.dot);
      screen.put(at + 1, 0, ` ${light.text}`, st.faint);
      start = at;
    }
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
    const live = columns - 2 - textWidth(`● ${status.text}`);
    screen.put(live, 0, "●", status.dot);
    screen.put(live + 1, 0, ` ${status.text}`, st.dim);
  }

  private drawConversation(screen: Screen, area: Rect): void {
    const textX = area.x + 3;
    const width = Math.max(1, area.width - 5);
    const now = performance.now();
    const rows = this.transcript.rows(width, now);
    // Repeated steps fold a few seconds after the last of them: a frame then, and each frame while they fold.
    const next = this.transcript.changeAt(now);
    if (next !== undefined) this.wakeAt(next, now);
    if (!rows.length) { this.drawWelcome(screen, textX, area.y + 2, width, area.height - 2); return; }
    const total = rows.length;
    // Scrolled back, the view stays on what it shows as rows come (or fold away) below.
    if (this.scroll > 0 && total !== this.lastTotal) this.scroll = Math.max(0, this.scroll + total - this.lastTotal);
    this.lastTotal = total;
    this.scroll = Math.min(this.scroll, Math.max(0, total - area.height));
    const start = Math.max(0, total - area.height - this.scroll);
    const clip: Rect = { x: area.x, y: area.y, width: area.width, height: area.height };
    rows.slice(start, start + area.height).forEach((row, index) => this.drawRow(screen, row, textX, area.y + index, width, clip, now));
    if (this.scroll > 0) {
      const hint = "newer below · page down";
      screen.fill({ x: area.x, y: area.y + area.height - 1, width: area.width, height: 1 }, st.ground);
      screen.put(area.x + area.width - 2 - textWidth(hint), area.y + area.height - 1, hint, st.faint);
    }
  }

  private drawRow(screen: Screen, row: Row, x: number, y: number, width: number, clip: Rect, now: number): void {
    if (row.band) screen.fill({ x: x - 1, y, width: Math.min(row.band.width, width + 2), height: 1 }, { bg: row.band.bg });
    let column = x;
    let trailing = row.trailing;
    const live = row.live;
    if (live) {
      // What's under way moves: a step's own animation, its words shimmering, its time going up.
      const end = x + Math.min(width, 46) - 7;
      if (live.kind === "header") {
        column = screen.put(column, y, "▾ ", st.faint, clip);
        for (const span of shimmer(live.label, now - (live.since ?? 0))) column = screen.put(column, y, span.text, span.style, clip);
        if (live.since !== undefined) trailing = { text: elapsed(now - live.since), style: st.faint };
      } else {
        const ms = now - live.since;
        column = screen.put(column, y, "│ ", { fg: palette.rule }, clip);
        const glyph = activityGlyph(live.activity, ms, this.icons === "badges");
        column = screen.put(column, y, glyph.text, glyph.style, clip);
        column = screen.put(column, y, " ", st.dim, clip);
        for (const span of shimmer(live.label, ms)) column = screen.put(column, y, span.text, span.style, clip);
        if (live.doing && end - column > 4) column = screen.put(column, y, truncate(` · ${live.doing}`, end - column), st.faint, clip);
        trailing = { text: elapsed(ms), style: st.faint };
      }
    } else for (const span of row.spans) column = screen.put(column, y, span.text, span.style, clip);
    if (trailing) {
      const at = x + Math.min(width, 46) - textWidth(trailing.text);
      if (at > column) screen.put(at, y, trailing.text, trailing.style, clip);
    }
  }

  private drawWelcome(screen: Screen, x: number, y: number, width: number, height: number): void {
    const rows: { text: string; style: Style; center?: boolean }[] = [];
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
    add("Kumi keeps each Set's conversations: /conversations goes back to one.", st.faint);
    if (this.newer) { add(); add(`Kumi ${this.newer} is out · /update gets it`, st.accent); }
    // The wordmark goes above, when the window has room for it and everything under it.
    if (width >= LOGO_WIDTH && height >= rows.length + LOGO_HEIGHT + 1) {
      rows.unshift(...LOGO_LETTERS.map((text) => ({ text, style: st.bright, center: true })), { text: "", style: st.text }, { text: LOGO_RULE, style: st.faint, center: true }, { text: "", style: st.text });
    }
    // Centred in the conversation area, across and down, each line on the middle.
    const top = y + Math.max(0, Math.floor((height - rows.length) / 2));
    rows.forEach((row, index) => {
      const text = truncate(row.text.trim() && !row.center ? row.text.trim() : row.text, width);
      if (text) screen.put(x + Math.max(0, Math.floor((width - textWidth(text)) / 2)), top + index, text, row.style);
    });
  }

  /** The change NOW is showing, for a few seconds after Kumi makes it. */
  private flashing(): ChangeRecord | undefined {
    if (!this.lastChange || performance.now() - this.lastChange.at >= CHANGE_FLASH_MS) return undefined;
    return this.changes.find((change) => change.id === this.lastChange!.id);
  }

  private nowLine(): { dot?: Style; label: string; detail: string; detailStyle: Style; activity?: { kind: Activity; since: number } } {
    if (this.closing) return { label: "", detail: "Closing…", detailStyle: st.dim };
    const state = this.options.controller.status().state;
    if (state === "cancelling" || this.cancelling) return { dot: st.faint, label: "stopping", detail: "Stopping…", detailStyle: st.dim };
    const flash = this.lastChange && performance.now() - this.lastChange.at < CHANGE_FLASH_MS ? this.changes.find((change) => change.id === this.lastChange!.id) : undefined;
    if (state === "running") {
      const blink = Math.floor(performance.now() / 500) % 2 === 0;
      const dot = blink ? st.accent : st.pulse;
      const running = this.current?.steps.at(-1)?.state === "running" ? this.current.steps.at(-1) : undefined;
      // How many changes this answer has made so far; a plan's show one by one as they land.
      const goal = this.goal && (this.goal.state === "running" || this.goal.state === "starting") ? this.goal : undefined;
      const label = goal ? `goal · ${goal.best ? `${goal.best.score}% · ` : ""}gen ${goal.generation} · ${clockOf(performance.now() - goal.since)}` : this.match ? `matching · ${this.match.best ? `${this.match.first !== undefined && this.match.first !== this.match.best.score ? `${this.match.first}→` : ""}${this.match.best.score}% · ` : ""}${clockOf(performance.now() - this.match.since)}`
        : this.turnChanges ? `working · ${this.turnChanges} ${this.turnChanges === 1 ? "change" : "changes"}` : "working";
      const action = this.lastAction && performance.now() - this.lastAction.at < CHANGE_FLASH_MS ? this.lastAction : undefined;
      if (action && (!flash || action.at > this.lastChange!.at) && (action.memory || !running || running.tool === "make_changes" || ACTION_TOOLS.has(running.tool ?? ""))) return { dot, label, detail: `${action.glyph} ${action.title}`, detailStyle: st.bright };
      if (flash && (!running || running.tool === "make_changes")) return { dot, label, detail: `${flash.state === "heard" ? "♪" : "✓"} ${flash.title}`, detailStyle: st.bright };
      if (running) return { dot, label, detail: running.doing ?? doingLabel(running.tool, running.label), detailStyle: st.dim, activity: { kind: activityOf(running.tool), since: running.startedAt ?? performance.now() } };
      if (this.planning) return { dot, label, detail: "writing the plan", detailStyle: st.dim, activity: { kind: "code", since: this.planningSince } };
      // Thinking since the last step ended, or since the answer began.
      const since = this.current?.steps.at(-1)?.endedAt ?? this.current?.startedAt ?? this.busySince;
      return { dot, label, detail: this.current ? "thinking" : this.activity, detailStyle: st.dim, activity: { kind: "think", since } };
    }
    const action = this.lastAction && performance.now() - this.lastAction.at < CHANGE_FLASH_MS ? this.lastAction : undefined;
    // The newer of the two shows: a change Kumi made, or what it did or kept.
    if (flash && !(action && action.at > this.lastChange!.at)) return { label: "", detail: `${flash.state === "heard" ? "♪" : "✓"} ${flash.title}`, detailStyle: st.bright };
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
    // Live's Device view on the focused track: its devices as a tree (HISTORY gives up the room).
    const rows = this.treeShown();
    const clip = rows ? undefined : this.clipShown();
    const strip = rows || clip ? undefined : this.stripKind();
    const session = strip === "session" && this.strip.session?.trackRef === this.focus?.trackRef ? this.strip.session : undefined;
    const arrangement = strip === "arrangement" ? this.strip.arrangement : undefined;
    this.keepTreeFresh(rows ? "tree" : clip ? "clip" : session ? "session" : arrangement ? "arrangement" : strip ?? false);
    let nowAt = 6;
    if (rows) {
      screen.put(x + 5, area.y + 1, " · Device", st.faint);
      nowAt = 3 + this.drawTree(screen, x, area.y + 2, width, rows, Math.max(2, Math.min(12, area.height - this.bottomHeight(area.height) - 10))) + 1;
    } else if (clip) {
      screen.put(x + 5, area.y + 1, " · Clip", st.faint);
      nowAt = 3 + this.drawClip(screen, x, area.y + 2, width, clip) + 1;
    } else if (session) {
      screen.put(x + 5, area.y + 1, " · Session", st.faint);
      nowAt = 3 + this.drawSession(screen, x, area.y + 2, width, session) + 1;
    } else if (arrangement) {
      screen.put(x + 5, area.y + 1, " · Arrangement", st.faint);
      nowAt = 3 + this.drawArrangement(screen, x, area.y + 2, width, arrangement) + 1;
    } else if (!this.drawFocusPath(screen, x, area.y + 2, width, true)) this.focusLines().forEach((line, index) => put(2 + index, line.text, line.style));
    put(nowAt, "NOW", st.label);
    const now = this.nowLine();
    if (now.dot) {
      const label = ` ${now.label}`;
      const at = x + width - textWidth(label) - 1;
      screen.put(at, area.y + nowAt, "●", now.dot);
      screen.put(at + 1, area.y + nowAt, label, st.dim);
    }
    const moment = performance.now();
    if (now.activity) {
      // What's under way shimmers, and its own animation plays under it (a change Kumi just made shows instead).
      let column = x;
      for (const span of shimmer(truncate(now.detail, width), moment - now.activity.since)) column = screen.put(column, area.y + nowAt + 1, span.text, span.style);
    } else put(nowAt + 1, now.detail, now.detailStyle);
    const picture = this.flashing() ? changePicture(this.flashing()!, width, this.depth) : undefined;
    picture?.slice(0, 2).forEach((line, row) => {
      let column = x;
      for (const part of line) column = screen.put(column, area.y + nowAt + 2 + row, part.text, part.style);
    });
    if (!picture && now.activity) {
      let column = x;
      for (const span of activityScene(now.activity.kind, moment - now.activity.since, Math.min(width, 28))) column = screen.put(column, area.y + nowAt + 2, span.text, span.style);
    }
    // The lower half, anchored to the bottom: the tab strip, then the active tab (HISTORY) filling the rest.
    const bottom = this.bottomHeight(area.height);
    const top = area.y + area.height - bottom;
    this.tabsArea = { x, y: top, width, height: bottom - 1 };
    this.tabs.draw(screen, this.tabsArea, this.hits);
  }

  /** The tabbed area's height: half the pane, but at least its strip and a few rows; FOCUS gives way first. */
  private bottomHeight(pane: number): number {
    return Math.min(Math.max(7, Math.floor(pane / 2)), Math.max(1, pane - 8));
  }

  /**
   * The track and the clip, then its notes as a small piano roll (four rows; selected notes stand out
   * when there are some), then its length and how many notes. The rows it used, the track's included.
   */
  private drawClip(screen: Screen, x: number, y: number, width: number, clip: ClipView): number {
    const track = this.focus!.track!;
    const mark = icon(trackKind(track.kind), this.icons, chipColor(track.color));
    screen.put(x, y, mark.text, mark.style);
    const clipMark = icon("midi-clip", this.icons);
    let column = screen.put(x + 3, y, truncate(track.name, Math.max(1, Math.floor((width - 6) / 2))), st.text);
    column = screen.put(column, y, " › ", st.faint);
    column = screen.put(column, y, clipMark.text, clipMark.style) + 1;
    screen.put(column, y, truncate(clip.name || "Untitled clip", Math.max(1, x + width - column)), st.bright);
    const picture = clipPicture(clip, Math.min(width, 32), 4);
    picture?.forEach((line, row) => {
      let at = x;
      for (const part of line) at = screen.put(at, y + 1 + row, part.text, part.style);
    });
    const beats = clip.length; const bars = beats / 4;
    const selected = clip.notes.filter((note) => note.selected).length;
    const facts = [Number.isInteger(bars) ? `${bars} ${bars === 1 ? "bar" : "bars"}` : `${Math.round(beats * 100) / 100} beats`, `${clip.notes.length} ${clip.notes.length === 1 ? "note" : "notes"}`, selected ? `${selected} selected` : ""].filter(Boolean).join(" · ");
    screen.put(x, y + 1 + (picture ? 4 : 0), truncate(picture ? facts : `${facts} · empty`, width), st.faint);
    return 2 + (picture ? 4 : 0);
  }

  /** The track, then its slots around the selected scene: a band under the selected one, what plays in the accent, "queued" at the right. */
  private drawSession(screen: Screen, x: number, y: number, width: number, strip: SessionStrip): number {
    const track = this.focus!.track!;
    const mark = icon(trackKind(track.kind), this.icons, chipColor(track.color));
    screen.put(x, y, mark.text, mark.style);
    screen.put(x + 3, y, truncate(track.name, Math.max(1, width - 3)), st.text);
    strip.slots.forEach((slot, index) => {
      const row = y + 1 + index;
      if (slot.index === strip.scene) screen.fill({ x: x - 1, y: row, width: width + 2, height: 1 }, st.raised);
      let column = screen.put(x, row, String(slot.index + 1).padStart(3), st.faint) + 1;
      if (!slot.clip) { screen.put(column, row, "·", st.faint); return; }
      const clipMark = icon(slot.clip.audio ? "audio-clip" : "midi-clip", this.icons);
      column = screen.put(column, row, clipMark.text, clipMark.style) + 1;
      const label = slot.queued ? "queued" : slot.playing ? "playing" : "";
      screen.put(column, row, truncate(slot.clip.name || "Untitled clip", Math.max(1, x + width - column - (label ? textWidth(label) + 1 : 0))), slot.playing ? st.accent : slot.clip.name ? st.text : st.dim);
      if (label) screen.put(x + width - textWidth(label), row, label, slot.playing ? st.accent : st.faint);
    });
    return 1 + strip.slots.length;
  }

  /**
   * The Arrangement on one line (the loop's stretch heavier, the locators as ticks, the playhead in the
   * accent), then where the playhead is (its bar, the locator it's past), then the loop and the length.
   */
  private drawArrangement(screen: Screen, x: number, y: number, width: number, strip: ArrangementStrip): number {
    const track = this.focus!.track!;
    const mark = icon(trackKind(track.kind), this.icons, chipColor(track.color));
    screen.put(x, y, mark.text, mark.style);
    screen.put(x + 3, y, truncate(track.name, Math.max(1, width - 3)), st.text);
    const cells = Math.max(8, width);
    const span = Math.max(strip.length, strip.position + 4, ...strip.locators.map((locator) => locator.position + 4));
    const at = (beats: number) => Math.max(0, Math.min(cells - 1, Math.floor(beats / span * cells)));
    const line = Array.from({ length: cells }, () => ({ text: "─", style: st.faint }));
    if (strip.loop) for (let cell = at(strip.loop.start); cell <= at(strip.loop.start + strip.loop.length); cell++) line[cell] = { text: "━", style: strip.loop.enabled ? st.dim : st.faint };
    for (const locator of strip.locators) line[at(locator.position)] = { text: "┼", style: st.dim };
    line[at(strip.position)] = { text: "┃", style: st.accent };
    let column = x;
    for (const cell of line) column = screen.put(column, y + 1, cell.text, cell.style);
    const bar = (beats: number) => Math.floor(beats / 4) + 1;
    const past = [...strip.locators].filter((locator) => locator.position <= strip.position).sort((a, b) => b.position - a.position)[0];
    const where = [`bar ${bar(strip.position)}`, strip.playing ? "playing" : "", past?.name ? `after ${past.name}` : ""].filter(Boolean).join(" · ");
    const whole = [strip.loop?.enabled ? `loop ${bar(strip.loop.start)}–${bar(strip.loop.start + strip.loop.length)}` : "", `${bar(strip.length) - 1} bars`].filter(Boolean).join(" · ");
    screen.put(x, y + 2, truncate(where, width), st.dim);
    screen.put(x, y + 3, truncate(whole, width), st.faint);
    return 4;
  }

  /**
   * Messages waiting for Kumi, a line each, newest last: "↳ make it darker", and when it goes in: at
   * Kumi's next step, or after this answer. More than fit fold into "and 2 more".
   */
  private drawHeld(screen: Screen, x: number, y: number, width: number, rows: number): void {
    const shown = this.held.length > rows ? this.held.slice(-(rows - 1)) : this.held;
    if (this.held.length > rows) screen.put(x, y++, `  and ${this.held.length - shown.length} more waiting · alt+↑ takes the last back`, st.faint);
    for (const item of shown) {
      const when = item.when === "now" && (this.current || this.pendingTurn) ? "at the next step" : "after this answer";
      const words = sanitizeText(item.text, this.secrets).replace(/\s+/g, " ").trim();
      let column = screen.put(x, y, "↳ ", st.faint);
      column = screen.put(column, y, truncate(words, Math.max(1, width - textWidth(when) - 4)), st.dim);
      screen.put(x + width - textWidth(when), y, when, st.faint);
      y++;
    }
  }

  /** "▣ Audio Effect Rack › Chain 1 › Saturator  ×": what the next messages mean by "this"; × clears it. */
  private drawPin(screen: Screen, x: number, y: number, width: number): void {
    const pin = this.pinned!;
    const clear = "×";
    const mark = icon(pin.kind, this.icons);
    let column = screen.put(x, y, mark.text, mark.style) + 1;
    const room = Math.max(1, x + width - column - 3);
    const parts = fitCrumbs([...(pin.trail.length ? pin.trail : pin.track ? [pin.track] : []), pin.name], room);
    parts.forEach((part, index) => {
      if (index > 0) column = screen.put(column, y, " › ", st.faint);
      column = screen.put(column, y, part, index === parts.length - 1 ? st.bright : st.dim);
    });
    const at = column + 2;
    screen.put(at, y, clear, st.faint);
    this.hits.push({ x: at, y, width: 1, action: () => this.unpin() });
  }

  /**
   * The track, then its tree: lines faint, the path to what's selected in Live in plain text, the rest
   * quieter, what's selected (or pointed at) in the accent. At most `most` rows, the rest folded to
   * "n more". Clicking a row points at it. The rows it used, the track's included.
   */
  private drawTree(screen: Screen, x: number, y: number, width: number, rows: readonly TreeRow[], most: number): number {
    const track = this.focus!.track!;
    const mark = icon(trackKind(track.kind), this.icons, chipColor(track.color));
    screen.put(x, y, mark.text, mark.style);
    screen.put(x + 3, y, truncate(track.name, Math.max(1, width - 3)), st.text);
    const focused = rows.some((row) => row.role === "focus");
    const keep = this.treeCursor ?? rows.findIndex((row) => row.role === "focus");
    const view = treeWindow(rows, most, keep);
    // Folded ends take a row each, from the window's own.
    const cutAbove = view.above > 0 ? 1 : 0; const cutBelow = view.below > 0 ? 1 : 0;
    const visible = view.rows.slice(cutAbove, view.rows.length - cutBelow);
    let row = y + 1;
    if (cutAbove) screen.put(x, row++, `  ${view.above + 1} more`, st.faint);
    visible.forEach((item) => {
      const index = rows.indexOf(item);
      const cursor = this.treeCursor === index;
      // Live's selection: a band under the row and the accent; the keyboard's place: the picker's band.
      if (cursor || item.role === "focus") screen.fill({ x: x - 1, y: row, width: width + 2, height: 1 }, cursor ? st.selected : st.raised);
      let column = screen.put(x, row, item.prefix, st.faint);
      const mark = icon(item.kind, this.icons);
      column = screen.put(column, row, mark.text, mark.style) + 1;
      // What's pointed at in Kumi says so quietly at the right; clicking that clears it.
      const pinned = item.ref === this.pinned?.ref;
      const label = pinned ? "pinned" : "";
      const style = item.role === "focus" ? st.accent : pinned ? st.bright : !focused || item.role === "path" ? st.text : st.dim;
      const count = item.count ? ` (${item.count})` : "";
      const name = truncate(item.name, Math.max(1, x + width - column - textWidth(count) - (label ? textWidth(label) + 1 : 0)));
      column = screen.put(column, row, name, style);
      if (count) screen.put(column, row, count, st.faint);
      if (label) {
        const at = x + width - textWidth(label);
        screen.put(at, row, label, st.faint);
        this.hits.push({ x: at, y: row, width: textWidth(label), action: () => this.unpin() });
      }
      const at = row;
      this.hits.push({ x, y: at, width, action: () => { this.treeCursor = undefined; this.pin(item); } });
      row++;
    });
    if (cutBelow) screen.put(x, row++, `  ${view.below + 1} more`, st.faint);
    return row - y;
  }

  /** MEMORY's forget: gone from Kumi's memory (its event marks the row), or already gone. */
  private async forgetKept(entry: { forgotten?: boolean; forget: () => Promise<boolean> }): Promise<void> {
    const gone = await entry.forget().catch(() => false);
    if (!gone && !entry.forgotten) { entry.forgotten = true; this.notice("That was already gone.", "info"); }
    this.scheduler.request();
  }

  /** Something Kumi kept, used or forgot: a line in the conversation, and a moment in NOW. */
  private memoryLine(what: MemoryKind, text: string): void {
    const clean = sanitizeText(text, this.secrets).replaceAll("\n", " ").slice(0, 300);
    this.transcript.add({ kind: "memory", what, text: clean });
    this.lastAction = { title: clean.slice(0, 120), at: performance.now(), glyph: MEMORY_GLYPHS[what], memory: true };
    setTimeout(() => { if (!this.closing) this.scheduler.request(); }, CHANGE_FLASH_MS + 20).unref?.();
  }

  /** A save for MEMORY; an update replaces its row. */
  private keep(key: string, what: MemoryKind, title: string, forget: () => Promise<boolean>): void {
    const index = this.kept.findIndex((entry) => entry.key === key);
    if (index >= 0) this.kept.splice(index, 1);
    this.kept.push({ key, what, title: sanitizeText(title, this.secrets).replaceAll("\n", " ").slice(0, 200), forget });
    if (this.kept.length > 50) this.kept.shift();
  }

  private forgotten(key: string): void {
    const entry = this.kept.find((candidate) => candidate.key === key);
    if (entry) entry.forgotten = true;
  }

  /**
   * HISTORY's rows: what Kumi kept this session first (its latest three, each with its forget), then
   * Kumi's changes, newest first, each with its own undo; a title gets two lines, so the values
   * ("0.0 dB → -2.0 dB") aren't the part cut off.
   */
  /**
   * The GOAL tab: what it's after, how far it's got (generations, candidates heard, time), the best
   * score with its trend as a small sparkline, the leader, what the model tried last, and where the
   * best is kept. Quiet: the numbers that matter in the palette's text, the rest dim.
   */
  private goalRows(width: number): TabRow[] {
    const goal = this.goal;
    if (!goal) return [];
    const clean = (text: string, max: number) => sanitizeText(text, this.secrets).replaceAll("\n", " ").slice(0, max);
    const running = goal.state === "running" || goal.state === "starting";
    const elapsed = running ? performance.now() - goal.since : goal.elapsedMs;
    const rows: TabRow[] = [];
    const line = (spans: TabRow["spans"]) => rows.push(...wrap(spans, width).map((row) => ({ spans: row })));
    line([{ text: clean(goal.goal, 300), style: st.text }]);
    const state = { starting: "setting up", running: "searching", paused: `paused${goal.why && goal.why !== "paused" ? ` · ${clean(goal.why, 80)}` : ""} · /goal carries on`, done: `done${goal.why ? ` · ${clean(goal.why, 80)}` : ""}` }[goal.state];
    line([{ text: `${state} · gen ${goal.generation} · ${goal.rendered} heard · ${goal.candidates} ${goal.candidates === 1 ? "candidate" : "candidates"} · ${clockOf(elapsed)}`, style: st.dim }]);
    if (goal.best) {
      const trend = goal.trend.slice(-Math.max(4, width - 16));
      const low = Math.min(...trend); const high = Math.max(...trend);
      const spark = trend.map((value) => "▁▂▃▄▅▆▇█"[high > low ? Math.round((value - low) / (high - low) * 7) : 7]).join("");
      line([{ text: `${goal.best.score}%`, style: st.accent }, { text: goal.first !== undefined && goal.first !== goal.best.score ? ` from ${goal.first}%  ` : "  ", style: st.dim }, { text: spark, style: st.accent }]);
      if (goal.leader) line([{ text: "best  ", style: st.faint }, { text: clean(goal.leader, 200), style: st.text }]);
    }
    if (goal.idea) line([{ text: "tried  ", style: st.faint }, { text: clean(goal.idea, 200), style: st.dim }]);
    if (goal.bestTrack) line([{ text: "kept on  ", style: st.faint }, { text: clean(goal.bestTrack, 80), style: st.text }]);
    const tokens = this.tokensUsed();
    if (tokens) line([{ text: tokens.replace(/^ · /, ""), style: st.faint }]);
    return rows;
  }

  private historyRows(width: number): TabRow[] {
    const rows: TabRow[] = [];
    const kept = [...this.kept].reverse().slice(0, 3);
    for (const entry of kept) {
      rows.push({ spans: [{ text: `${MEMORY_GLYPHS[entry.what]} `, style: { fg: palette[entry.what] } }, { text: entry.title, style: entry.forgotten ? st.faint : st.text }],
        right: { text: entry.forgotten ? "forgotten" : "forget", style: entry.forgotten ? st.faint : st.accent },
        ...(entry.forgotten ? {} : { action: () => { void this.forgetKept(entry); } }) });
    }
    if (this.kept.length > 3) rows.push({ spans: [{ text: `${this.kept.length - 3} more kept · /memory`, style: st.faint }] });
    if (kept.length && this.changes.length) rows.push({ spans: [] });
    // Ids restart with each Kumi process (a resumed conversation's may repeat), so rows are keyed by place.
    for (const [place, change] of [...this.changes].reverse().entries()) {
      // An audition changed nothing: a quiet line, its score where an undo would be.
      const heard = change.state === "heard";
      const action = heard ? (change.score !== undefined ? `${change.score}%` : "heard") : change.state === "applied" ? "undo" : change.state === "undone" ? "undone" : change.state === "kept" ? "kept" : change.state === "expired" ? "no undo" : "check Live";
      const actionStyle = heard ? st.dim : change.state === "applied" ? st.accent : change.state === "undone" || change.state === "expired" ? st.faint : st.warn;
      const titleStyle = heard ? st.dim : change.state === "undone" || change.state === "expired" ? st.faint : st.text;
      const lines = wrap([{ text: change.title, style: titleStyle }], Math.max(1, width - textWidth(action) - 3)).map((spans) => spans.map((span) => span.text).join(""));
      const marker = heard ? { text: "♪ ", style: st.faint } : change.state === "undone" || change.state === "expired" ? { text: "○ ", style: st.faint }
        : change.state === "unsure" ? { text: "● ", style: st.warn }
        : change.track ? { text: "■ ", style: { fg: chipColor(change.track.color) } as Style } : { text: "✓ ", style: st.accent };
      const undo = change.state === "applied" ? { action: () => { void this.undo(change.id); } } : {};
      rows.push({ spans: [marker, { text: lines[0] ?? "", style: titleStyle }], right: { text: action, style: actionStyle }, item: `change ${place}`, ...undo });
      if (lines.length > 1) rows.push({ spans: [{ text: "  ", style: titleStyle }, { text: lines.slice(1).join(" "), style: titleStyle }], item: `change ${place}`, ...undo });
    }
    return rows;
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
      } else if (now.activity) {
        // Narrow: the step's own glyph, then its words.
        const glyph = activityGlyph(now.activity.kind, performance.now() - now.activity.since, this.icons === "badges");
        screen.put(2, area.y + 1, glyph.text, glyph.style);
        screen.put(4, area.y + 1, truncate(now.detail, area.width - 6), now.detailStyle);
      } else screen.put(2, area.y + 1, truncate(now.detail, area.width - 4), now.detailStyle);
    }
  }

  private drawComposer(screen: Screen, box: Rect, layout: EditorLayout, visibleRows: number): Cursor {
    screen.fill(box, st.raised);
    const x = box.x + 2;
    const width = Math.max(1, box.width - 4);
    const first = Math.max(0, Math.min(layout.cursorRow - visibleRows + 1, layout.rows.length - visibleRows));
    if (this.editor.isEmpty) {
      const placeholder = this.busy && (this.current || this.pendingTurn) ? "Tell Kumi more while it works" : this.connection === "connected" ? "Ask Kumi about your Set" : "Ask Kumi anything";
      screen.put(x, box.y + 1, truncate(placeholder, width), st.faint);
    } else {
      layout.rows.slice(first, first + visibleRows).forEach((row, index) => screen.put(x, box.y + 1 + index, row, st.bright, box));
    }
    const hint = this.panel?.kind === "btw" ? "↑↓ to scroll · c copies · esc to close" : this.panel?.kind === "pick" ? "↑↓ to move · enter to choose · esc to close" : this.panel?.kind === "key" ? "enter to save · esc to cancel"
      : this.panel?.kind === "chatgpt" ? (this.panel.url ? "c copies the link · esc to cancel" : "esc to cancel")
      : this.menu().length ? "enter to choose · esc to close"
      : this.busy && !this.editor.isEmpty && !isCommand(this.editor.text.trim()) ? (this.current || this.pendingTurn ? "enter sends now · tab after · esc stops" : "enter sends when ready")
      : this.busy ? "esc to stop" : "enter to send";
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
    } else if (panel.kind === "btw") {
      const aside = this.asides[panel.at];
      const which = this.asides.length > 1 ? `${panel.at + 1} of ${this.asides.length} · ←→` : undefined;
      lines.push({ text: `btw · ${aside?.question.replaceAll("\n", " ") ?? ""}`, style: st.title, ...(which ? { right: { text: which, style: st.faint } } : {}) });
      if (aside && !aside.answer.trim()) {
        const glyph = activityGlyph("think", performance.now());
        lines.push({ text: "", style: st.dim, spans: aside.state === "asking" ? [glyph, { text: " thinking it over…", style: st.dim }] : [{ text: "No answer came back.", style: st.faint }] });
      } else if (aside) {
        const rows = renderMarkdown(aside.answer.trim(), inner, aside.state === "failed" ? st.warn : st.text);
        const room = Math.max(3, Math.min(16, space - 4));
        panel.scroll = Math.max(0, Math.min(panel.scroll, rows.length - room));
        const shown = rows.slice(panel.scroll, panel.scroll + room);
        shown.forEach((row, index) => {
          const more = index === 0 && panel.scroll > 0 ? `↑ ${panel.scroll} more` : index === shown.length - 1 && panel.scroll + room < rows.length ? `↓ ${rows.length - panel.scroll - room} more` : undefined;
          lines.push({ text: "", style: st.text, spans: row.spans, ...(more ? { right: { text: more, style: st.faint } } : {}) });
        });
        if (aside.state === "asking") lines.push({ text: "", style: st.dim, spans: [activityGlyph("think", performance.now())] });
      }
      if (aside?.state === "asking") this.scheduler.request();
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
      let column = start;
      if (line.spans) for (const span of line.spans) column = screen.put(column, y, span.text, span.style, { x: start, y, width: Math.max(1, end - start), height: 1 });
      else column = screen.put(start, y, truncate(line.text, Math.max(1, end - start)), line.style);
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
    const width = Math.min(70, left - 2);
    const top = boxTop - items.length - 1;
    if (top < 2) return;
    // What the chosen command does, in a column after the longest name.
    const about = 3 + MENU_NAME_WIDTH + 2;
    screen.fill({ x: 1, y: top - 1, width, height: items.length + 1 }, st.raised);
    items.forEach((item, index) => {
      const y = top + index;
      const chosen = index === this.menuIndex;
      if (chosen) screen.fill({ x: 1, y, width, height: 1 }, st.selected);
      screen.put(3, y, item.name, chosen ? st.accent : st.text);
      if (chosen) screen.put(about, y, truncate(item.about, Math.max(1, width - about - 1)), st.bright);
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
 * A clip as a tiny piano roll in braille, `rows` rows high (two by default): time runs across, higher
 * notes sit higher, louder notes are brighter, or, when some are marked selected, those are. Notes a
 * few semitones apart sit at their distance; wider ones get a lane per pitch, spread out, and more
 * pitches than lanes share them.
 */
export function clipPicture(clip: { length: number; notes: readonly (ClipNote & { selected?: boolean })[] }, width: number, rows = 2): { text: string; style: Style }[][] | undefined {
  if (!(clip.length > 0) || !clip.notes.length) return undefined;
  const cells = Math.max(8, Math.min(32, width));
  const columns = cells * 2;
  const lanes = rows * 4;
  const pitches = [...new Set(clip.notes.map((note) => note.pitch))].sort((a, b) => b - a);
  const high = pitches[0]!; const low = pitches[pitches.length - 1]!;
  // Notes within fewer semitones than there are lanes sit at their real distance, centred; wider ones are spread.
  const top = Math.floor((lanes - 1 - (high - low)) / 2);
  const lane = (pitch: number) => high - low < lanes ? top + high - pitch
    : pitches.length <= lanes ? Math.round(pitches.indexOf(pitch) * (lanes - 1) / (pitches.length - 1)) : Math.round((high - pitch) * (lanes - 1) / (high - low));
  // With a selection, what's selected stands out (as a loud note would); the rest is quiet.
  const marking = clip.notes.some((note) => note.selected);
  const weight = (note: ClipNote & { selected?: boolean }) => (marking ? (note.selected ? 127 : 1) : note.velocity);
  // The strongest weight at each dot, 0 where there's no note.
  const dots = Array.from({ length: lanes }, () => Array<number>(columns).fill(0));
  for (const note of clip.notes) {
    const first = Math.min(columns - 1, Math.max(0, Math.floor(note.start / clip.length * columns)));
    const last = Math.max(first, Math.min(columns - 1, Math.ceil((note.start + note.duration) / clip.length * columns) - 1));
    const row = dots[lane(note.pitch)]!;
    for (let column = first; column <= last; column++) row[column] = Math.max(row[column]!, weight(note));
  }
  return Array.from({ length: rows }, (_, textRow) => {
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
