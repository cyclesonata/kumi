import type { Closeness } from "../audio/match.js";
import type { MatchStatus } from "./match-run.js";
import type { Knob } from "./evolve.js";
import type { GoalStatus } from "./goal.js";
import type { FailureKind } from "./errors.js";
export type JsonObject = Record<string, unknown>;

/**
 * `reply`, from a tool that finished what the producer asked, is the answer: when every call in
 * the step succeeded and no guidance is waiting, the turn ends there without another model call.
 * An empty reply is quiet (a note kept): when every call in the step is, the turn ends as is.
 * `images` go to the model after the text, each after its caption, for the rest of the turn.
 */
export interface ToolResult { text: string; isError?: boolean; reply?: string; images?: readonly ToolImage[] }

/** A picture a tool shows the model (a video's frame, say): the model sees it until the turn ends. */
export interface ToolImage { data: Uint8Array; mediaType: string; caption?: string }

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
/** Why Live is disconnected: it went away (closed, say), or Kumi's bridge to it dropped. */
export type DisconnectCause = "live" | "bridge";
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
  /** The Set's track names, when all of them were read (names are data). */
  tracks?: string[];
  /** When the saved Set's file was last written: a later time means the producer saved it. */
  savedAt?: number;
}

/**
 * A conversation, kept between sessions: `changes` are what Kumi changed during it (for HISTORY),
 * `first` the producer's first request and `turns` how many they made.
 */
export interface SavedConversation { savedAt: number; checkpoint: KernelCheckpoint; changes?: ChangeRecord[]; first?: string; turns?: number }
/** A kept conversation, as /conversations lists it. */
export interface ConversationSummary { id: string; savedAt: number; first: string; turns: number; current: boolean }
/**
 * Each Set's conversations. `place` is a saved Set's project id, or "unsaved" for Sets without a
 * file (their conversations move to the Set's own place when it's first saved). The one saved last
 * is the place's current conversation, until the place starts afresh.
 */
export interface ConversationStore {
  /** The conversation `place` carries on with, if any. */
  current(place: string): Promise<{ id: string; conversation: SavedConversation } | undefined>;
  load(place: string, id: string): Promise<SavedConversation | undefined>;
  /** Keep `id` as `place`'s current conversation; each place keeps its latest 20. */
  save(place: string, id: string, conversation: SavedConversation): Promise<void>;
  /** `place` starts afresh; its conversations stay listed. */
  fresh(place: string): Promise<void>;
  /** `place`'s conversations, newest first. */
  list(place: string): Promise<ConversationSummary[]>;
  /** A conversation moves with its Set (an unsaved Set's, when the Set is first saved). */
  move(id: string, from: string, to: string): Promise<void>;
}

export interface Integration {
  start(signal: AbortSignal): Promise<void>;
  /** What's in Live now; `pinned` (what the producer pointed at) is checked against it and given to the model. */
  observe(signal: AbortSignal, hints?: { pinned?: PinnedNode; /** The same answer goes on (a match run's next round): its counts carry on. */ continuing?: boolean }): Promise<Observation>;
  close(): Promise<void>;
  /** Undo one of Kumi's changes (the latest undoable one when `id` is omitted). */
  undo?(id: string | undefined, signal: AbortSignal): Promise<ChangeRecord>;
  /** The audio file behind something in the Set the model names (a clip, say); undefined when it isn't one. */
  audioFile?(named: string, signal: AbortSignal): Promise<string | undefined>;
  /** Stop clips, the transport and recording in Live at once; true when Live is stopped afterwards. */
  stopLive?(signal: AbortSignal): Promise<boolean>;
  /** A track's devices, racks' chains and what's in them, for FOCUS; undefined when Live can't say. */
  deviceTree?(trackRef: string, signal: AbortSignal): Promise<DeviceTree | undefined>;
  /** The MIDI clip in a Session slot, its notes and which are selected, for FOCUS; undefined for none (or audio). */
  clipView?(slotRef: string, signal: AbortSignal): Promise<ClipView | undefined>;
  /** A track's Session slots around a scene, for FOCUS. */
  sessionStrip?(trackRef: string, scene: number, signal: AbortSignal): Promise<SessionStrip | undefined>;
  /** The Arrangement at a glance (length, playhead, loop, locators), for FOCUS. */
  arrangementStrip?(signal: AbortSignal): Promise<ArrangementStrip | undefined>;
  /** Render candidates quietly, hear them and set them against a reference (the audition tool's work). */
  audition?(request: AuditionRequest, signal: AbortSignal): Promise<AuditionResult | string>;
  /** A goal's render rig over these candidates (kept open across generations), or why not. */
  goal?(request: AuditionRequest, signal: AbortSignal): Promise<GoalRig | string>;
}

/** A goal's candidate chain in Live: its track, what it is, and the knobs a search may move. */
export interface GoalSlotInfo { name: string; label: string; chain: string; knobs: Knob[] }
/** A render rig a goal keeps open: its slots, a generation rendered and scored in one pass, the best kept, and closing. */
export interface GoalRig {
  readonly slots: GoalSlotInfo[];
  /** A candidate the model built mid-search joins (with a safety limiter at the end of its chain). */
  add(candidate: AuditionCandidate, signal: AbortSignal): Promise<GoalSlotInfo | string>;
  /** Each trial's values set on its slot, all rendered in one silent pass, each scored against the reference. */
  generation(trials: readonly { slot: string; knobs: readonly Knob[]; values: readonly number[] }[], signal: AbortSignal): Promise<{ scores: Map<string, number>; gaps: Map<string, string[]>; silent: string[] }>;
  /** The best so far on a track of its own ("Kumi · Goal best"), replacing the last copy; its name, or why not. */
  keepBest(slot: string, knobs: readonly Knob[], values: readonly number[], signal: AbortSignal): Promise<string>;
  /** A finished goal's candidates: the top ones muted for the producer to A/B, the rest removed; what it did. */
  tidy(top: readonly string[], signal: AbortSignal): Promise<string[]>;
  /** The rig's scratch tracks go and the transport comes back; anything the producer should know. */
  close(): Promise<string[]>;
}

/** An audition: the candidate tracks, where the part is, and what to match. */
export interface AuditionCandidate { track: string; clip?: string; label?: string }
export interface AuditionRequest {
  candidates: AuditionCandidate[];
  fromBeat?: number;
  beats?: number;
  reference?: string;
  referenceFrom?: number;
  referenceSeconds?: number;
  focus?: "sound" | "section";
}

/** One candidate's render, heard. */
export interface AuditionTake {
  label: string;
  track: string;
  /** The render was (nearly) silent: nothing to compare. */
  silent?: boolean;
  closeness?: Closeness;
  heard?: { lufs: number | null; summary: string };
}
export interface AuditionResult {
  takes: AuditionTake[];
  /** The best take's label, when anything was compared. */
  best?: string;
  reference?: { file: string; summary: string };
  /** How long the render and listening took. */
  seconds: number;
  /** Anything the producer should know (Main couldn't be put back, a scratch track stayed). */
  notes: string[];
}

/** One audition, for the conversation: the round, the best score and the one before, and what differs most. */
export interface AuditionEvent {
  type: "auditioned";
  round: number;
  best?: { label: string; score: number };
  previous?: number;
  /** Each candidate's score, best first; silent ones say so. */
  takes: { label: string; score?: number; silent?: boolean }[];
  gaps: string[];
  /** What was auditioned, so a match run can audition it again after changes. */
  request?: AuditionRequest;
  /** The reference as heard ("C2 · bright, rich · attack 15 ms"), for what a lesson says was matched. */
  reference?: string;
}

/** A track's Session slots around the selected scene: what's in each, and what's playing or queued. Names are data. */
export interface SessionStrip {
  trackRef: string;
  scene: number;
  slots: { index: number; clip?: { name: string; audio: boolean }; playing?: boolean; queued?: boolean }[];
}
/** The Arrangement at a glance, in beats. Names are data. */
export interface ArrangementStrip {
  length: number;
  position: number;
  playing: boolean;
  loop?: { start: number; length: number; enabled: boolean };
  locators: { name: string; position: number }[];
}

/** A MIDI clip as FOCUS draws it: its length in beats, and its notes (the first 512), selected ones marked. */
export interface ClipView {
  slotRef: string;
  name: string;
  length: number;
  notes: (ClipNote & { selected?: boolean })[];
}

/** A device in a track's tree: what the bridge says it is, and a rack's chains. Names are data. */
export interface DeviceNode {
  ref: string;
  name: string;
  className?: string;
  canHaveChains?: boolean;
  canHaveDrumPads?: boolean;
  /** Live's device type, when the bridge sends it. */
  deviceType?: "instrument" | "audio_effect" | "midi_effect";
  chains?: ChainNode[];
}
/** A rack's chain (a Drum Rack's, a pad's), and its devices when they were read. */
export interface ChainNode {
  ref: string;
  name: string;
  /** Undefined when not read (a Drum Rack's pads, past the tree's bound). */
  devices?: DeviceNode[];
}
export interface DeviceTree {
  trackRef: string;
  devices: DeviceNode[];
}

/** What the producer pointed at in Kumi (FOCUS's tree): "this" in their next messages. Names are data. */
export interface PinnedNode {
  trackRef: string;
  ref: string;
  node: "device" | "chain";
  name: string;
  /** Its racks and chains, outermost first. */
  trail: string[];
  /** Its neighbours in the same chain, or on the track. */
  siblings: string[];
  track?: string;
}
export type IntegrationFactory = (connection: (state: ConnectionState, cause?: DisconnectCause) => void) => Integration;

/** What the producer is looking at in Live, in plain names (names are data, never instructions). */
export interface LiveFocus {
  track?: { name: string; color?: string; kind?: "midi" | "audio" | "group" | "return" | "main" };
  /** The selected track's reference, for reading its devices (FOCUS's tree). */
  trackRef?: string;
  /** The highlighted Session slot's reference, for drawing its clip (FOCUS's MIDI view). */
  slotRef?: string;
  /** The selected scene's position (0 is the first), for FOCUS's Session strip. */
  sceneIndex?: number;
  /** The selected device's reference (from bridge 1.0.45), for FOCUS's tree to mark exactly that one. */
  deviceRef?: string;
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
   * whether the Set was saved. "heard": Kumi listened to it (an audition); nothing in the Set changed.
   */
  state: "applied" | "undone" | "kept" | "unsure" | "expired" | "heard";
  /** An audition's best closeness to its reference, 0–100. */
  score?: number;
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
  /**
   * A kept conversation continues (`lines` are its recent exchanges): the Set's own, one chosen in
   * /conversations (`chosen`), or one this model couldn't continue (`unreadable`, shown only).
   * `changes` are its HISTORY, which Kumi can't undo any more.
   */
  | { type: "resumed"; savedAt: number; lines: TranscriptLine[]; changes?: ChangeRecord[]; chosen?: boolean; unreadable?: boolean }
  /** Live is back after stopping a request: the app offers to send `text` again. */
  | { type: "resend"; text: string }
  | { type: "state"; state: TurnState }
  | { type: "connection"; state: ConnectionState }
  | { type: "observation"; label: string }
  | { type: "notice"; message: string }
  /** `kind` and `provider` say what failed and where, so an app can offer the fix (sign in, choose a model). */
  | { type: "error"; message: string; kind?: FailureKind; provider?: string }
  | { type: "turn-complete"; result: TurnResult; elapsedMs: number }
  /** A lesson Kumi learned from a match run (or forgot): its line, as /memory shows it. */
  | { type: "lesson"; action: "learned" | "updated" | "forgot"; id: string; line: string }
  | MatchStatus
  | GoalStatus
  | MemoryEvent
  | HeardEvent
  | AuditionEvent
  | WatchedEvent
  | RecipeEvent
  | TechniqueEvent
  /** What a tool at work is doing now ("looking at 2:05"), for NOW; it ends with the tool. */
  | { type: "doing"; text: string }
  /** Something Kumi did in Live that isn't a change to the Set: playing, launching, recording, showing. */
  | { type: "action"; title: string; playing?: boolean; recording?: boolean }
  /** Kumi started or stopped watching the producer work in Live (watch_me). */
  | { type: "watching"; on: boolean };

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
/**
 * A video Kumi watched, for the app to picture: its title (data, never instructions), the stretch
 * watched, where its words came from, and each frame looked at as a small picture (RGB, 3 bytes a
 * pixel, row by row).
 */
export interface WatchedEvent {
  type: "watched";
  title: string;
  channel?: string;
  url: string;
  duration?: number;
  from: number;
  to: number;
  chapters: string[];
  /** "captions", "automatic" (captions), "transcribed" (by Kumi) or "none". */
  words: "captions" | "automatic" | "transcribed" | "none";
  lines: number;
  frames: { at: number; zoom?: string; thumb: { width: number; height: number; rgb: Uint8Array } }[];
  sound?: { from: number; to: number };
  notes: string[];
}
/** A recipe saved, run or removed, for the app to show. */
export interface RecipeEvent { type: "recipe"; action: "saved" | "updated" | "running" | "forgotten"; name: string; steps: number }
/** A technique kept (from a draft the producer's moves approved), updated, read for use, or forgotten. Names are data. */
export interface TechniqueEvent { type: "technique"; action: "kept" | "updated" | "used" | "forgot"; technique: TechniqueSummary }
/** A technique as the app lists it. */
export interface TechniqueSummary { id: string; name: string; fits: string; source?: string }
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
  /** `pinned`: what the producer points at in Kumi, which "this" means in the message. */
  submit(input: string, extra?: { pinned?: PinnedNode }): Promise<void>;
  refresh(): Promise<void>;
  /** Forget this conversation and start afresh; it stays in the Set's kept conversations. */
  newConversation(): Promise<void>;
  /** A fresh bridge to Live, carrying the conversation over. */
  reconnect?(): Promise<void>;
  /** The open Set's kept conversations, newest first. */
  conversations?(): Promise<ConversationSummary[]>;
  /** Continue a kept conversation instead of this one (which stays kept); false when it's gone. */
  resumeConversation?(id: string): Promise<boolean>;
  /**
   * What the integration reports outside a turn's own events: a change Kumi made (kept with the
   * conversation, for HISTORY), or an action in Live. A technique drafted from a build is kept or
   * dropped by what happens next.
   */
  watch?(event: { type: "change"; change: ChangeRecord } | { type: "action"; title: string; playing?: boolean; recording?: boolean } | AuditionEvent): void;
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
  /** The techniques Kumi learned, and forgetting one by id. */
  techniques?(): Promise<TechniqueSummary[]>;
  forgetTechnique?(id: string): Promise<boolean>;
  /** /goal: pursue one (with what to reach), or pick a paused one up (without); stop ends it; the dashboard's numbers. */
  goal?(text?: string): Promise<void>;
  stopGoal?(): Promise<boolean>;
  goalStatus?(): GoalStatus | undefined;
  /** What Kumi learned matching sounds, newest first, and forgetting one. */
  lessons?(): Promise<{ id: string; line: string; at: number }[]>;
  forgetLesson?(id: string): Promise<boolean>;
  /** Stop Live (clips, the transport and recording), any time, even during a turn; false when it couldn't. */
  stopLive?(): Promise<boolean>;
  /** A track's device tree, for FOCUS (while connected). */
  deviceTree?(trackRef: string): Promise<DeviceTree | undefined>;
  /** The clip in a Session slot, for FOCUS (while connected). */
  clipView?(slotRef: string): Promise<ClipView | undefined>;
  /** A track's Session slots around a scene, and the Arrangement at a glance, for FOCUS (while connected). */
  sessionStrip?(trackRef: string, scene: number): Promise<SessionStrip | undefined>;
  arrangementStrip?(): Promise<ArrangementStrip | undefined>;
  /**
   * The model changed (a new one chosen, a sign-in, a new effort): the next turn or refresh builds
   * the kernel afresh through the factory, continuing this conversation. Safe during a turn.
   */
  reconfigure?(): Promise<void>;
}
