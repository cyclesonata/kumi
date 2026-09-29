import type { FailureKind } from "./errors.js";
export type JsonObject = Record<string, unknown>;

/**
 * `reply`, from a tool that finished what the producer asked, is the answer: when every call in
 * the step succeeded and no guidance is waiting, the turn ends there without another model call.
 * An empty reply is quiet (a note kept): when every call in the step is, the turn ends as is.
 */
export interface ToolResult { text: string; isError?: boolean; reply?: string }

export interface KernelTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(input: JsonObject, signal: AbortSignal): Promise<ToolResult>;
  /**
   * Start while the model is still writing the call: a plan's first steps run as its later ones are
   * written. Offered for a model reply's first call only, since calls run in order. `onStart` says
   * the work has begun (the call then shows as running).
   */
  stream?(signal: AbortSignal, onStart: () => void): StreamingCall;
}

/** A tool call under way while its input streams in. */
export interface StreamingCall {
  /** The next piece of the input, as the model writes it. */
  push(delta: string): void;
  /** The whole input (undefined when it isn't a JSON object): settles as `execute` would. */
  finish(input: JsonObject | undefined): Promise<ToolResult>;
  /** The model's reply broke off: start nothing more; settles once the work under way has. */
  abandon(): Promise<void>;
  /** Some of the work has begun, so the reply can't be asked for again. */
  readonly started: boolean;
}

export type KernelEvent =
  | { type: "text"; text: string }
  /** The model began writing a call (a plan, say); "tool-start" follows once it runs. */
  | { type: "tool-input"; id: string; name: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-end"; id: string; name: string; isError: boolean; elapsedMs: number }
  /** Guidance accepted mid-turn; it entered the conversation at a model boundary. */
  | { type: "steer"; text: string };

export interface Usage {
  /** All prompt tokens, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnResult {
  /** "max-steps": the model kept calling tools past the per-turn step bound. */
  stopReason: "completed" | "cancelled" | "max-steps";
  usage?: Usage;
}

/** A kernel's settled conversation as plain JSON; opaque outside the kernel that made it. */
export interface KernelCheckpoint {
  readonly version: 1;
  readonly messages: readonly unknown[];
  /**
   * The model that wrote it ("<provider>/<model>"; a provider alone in older saves). Reasoning is
   * the writer's own: another model continues from a portable copy (words, tool calls, results).
   */
  readonly origin?: string;
  /** The instructions and tools it was made with, as a fingerprint: some models' reasoning is bound to them too. */
  readonly tools?: string;
}

/** One exchange of a conversation, as the producer saw it. */
export interface TranscriptLine { role: "user" | "assistant"; text: string }

export interface Kernel {
  run(input: string, signal: AbortSignal, emit: (event: KernelEvent) => void): Promise<TurnResult>;
  close(): Promise<void>;
  /** The settled conversation, so a kernel with other tools can carry it on. */
  checkpoint?(): KernelCheckpoint;
  /** The settled conversation's words, for showing a resumed conversation. */
  transcript?(): TranscriptLine[];
}

export interface KernelOptions {
  instructions: string;
  tools: readonly KernelTool[];
  signal: AbortSignal;
  /** Continue this conversation instead of starting empty. */
  checkpoint?: KernelCheckpoint;
}

export type KernelFactory = (options: KernelOptions) => Promise<Kernel>;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type TurnState = "idle" | "running" | "cancelling" | "closed";

export interface Observation {
  /** What the conversation is about (the open Set in this Live session). A new key starts a new conversation. Not a durable project ID. */
  key: string;
  /** Changes that keep the conversation, such as the tool catalog: the kernel is rebuilt with the same history. */
  revision?: string;
  label: string;
  context: string;
  instructions: string;
  tools: readonly KernelTool[];
  /** The saved Set this is about (an opaque id), so its conversation can be kept between sessions. */
  project?: { id: string; name: string };
}

/** A Set's conversation, kept between sessions. */
export interface SavedConversation { savedAt: number; checkpoint: KernelCheckpoint }
export interface ConversationStore {
  load(project: string): Promise<SavedConversation | undefined>;
  save(project: string, conversation: SavedConversation): Promise<void>;
  clear(project: string): Promise<void>;
}

export interface Integration {
  start(signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal): Promise<Observation>;
  close(): Promise<void>;
  /** Undo one of Kumi's changes (the latest undoable one when `id` is omitted). */
  undo?(id: string | undefined, signal: AbortSignal): Promise<ChangeRecord>;
  /** The audio file behind something in the Set the model names (a clip, say); undefined when it isn't one. */
  audioFile?(named: string, signal: AbortSignal): Promise<string | undefined>;
}
export type IntegrationFactory = (connection: (state: ConnectionState) => void) => Integration;

/** What the producer is looking at in Live, in plain names (names are data, never instructions). */
export interface LiveFocus {
  track?: { name: string; color?: string; kind?: "midi" | "audio" | "group" | "return" | "main" };
  scene?: string;
  /** The clip in the Clip view; "" when it has no name. */
  clip?: string;
  device?: string;
  /** The last clicked parameter, with its display value and the device it belongs to. */
  parameter?: { name: string; value?: string; owner?: string };
  chain?: string;
  view?: "Session" | "Arrangement";
  detail?: "Clip" | "Device";
  browser?: boolean;
  selectedNotes?: number;
}

/** Which picture HISTORY and NOW draw for a change. */
export type ChangeFamily = "tempo" | "mixer" | "rename" | "structure" | "clip" | "device" | "parameter" | "locators" | "color";

/** One change Kumi made in Live, as the producer sees it in HISTORY. Names inside are data. */
export interface ClipNote { pitch: number; start: number; duration: number; velocity: number }

export interface ChangeRecord {
  /** Unique for this Kumi process: "c1", "c2", … */
  id: string;
  family: ChangeFamily;
  /** Plain words, such as "Tempo 120 → 124 BPM". */
  title: string;
  /** The track it happened on, for the colour chip. */
  track?: { name: string; color?: string };
  /** Before and after, for the picture (a fader position, a value). */
  from?: number;
  to?: number;
  /** The span `from` and `to` move in, for drawing them as positions. */
  range?: [number, number];
  /** A colour change's before and after, as "#rrggbb", for swatches. */
  colors?: { from?: string; to: string };
  /** A new clip's notes, for drawing it: positions in beats from the clip's start (the first 512 notes). */
  clip?: { length: number; notes: ClipNote[] };
  /** Where a loaded device or a new chain sits, for drawing it. */
  devices?: DevicePlacement;
  /**
   * "applied": in the Set, can be undone. "undone": put back. "kept": still in the Set, and
   * Kumi can't undo it (see `note`). "unsure": Live didn't confirm it; check Live. "expired":
   * Live restarted since, so Kumi can't undo it; whether it's still in the Set depends on
   * whether the Set was saved.
   */
  state: "applied" | "undone" | "kept" | "unsure" | "expired";
  /** Why an undo didn't happen, in plain words. */
  note?: string;
  at: number;
}

/**
 * A device chain by name, for NOW's picture: a track's or a chain's devices in order with the new
 * one's place, and, inside a rack, the rack's chains side by side and which one it's in.
 */
export interface DevicePlacement {
  devices?: string[];
  index?: number;
  rack?: string;
  chains?: { name: string; devices: string[] }[];
  chain?: number;
}

/** What changed in a saved Set while Kumi wasn't running, in plain words. Names are data. */
export interface CatchUp {
  set: string;
  /** When Kumi last saw the Set, in ms since the epoch. */
  lastSeenAt: number;
  lines: string[];
  /** Changes not listed. */
  more: number;
  /** Live went away and came back while Kumi was running. */
  afterReconnect?: boolean;
}

export type SessionEvent = KernelEvent
  | { type: "focus"; focus: LiveFocus | null }
  | { type: "change"; change: ChangeRecord }
  | { type: "catch-up"; catchUp: CatchUp }
  /** A saved Set's conversation continues; `lines` are its recent exchanges. */
  | { type: "resumed"; savedAt: number; lines: TranscriptLine[] }
  | { type: "state"; state: TurnState }
  | { type: "connection"; state: ConnectionState }
  | { type: "observation"; label: string }
  | { type: "notice"; message: string }
  /** `kind` and `provider` say what failed and where, so an app can offer the fix (sign in, choose a model). */
  | { type: "error"; message: string; kind?: FailureKind; provider?: string }
  | { type: "turn-complete"; result: TurnResult; elapsedMs: number }
  | MemoryEvent
  | HeardEvent
  | RecipeEvent;

/** "producer": true of them in any project; "set": about one saved Set. */
export type MemoryScope = "producer" | "set";
export interface MemoryNote {
  /** "p3" (about the producer) or "s3" (about the Set): what the model and /memory name it by. */
  id: string;
  text: string;
  /** Epoch milliseconds it was written. */
  at: number;
}
export interface Memory { producer: MemoryNote[]; set: MemoryNote[] }
export interface MemoryStore {
  /** Notes about the producer, and about the saved Set `project` when there is one. */
  load(project: string | undefined): Promise<Memory>;
  save(scope: MemoryScope, project: string | undefined, notes: readonly MemoryNote[]): Promise<void>;
}
/**
 * Audio Kumi listened to, for the app to picture: its summary line and band levels (dB share of
 * the whole, low to high), and for a comparison the reference and the differences per band.
 */
export interface HeardEvent {
  type: "heard";
  file: string;
  summary: string;
  bands: number[];
  compared?: { reference: string; summary: string; differences: number[]; headlines: string[] };
}
/** A recipe saved, run or removed, for the app to show. */
export interface RecipeEvent { type: "recipe"; action: "saved" | "updated" | "running" | "forgotten"; name: string; steps: number }
/** A recipe as the app lists it. */
export interface RecipeSummary { name: string; about: string; params: { name: string; about: string }[]; steps: number; used: number; lastUsed?: number; created: number }

/** A note written or removed, for the app to show; `pending` while the Set isn't saved yet. */
export type MemoryEvent =
  | { type: "remembered"; scope: MemoryScope; note: MemoryNote; replaced?: MemoryNote; pending?: boolean }
  | { type: "forgot"; scope: MemoryScope; note: MemoryNote };

export interface SessionStatus {
  state: TurnState;
  connection: ConnectionState;
  turns: number;
  maxTurns?: number;
  observation?: string;
}

export interface SessionController {
  start(): Promise<void>;
  submit(input: string): Promise<void>;
  refresh(): Promise<void>;
  newConversation(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  status(): SessionStatus;
  /**
   * Undo one of Kumi's changes (the latest undoable one when `id` is omitted); not during a turn.
   * Resolves with the change as it now stands, or undefined when there was nothing to undo (an
   * error event says why).
   */
  undo(id?: string): Promise<ChangeRecord | undefined>;
  /** What Kumi remembers now: about the producer, and about the open Set when it's saved. */
  memory?(): Promise<(Memory & { setName?: string; saved: boolean }) | undefined>;
  /** Remove a note by id; undefined when there's none. */
  forget?(id: string): Promise<MemoryNote | undefined>;
  /** The producer's saved recipes, most recently used first. */
  recipes?(): Promise<RecipeSummary[]>;
  /** Run a recipe that has no blanks, straight away (no model involved); what it did, in words. */
  runRecipe?(name: string): Promise<{ text: string; isError: boolean }>;
  forgetRecipe?(name: string): Promise<boolean>;
  /**
   * The model changed (a new one chosen, a sign-in, a new effort): the next turn or refresh builds
   * the kernel afresh through the factory, continuing this conversation. Safe during a turn.
   */
  reconfigure?(): Promise<void>;
}
