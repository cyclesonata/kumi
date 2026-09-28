export type JsonObject = Record<string, unknown>;

export interface KernelTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(input: JsonObject, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
}

export type KernelEvent =
  | { type: "text"; text: string }
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
  /** The provider that wrote it; another provider continues from a portable copy (text and tool calls). */
  readonly origin?: string;
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
  | { type: "error"; message: string }
  | { type: "turn-complete"; result: TurnResult; elapsedMs: number };

export interface SessionStatus {
  state: TurnState;
  connection: ConnectionState;
  turns: number;
  maxTurns: number;
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
}
