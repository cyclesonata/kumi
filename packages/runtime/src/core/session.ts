import { randomBytes } from "node:crypto";
import type {
  AuditionEvent, AuditionRequest, ChangeRecord, ConnectionState, ConversationStore, DisconnectCause, Integration, IntegrationFactory, JsonObject, Kernel, KernelCheckpoint, KernelFactory, KernelTool, MemoryStore, Observation, SavedConversation,
  SessionController, SessionEvent, SessionStatus, ToolResult, TurnResult, TurnState, PinnedNode } from "./contracts.js";
import { KumiError } from "./errors.js";
import { memoryInstructions, memoryTools } from "./memory.js";
import { recipeInstructions, recipeTools, RUN_RECIPE_TOOL, type RecipeStore } from "./recipes.js";
import { listeningTools } from "../audio/tools.js";
import { videoTools } from "../video/tool.js";
import { asksForTechnique, PLAN_TECHNIQUE, TECHNIQUE_GUIDANCE, TECHNIQUE_NUDGE, techniqueInstructions, techniqueTools, type TechniqueStore } from "./techniques.js";
import { GAP_GUIDANCE, gapTools } from "./gaps.js";
import { OBSERVATION_MARKER, transcriptOf } from "../kernel/budget.js";
import { GOAL_BUDGET, goalLeap, goalSetup, type GoalBudget, type GoalState, type GoalStatus, type GoalStore } from "./goal.js";
import { Evolution, type Knob } from "./evolve.js";
import { lessonFrom, lessonFromGoal, lessonLine, playbookBrief, type Lesson, type PlaybookStore } from "./playbook.js";
import { NEGATIVE, POSITIVE } from "./techniques.js";
import { KEEP_GOING, MATCH_BUDGET, MatchRun, startsMatch, type MatchBudget } from "./match-run.js";

interface Options {
  kernelFactory: KernelFactory;
  integrationFactory: IntegrationFactory;
  onEvent: (event: SessionEvent) => void;
  /** How long starting, refreshing or undoing may take. */
  timeoutMs?: number;
  /** How long a turn may go without progress (streamed text, tool steps) before it stops; timeoutMs, or 3 minutes. */
  idleTimeoutMs?: number;
  /** However much progress it makes, a turn stops after this long. */
  turnLimitMs?: number;
  closeTimeoutMs?: number;
  cancelGraceMs?: number;
  /** Prompts per session before /new is needed; none by default, since the kernel keeps its own context in bounds. */
  maxTurns?: number;
  /** Keeps each Set's conversations between sessions; without it conversations end with Kumi. */
  conversations?: ConversationStore;
  /** How long Live may be away before Kumi asks whether it's open. */
  missingAfterMs?: number;
  /** What Kumi remembers about the producer and each saved Set; without it Kumi keeps no notes. */
  memory?: MemoryStore;
  /** Let the model hear audio files (reference tracks, samples, bounces). */
  listen?: boolean;
  /** The producer's saved recipes; without it none are offered. */
  recipes?: RecipeStore;
  /** Let the model watch videos (tutorials): where videos are kept, and the programs Kumi fetches. */
  watch?: { videosDir: string; toolsDir: string };
  /** What Kumi learned building things the producer liked; without it none are kept. */
  techniques?: TechniqueStore;
  /** How long a drafted technique waits for a sign before it's kept anyway. */
  techniqueSettleMs?: number;
  /** Where missing capabilities are logged for Kumi's developers (JSON lines); without it they aren't. */
  gaps?: string;
  /** Kumi's lessons from match runs; without it none are kept. */
  playbook?: PlaybookStore;
  /** Where goals are kept (one per Set), so they survive a restart; without it goals last a session. */
  goals?: GoalStore;
  goalBudget?: Partial<GoalBudget>;
  /** For tests: the goal search's random source. */
  goalRandom?: () => number;
  /** Match runs' budget (generous by default); false leaves matching to the model alone. */
  match?: Partial<MatchBudget> | false;
}
interface Operation {
  id: number;
  /** A turn's request, to offer again when Live's going away stopped it. */
  input?: string;
  controller: AbortController;
  done: Promise<void>;
  isTurn: boolean;
  phase: "start" | "refresh" | "inference" | "undo";
  /** The turn moved on (text, a tool step): its no-progress timer starts over. */
  progress?: (event?: { type: string }) => void;
  /** A turn that needs longer (a match run): its limit, from now. */
  extend?: (ms: number) => void;
  /** How long a cancelled turn may take to put things back (a goal's cleanup) before it's set aside. */
  linger?: number;
  /** A turn that's at work the whole time (a goal): no quiet timer, only its limit. */
  steady?: boolean;
}
/** Where an unsaved Set keeps its conversations until it's saved. */
const UNSAVED = "unsaved";
const newConversationId = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
/** HISTORY kept with a conversation: what it shows, without a clip's notes or where devices sit. */
const MAX_CHANGES = 100;
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const lean = ({ clip: _clip, devices: _devices, ...change }: ChangeRecord): ChangeRecord => change;
const STILL_MISSING = "Kumi can't reach Live. Is it open, with AbletonMcpBridge chosen as a Control Surface (Settings → Link, Tempo & MIDI)?";

/** "3 minutes", "1 second". */
const span = (ms: number) => {
  const [count, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.max(1, Math.round(ms / 1000)), "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
};

export function createSession(options: Options): SessionController {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const idleMs = options.idleTimeoutMs ?? options.timeoutMs ?? 180_000;
  const turnLimitMs = options.turnLimitMs ?? 20 * 60_000;
  const budget: MatchBudget = { ...MATCH_BUDGET, ...(options.match || {}) };
  /** The match run this answer is in, and the last one (for "keep going"). */
  let matching: MatchRun | undefined; let lastRun: MatchRun | undefined;
  /** The latest audition (a goal's setup and leaps hand over their candidates through it). */
  let heardLast: AuditionEvent | undefined;
  const goalBudget: GoalBudget = { ...GOAL_BUDGET, ...options.goalBudget };
  /** The goal being pursued, or the last one this session (paused, or done). */
  let goalState: GoalState | undefined;
  let goalStatusNow: GoalStatus | undefined;
  /** The running goal's operation, and whether /goal stop (not Esc) ended it. */
  let goalOp: Operation | undefined; let goalStopped = false;
  /** The goal's reference as heard, for its lesson. */
  let goalReference: string | undefined;
  /** The last run's lesson, for "keep going" to update and the producer's next words to judge. */
  let lastLesson: { id: string; judged: boolean } | undefined;
  let playbookQueue: Promise<unknown> = Promise.resolve();
  const playbookSerial = <T>(work: (store: PlaybookStore) => Promise<T>): Promise<T | undefined> => {
    const store = options.playbook;
    if (!store) return Promise.resolve(undefined);
    const next = playbookQueue.then(() => work(store), () => work(store));
    playbookQueue = next.catch(() => undefined);
    return next.catch(() => undefined);
  };
  /** A run ended: its lesson is kept (a carried-on run's replaces the one before), and shown. */
  function learnFrom(run: MatchRun, carried: boolean) {
    const lesson = lessonFrom(run, Date.now());
    if (!lesson) return;
    const replacing = carried ? lastLesson?.id : undefined;
    const kept: Lesson = replacing ? { ...lesson, id: replacing } : lesson;
    lastLesson = { id: kept.id, judged: false };
    void playbookSerial(async (store) => {
      const lessons = await store.list();
      await store.save([...lessons.filter((item) => item.id !== kept.id), kept]);
      emit({ type: "lesson", action: replacing ? "updated" : "learned", id: kept.id, line: lessonLine(kept) });
    });
  }
  /** The producer's first words after a run: liking it or not is evidence for its lesson. */
  function judgeLesson(input: string) {
    const lesson = lastLesson;
    if (!lesson || lesson.judged) return;
    lesson.judged = true;
    const reaction = NEGATIVE.test(input) ? "disliked" as const : POSITIVE.test(input) ? "liked" as const : undefined;
    if (!reaction) return;
    void playbookSerial(async (store) => {
      const lessons = await store.list();
      if (!lessons.some((item) => item.id === lesson.id)) return;
      await store.save(lessons.map((item) => (item.id === lesson.id ? { ...item, reaction } : item)));
    });
  }
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  const graceMs = options.cancelGraceMs ?? 500;
  const maxTurns = options.maxTurns;
  for (const value of [timeoutMs, idleMs, turnLimitMs, closeTimeoutMs, graceMs, maxTurns ?? 1]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid session bound");
  let state: TurnState = "idle";
  let connection: ConnectionState = "disconnected";
  let observationLabel: string | undefined;
  let integration: Integration | undefined;
  let integrationGeneration = 0;
  let kernel: { value: Kernel; key: string; revision: string; lifetime: AbortController } | undefined;
  let mustReset = false;
  /** The model changed: the kernel is rebuilt at the next safe point, carrying the conversation on. */
  let rebuild = false;
  /** That conversation, and whose Set it is. */
  let switched: { checkpoint: KernelCheckpoint; key: string } | undefined;
  /** Live went away while connected; cleared when it's back. */
  let away = false;
  /** Asks whether Live is open, once it's been away a while. */
  let missing: ReturnType<typeof setTimeout> | undefined;
  /** The request Live's going away stopped, offered again when it's back. */
  let interrupted: string | undefined;
  /** Where the conversation is kept (its Set's project id, or "unsaved"), its id there, and what /conversations shows of it. */
  let place: string | undefined;
  let conversationId = newConversationId();
  let conversationFirst: string | undefined;
  let conversationTurns = 0;
  /** Kumi's changes during this conversation, kept with it (a resumed conversation's HISTORY). */
  let conversationChanges: ChangeRecord[] = [];
  /** Kumi's changes while it's been running, as they stand now: HISTORY shows these already, with their undo. */
  const seen = new Map<string, ChangeRecord>();
  /** The conversation as it last settled: a turn that didn't stop when asked restarts from it. */
  let settled: { checkpoint: KernelCheckpoint; key: string } | undefined;
  /** A fresh bridge (/reconnect) carries the conversation over, unless a different saved Set is open then. */
  let carry: { checkpoint: KernelCheckpoint; place: string | undefined } | undefined;
  /** /new: the next conversation starts empty. */
  let startFresh = false;
  /** A conversation chosen in /conversations, to continue next. */
  let chosen: { place: string; id: string; conversation: SavedConversation } | undefined;
  /** Saves happen in order, one at a time. */
  let saving: Promise<void> = Promise.resolve();
  /** The saved Set the conversation is about, when known. */
  let currentProject: string | undefined;
  /** Which Set is open, saved or not: notes about an unsaved Set are kept only if that Set is saved. */
  let currentSet: string | undefined;
  /** When the open Set's file was last written, as last seen. */
  let setSavedAt: number | undefined;
  /** The open Set's name, for /memory. */
  let currentSetName: string | undefined;
  // Notes are kept by the model's own calls; each write is quiet, so it costs no model reply.
  const notes = options.memory ? memoryTools({ store: options.memory, project: () => currentProject, set: () => currentSet, onEvent: (event) => emit(event) }) : undefined;
  // Recipes run through the open Set's plan tool, with its checks, HISTORY and undo.
  let planTool: KernelTool | undefined;
  const recipes = options.recipes ? recipeTools({ store: options.recipes, plan: () => planTool, onEvent: (event) => emit(event) }) : [];
  // Files are found by path; the integration can also name something in the Set by its file.
  const listening = options.listen ? listeningTools({ onEvent: (event) => emit(event),
    resolve: (named, signal) => integration?.audioFile?.(named, signal) ?? Promise.resolve(undefined) }) : [];
  const watching = options.watch ? videoTools({ ...options.watch, onEvent: (event) => emit(event) }) : [];
  // Techniques are drafted by the model and kept by what the producer does next.
  const learned = options.techniques ? techniqueTools({ store: options.techniques, onEvent: (event) => emit(event), ...(options.techniqueSettleMs !== undefined ? { settleMs: options.techniqueSettleMs } : {}) }) : undefined;
  const gaps = options.gaps ? gapTools({ file: options.gaps }) : [];
  /**
   * make_changes also carries a technique: the model writes what makes a build work in the call that
   * builds it (a final plan ends the answer, so there's no later moment). It's taken out before the
   * plan runs, streamed or not.
   */
  function withTechnique(tool: KernelTool): KernelTool {
    if (!learned || tool.name !== "make_changes") return tool;
    const take = (input: JsonObject): JsonObject => {
      const { technique, ...rest } = input;
      if (technique && typeof technique === "object" && !Array.isArray(technique)) learned.draftFrom(technique as Record<string, unknown>);
      return rest;
    };
    // A build without its technique: the result asks for one, while the answer goes on.
    const nudge = (input: JsonObject | undefined) => async (result: Promise<ToolResult>): Promise<ToolResult> => {
      const outcome = await result;
      return input && !outcome.isError && outcome.reply === undefined && asksForTechnique(input) ? { ...outcome, text: `${outcome.text}\n${TECHNIQUE_NUDGE}` } : outcome;
    };
    const properties = (tool.inputSchema as { properties?: JsonObject }).properties ?? {};
    const stream = tool.stream;
    return { ...tool, description: `${tool.description} ${PLAN_TECHNIQUE.description}`, inputSchema: { ...tool.inputSchema, properties: { ...properties, technique: PLAN_TECHNIQUE.schema } },
      execute: (input, signal) => nudge(input)(tool.execute(take(input), signal)),
      ...(stream ? { stream: (signal: AbortSignal, onStart: () => void) => {
        const call = stream.call(tool, signal, onStart);
        return { push: (delta: string) => call.push(delta), finish: (input: JsonObject | undefined) => nudge(input)(call.finish(input ? take(input) : input)), abandon: () => call.abandon(), get started() { return call.started; } };
      } } : {}) };
  }
  let turns = 0;
  let nextOperation = 0;
  let active: Operation | undefined;
  let closing: Promise<void> | undefined;
  let started = false;

  const emit = (event: SessionEvent) => { if (state !== "closed") options.onEvent(event); };
  const setState = (next: TurnState) => { if (state !== "closed") { state = next; options.onEvent({ type: "state", state }); } };
  const current = (op: Operation) => state !== "closed" && active === op && !op.controller.signal.aborted;
  const assertCurrent = (op: Operation) => { if (!current(op)) throw new Error("Operation cancelled"); };
  async function boundedClose(work: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Cleanup timed out")), closeTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async function dropKernel() {
    const previous = kernel; kernel = undefined;
    if (previous) { previous.lifetime.abort(); await boundedClose(previous.value.close()); }
  }
  async function dropResources() {
    const previous = integration; integration = undefined;
    integrationGeneration++; observationLabel = undefined;
    connection = "disconnected"; emit({ type: "connection", state: connection });
    const outcomes = await Promise.allSettled([dropKernel(), previous ? boundedClose(previous.close()) : Promise.resolve()]);
    if (outcomes.some((result) => result.status === "rejected")) throw new Error("Owned resource cleanup did not complete");
  }
  function connectionChanged(generation: number, next: ConnectionState, cause?: DisconnectCause) {
    if (generation !== integrationGeneration || state === "closed") return;
    const lost = connection === "connected" && (next === "disconnected" || next === "error");
    const back = away && next === "connected";
    connection = next; emit({ type: "connection", state: next });
    if (lost) {
      // Work in progress stops (it would act on a Live that's gone); the conversation stays, and so
      // does the request, to send again.
      observationLabel = undefined; away = true;
      emit({ type: "notice", message: cause === "live" ? "Live closed. Kumi will pick up where you left off when it's back."
        : cause === "bridge" ? "Kumi's link to Live dropped. It's reconnecting, and will pick up where you left off."
        : "Kumi lost touch with Live. It will pick up where you left off when Live is back." });
      if (active?.isTurn && active.input) interrupted = active.input;
      active?.controller.abort();
      clearTimeout(missing);
      missing = setTimeout(() => { if (away && state !== "closed") emit({ type: "notice", message: STILL_MISSING }); }, options.missingAfterMs ?? 30_000);
      missing.unref?.();
    } else if (back) {
      away = false; clearTimeout(missing);
      const again = interrupted; interrupted = undefined;
      emit({ type: "notice", message: again ? "Live is back. Your last request was stopped; press enter to send it again." : "Live is back." });
      if (again) emit({ type: "resend", text: again });
      // Read the Set again right away when nothing else is running.
      if (!active && started) void perform(false, "refresh", async (op) => { await observe(op); return undefined; }).catch(() => {});
    }
  }
  /** A change Kumi made while it's been running (HISTORY has it, maybe with its undo). */
  const ours = (change: ChangeRecord) => seen.get(change.id)?.at === change.at;
  /** This conversation is `id` in `place` from now on (a kept one, when `conversation` is given). */
  function begin(where: string, id: string, conversation?: SavedConversation) {
    place = where; conversationId = id; settled = undefined;
    conversationFirst = conversation?.first; conversationTurns = conversation?.turns ?? 0;
    // Its HISTORY: changes from an earlier session get ids of their own, and Kumi can't undo them now.
    conversationChanges = (conversation?.changes ?? []).map((change) => ours(change) ? seen.get(change.id)! : {
      ...change, id: change.id.includes(":") ? change.id : `${id}:${change.id}`,
      ...(change.state === "applied" || change.state === "unsure" ? { state: "expired" as const, note: "From an earlier session, so Kumi can't undo it now." } : {}) });
  }
  async function ensureKernel(op: Operation, observation: Observation) {
    assertCurrent(op);
    if (rebuild) {
      rebuild = false;
      const held = kernel;
      if (held?.value.checkpoint) switched = { checkpoint: held.value.checkpoint(), key: held.key };
      await dropKernel(); assertCurrent(op);
    }
    const identityChanged = kernel !== undefined && kernel.key !== observation.key;
    const revision = observation.revision ?? "";
    let carried: KernelCheckpoint | undefined;
    if (kernel && !identityChanged && !mustReset && kernel.revision !== revision) {
      // Same Set, new tools (say, a first clip made clip tools appear): keep the conversation (the
      // new kernel drops reasoning made with the old tools).
      if (kernel.value.checkpoint) carried = kernel.value.checkpoint();
      if (carried) { await dropKernel(); assertCurrent(op); }
    }
    let reason: "set" | "cancelled" | "tools" | undefined;
    const first = kernel === undefined && !mustReset;
    if (kernel && (identityChanged || mustReset || kernel.revision !== revision)) {
      await dropKernel(); assertCurrent(op);
      reason = identityChanged ? "set" : mustReset ? "cancelled" : "tools";
      if (identityChanged) turns = op.isTurn ? 1 : 0;
    } else if (!kernel && mustReset) reason = "cancelled";
    if (!kernel) {
      const project = observation.project?.id;
      // Which conversation this is, and where it carries on from.
      let from = carried;
      let resumed: SavedConversation | undefined;
      let picked = false;
      // A fresh bridge (/reconnect) carries the conversation over, unless a different saved Set is open now.
      const reconnected = carry && !(project && carry.place && carry.place !== UNSAVED && carry.place !== project) ? carry : undefined;
      if (startFresh) begin(project ?? UNSAVED, newConversationId());
      else if (chosen) { resumed = chosen.conversation; from = resumed.checkpoint; picked = true; begin(chosen.place, chosen.id, resumed); }
      else if (from) { /* the same conversation, with other tools */ }
      // A model change carries the conversation on (same Set only; a new Set has its own).
      else if (switched?.key === observation.key) from = switched.checkpoint;
      else if (reconnected) from = reconnected.checkpoint;
      // A turn that didn't stop when asked: back to where the conversation last settled.
      else if (reason === "cancelled" && settled?.key === observation.key) from = settled.checkpoint;
      else {
        // A Set this conversation isn't about yet (Kumi starting, another Set opened): the Set's own.
        const kept = project && options.conversations ? await options.conversations.current(project).catch(() => undefined) : undefined;
        assertCurrent(op);
        if (kept) { resumed = kept.conversation; from = kept.conversation.checkpoint; if (kept.id !== conversationId || place !== project) begin(project!, kept.id, kept.conversation); }
        else begin(project ?? UNSAVED, newConversationId());
      }
      startFresh = false; chosen = undefined; switched = undefined; carry = undefined;
      const build = async (checkpoint: KernelCheckpoint | undefined) => {
        const lifetime = new AbortController();
        const abortCreation = () => lifetime.abort();
        op.controller.signal.addEventListener("abort", abortCreation, { once: true });
        try {
          // The notes go into the instructions once, when the conversation's kernel is built: they stay
          // in the prompt cache, and a note kept meanwhile is in the conversation already.
          const remembered = options.memory ? await options.memory.load(observation.project?.id).catch(() => undefined) : undefined;
          assertCurrent(op);
          const saved = options.recipes ? await options.recipes.list().catch(() => []) : [];
          assertCurrent(op);
          // Techniques by name and what each fits; the model reads one whole when a request fits it.
          const known = learned ? await learned.list().catch(() => []) : [];
          assertCurrent(op);
          const extra = [remembered ? memoryInstructions(remembered, observation.project?.name) : "", recipeInstructions(saved),
            learned ? TECHNIQUE_GUIDANCE : "", techniqueInstructions(known), gaps.length ? GAP_GUIDANCE : ""].filter(Boolean).join("\n\n");
          const value = await options.kernelFactory({ instructions: extra ? `${observation.instructions}\n\n${extra}` : observation.instructions,
            tools: [...observation.tools.map(withTechnique), ...(notes?.tools ?? []), ...listening, ...watching, ...recipes, ...(learned?.tools ?? []), ...gaps], signal: lifetime.signal, ...(checkpoint ? { checkpoint } : {}) });
          if (!current(op)) { lifetime.abort(); await boundedClose(value.close()); throw new Error("Operation cancelled"); }
          return { value, lifetime };
        } catch (error) { lifetime.abort(); throw error; }
        finally { op.controller.signal.removeEventListener("abort", abortCreation); }
      };
      let built: { value: Kernel; lifetime: AbortController };
      let unreadable: SavedConversation | undefined;
      try { built = await build(from); }
      catch (error) {
        // A kept conversation this model can't continue: it's shown, and a fresh one starts (the kept one stays).
        if (!resumed || error instanceof KumiError || !current(op)) throw error;
        unreadable = resumed;
        begin(project ?? UNSAVED, newConversationId());
        built = await build(undefined);
      }
      const { value } = built;
      kernel = { value, key: observation.key, revision, lifetime: built.lifetime };
      const set = observation.project?.name ?? "this Set";
      if (unreadable) {
        emit({ type: "resumed", savedAt: unreadable.savedAt, lines: transcriptOf(unreadable.checkpoint.messages).slice(-20), unreadable: true });
        emit({ type: "notice", message: "Kumi couldn't continue that conversation with this model, so it's shown above and a fresh one starts here." });
      } else {
        if (reason === "set") emit({ type: "notice", message: resumed ? `The open Set changed; continuing your conversation about ${set}.` : "The open Set changed; starting a fresh conversation." });
        else if (reason === "cancelled") emit({ type: "notice", message: from ? "Cancelled work was discarded; the conversation continues from before it." : "Cancelled work was discarded; starting a fresh conversation." });
        else if (reason === "tools") emit({ type: "notice", message: from ? "Kumi's tools changed; the conversation continues." : "Kumi's tools changed; starting a fresh conversation." });
        // Show the earlier exchanges when this conversation isn't already on screen.
        // Changes HISTORY shows already (made while Kumi's been running) aren't listed again.
        const earlier = conversationChanges.filter((change) => !ours(change));
        if (resumed && (first || reason === "set" || picked)) emit({ type: "resumed", savedAt: resumed.savedAt, lines: value.transcript?.().slice(-20) ?? [],
          ...(earlier.length ? { changes: earlier } : {}), ...(picked ? { chosen: true } : {}) });
      }
    }
    mustReset = false;
  }
  /** Keep the settled conversation with its Set (a turn's, when `turn`); best effort, never in the way of the answer. */
  function saveConversation(turn: boolean) {
    const held = kernel;
    if (!held?.value.checkpoint) return;
    let checkpoint: KernelCheckpoint;
    try { checkpoint = held.value.checkpoint(); } catch { return; } // the kernel was busy
    settled = { checkpoint, key: held.key };
    if (turn) conversationTurns++;
    conversationFirst ??= transcriptOf(checkpoint.messages).find((line) => line.role === "user")?.text.slice(0, 200);
    const store = options.conversations; const where = place; const id = conversationId;
    if (!store || !where) return;
    const conversation: SavedConversation = { savedAt: Date.now(), checkpoint, turns: conversationTurns, ...(conversationFirst ? { first: conversationFirst } : {}),
      ...(conversationChanges.length ? { changes: conversationChanges.slice(-MAX_CHANGES) } : {}) };
    saving = saving.then(() => store.save(where, id, conversation)).catch(() => {});
  }
  async function observe(op: Operation, pinned?: PinnedNode, continuing = false) {
    assertCurrent(op);
    if (!integration) throw new Error("Integration not started");
    op.phase = "refresh";
    observationLabel = undefined;
    const snapshot = await integration.observe(op.controller.signal, pinned || continuing ? { ...(pinned ? { pinned } : {}), ...(continuing ? { continuing } : {}) } : undefined);
    assertCurrent(op);
    // The Set was saved since the last look (its first save, or its file written again): a technique
    // drafted from work in it is kept.
    if (currentSet === snapshot.key && ((!currentProject && snapshot.project?.id) || (setSavedAt !== undefined && snapshot.savedAt !== undefined && snapshot.savedAt > setSavedAt))) learned?.drafts.saved();
    setSavedAt = snapshot.savedAt;
    currentProject = snapshot.project?.id; currentSetName = snapshot.project?.name; currentSet = snapshot.key;
    planTool = snapshot.tools.find((tool) => tool.name === "make_changes");
    // Notes about a Set made before its first save are kept now that it has a file.
    if (currentProject) void notes?.flush().catch(() => {});
    await ensureKernel(op, snapshot); assertCurrent(op);
    // A drafted technique whose build's tracks are all gone was thrown away.
    if (snapshot.tracks) learned?.drafts.observed(snapshot.tracks);
    // An unsaved Set's conversation goes with it to its folder when the Set is first saved.
    if (place === UNSAVED && snapshot.project && options.conversations) {
      const store = options.conversations; const id = conversationId; const to = snapshot.project.id;
      place = to;
      saving = saving.then(() => store.move(id, UNSAVED, to)).catch(() => {});
    }
    observationLabel = snapshot.label;
    emit({ type: "observation", label: snapshot.label });
    return snapshot;
  }
  async function reset(op: Operation) {
    op.phase = "start";
    await dropResources(); assertCurrent(op);
    turns = 0; mustReset = false;
    const generation = ++integrationGeneration;
    integration = options.integrationFactory((next, cause) => connectionChanged(generation, next, cause));
    await integration.start(op.controller.signal); assertCurrent(op);
    await observe(op); started = true;
  }
  /**
   * A match run's rounds, after the model's first answer: while the gate isn't met and budget
   * remains, audition the best (when it changed since the last audition) and send the model back in.
   * Everything shows: the status in NOW, a line per audition. Esc ends it like any turn.
   */
  async function runMatch(op: Operation, run: MatchRun, first: TurnResult, ask: (text: string, observation: string) => Promise<TurnResult>): Promise<TurnResult> {
    op.extend?.(budget.ms + 5 * 60_000);
    let result = first;
    const usage = { ...emptyUsage(), ...first.usage };
    const add = (more: TurnResult) => { for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += more.usage?.[key] ?? 0; };
    emit(run.status("running"));
    while (result.stopReason === "completed" && !op.controller.signal.aborted) {
      if (run.needsAudition && integration?.audition) {
        emit({ type: "doing", text: "Listening to where it's got to" });
        await integration.audition(run.last!.request!, op.controller.signal).catch(() => undefined);
        assertCurrent(op);
      }
      let decision = run.decide();
      // The model's ideas have run out: Kumi's own knob search tunes the best before the wrap-up.
      if ("stop" in decision && (decision.stop === "plateau" || decision.stop === "budget") && run.polishes) {
        const tuned = await polish(op, run);
        assertCurrent(op);
        if (tuned) decision = { ...decision, wrapUp: `${tuned} ${run.wrapUp(decision.stop === "plateau" ? "Refining and new ideas both stopped gaining." : "That's the run's budget spent.")}` };
      }
      emit(run.status("running"));
      const text = "next" in decision ? decision.next : decision.wrapUp;
      if (!text) { emit(run.status("done", "stop" in decision ? decision.stop : undefined)); break; }
      const snapshot = await observe(op, undefined, true); assertCurrent(op);
      op.phase = "inference";
      result = await ask(text, snapshot.context); add(result);
      if ("stop" in decision) { emit(run.status("done", decision.stop)); break; }
    }
    return { ...result, usage };
  }
  /**
   * A match run's last step: Kumi's knob search (a goal's, on one candidate) tunes the best for a few
   * minutes, far more settings than the model can try one audition at a time. What it finds is kept only
   * when heard at full length it beats the settings it started from; otherwise they're put back. What it
   * says goes to the model, for the wrap-up (and the knobs it moved, to rebuild it elsewhere).
   */
  const round3 = (value: number) => Number(value.toPrecision(3));
  async function polish(op: Operation, run: MatchRun): Promise<string | undefined> {
    const request = run.last?.request; const candidate = run.bestCandidate; const label = run.best?.label;
    run.polished = true;
    if (!integration?.goal || !request?.reference || !candidate || !label) return undefined;
    op.extend?.(run.polishMs + 10 * 60_000);
    op.progress?.({ type: "tool-start" });
    emit({ type: "doing", text: `Tuning ${label}'s knobs` });
    const signal = op.controller.signal;
    try {
      const rig = await integration.goal({ ...request, candidates: [{ ...candidate, label }] }, signal).catch((error: unknown) => error instanceof Error ? error.message : "it couldn't start");
      if (typeof rig === "string") { emit({ type: "notice", message: `Kumi's knob search couldn't tune ${label}: ${rig}` }); return undefined; }
      const evolution = new Evolution(options.goalRandom ?? Math.random);
      for (const slot of rig.slots) evolution.add(slot);
      const winner = evolution.slots[0]!;
      const knobs = winner.knobs; const start = winner.elite.slice();
      const keyOf = (knob: Knob) => `${knob.device}|${knob.name}`;
      let from: number | undefined; let to: number | undefined; let kept: { knobs: Knob[]; values: number[] } | undefined; const notes: string[] = [];
      try {
        // Where it starts, heard at full length: what the tuning has to beat.
        from = (await rig.generation([{ slot: winner.name, knobs, values: start }], signal, { screen: false })).scores.get(winner.name);
        if (from === undefined) return undefined;
        const began = Date.now(); let silentRuns = 0;
        while (Date.now() - began < run.polishMs && !signal.aborted) {
          const trials = evolution.propose();
          const slots = new Map(evolution.slots.map((slot) => [slot.name, slot]));
          const result = await rig.generation(trials.map((trial) => ({ slot: trial.slot, knobs: slots.get(trial.slot)!.knobs, values: trial.values, ...(trial.how === "recheck" ? { fresh: true } : {}) })), signal, { screen: rig.screens });
          evolution.scored(trials, result.scores);
          for (const [name, keys] of result.frozen) evolution.freeze(name, keys);
          op.progress?.({ type: "tool-start" }); op.progress?.({ type: "tool-end" });
          emit({ type: "doing", text: `Tuning ${label}'s knobs · ${evolution.rendered} settings heard` });
          // A setting that silences it (a level or a filter at an extreme) is just a bad draw; silence pass after pass means the renders aren't coming through.
          silentRuns = result.scores.size ? 0 : silentRuns + 1;
          if (silentRuns >= 3 || evolution.stalledFor >= 12) break;
        }
        const best = evolution.leader;
        // The search's best, heard at full length (a long part is searched on a window of it), on the winner's own track.
        const moved = best && best.knobs.some((knob, index) => best.elite[index] !== start[knobs.findIndex((item) => keyOf(item) === keyOf(knob))]);
        if (best && moved) to = (await rig.generation([{ slot: winner.name, knobs: best.knobs, values: best.elite, fresh: true }], signal, { screen: false })).scores.get(winner.name);
        if (best && to !== undefined && to >= from + 1) kept = { knobs: best.knobs, values: best.elite };
      } finally {
        notes.push(...await rig.close().catch(() => ["Kumi couldn't remove its render tracks; delete the “Kumi · render” tracks by hand."]));
        const cleanup = AbortSignal.timeout(120_000);
        // Left at what won: the tuned settings, or the ones it started from.
        const settled = await rig.settle(winner.name, kept?.knobs ?? knobs, kept?.values ?? start, cleanup);
        if (settled) notes.push(`Its settings couldn't all be put back (${settled}); check ${winner.name}.`);
      }
      const heard = `Kumi's knob search then tried ${evolution.rendered} settings of ${label} (on “${winner.name}”)`;
      if (!kept) return `[Kumi] ${heard}: none beat it at full length (${Math.round(from)}%), so its settings are as you left them.${notes.length ? ` ${notes.join(" ")}` : ""}`;
      run.tuned(`${label}, tuned`, Math.round(to!));
      const changed = kept.knobs.flatMap((knob, index) => {
        const was = start[knobs.findIndex((item) => keyOf(item) === keyOf(knob))]; const now = kept!.values[index]!;
        return was === undefined || Math.abs(now - was) < 1e-6 * Math.max(1, knob.max - knob.min) ? [] : [`${knob.device.replace(/^\d+:/, "")} ${knob.name} ${round3(was)} → ${round3(now)}`];
      });
      return `[Kumi] ${heard}: ${Math.round(from)}% → ${Math.round(to!)}% at full length, kept on the track (and a Limiter ends its chain for safety). The knobs it moved: ${changed.slice(0, 30).join("; ")}${changed.length > 30 ? `; and ${changed.length - 30} more` : ""}. Use these values if you rebuild it elsewhere.${notes.length ? ` ${notes.join(" ")}` : ""}`;
    } finally { op.progress?.({ type: "tool-end" }); }
  }
  /**
   * A goal, as one long answer: the model sets up the candidates (or a kept goal is picked up), then
   * generation after generation Kumi's search sets knobs and renders them all in one silent pass,
   * with the model's leaps in between. It ends at the target, at the safety cap, or on Esc (paused, kept
   * for /goal); either way the best is copied to a track of its own and the rig's scratch tracks go.
   */
  async function runGoal(op: Operation, text: string | undefined): Promise<TurnResult> {
    if (!integration?.goal) throw new KumiError("request", "Goals need Live connected, with the Ableton bridge 1.0.49 or later.");
    const where = () => currentProject ?? UNSAVED;
    let state = text ? undefined : goalState?.status === "paused" ? goalState : await options.goals?.load(where());
    if (!text && !state) throw new KumiError("request", "There's no goal to pick up. Say what to reach, such as: /goal make my pad sound like ~/ref.wav");
    if (!text && state?.status === "done") throw new KumiError("request", `That goal is done (${state.why ?? "finished"}). Start another with /goal and what to reach.`);
    op.extend?.(goalBudget.ms + 15 * 60_000);
    // A goal is at work the whole time (a rig opening after a leap reads every knob for minutes): the
    // answer's quiet timer doesn't apply. Its own safety cap bounds it.
    op.steady = true; op.progress?.({ type: "steady" });
    const usage = emptyUsage();
    let said = "";
    const ask = async (prompt: string) => {
      const snapshot = await observe(op, undefined, true); assertCurrent(op);
      op.phase = "inference"; said = "";
      const result = await kernel!.value.run(`${prompt}${OBSERVATION_MARKER}\n${snapshot.context}\n</current_observation_untrusted>`, op.controller.signal,
        (event) => { if (current(op)) { if (event.type === "text") said += event.text; op.progress?.(event); emit(event); } });
      for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += result.usage?.[key] ?? 0;
      return result;
    };
    const started = Date.now() - (state?.elapsedMs ?? 0);
    /** Full-length scores while generations are screened on a short window: what's reported, and what ends a goal. */
    const full = new Map<string, number>(); let screening = false; let lastConfirm = -1;
    const reportedLeader = (evolution?: Evolution) => {
      if (!evolution) return undefined;
      if (!screening || !full.size) return evolution.leader;
      const [name, score] = [...full].sort((a, b) => b[1] - a[1])[0]!;
      const slot = evolution.slots.find((item) => item.name === name);
      return slot ? { ...slot, score } : evolution.leader;
    };
    const status = (next: GoalStatus["state"], evolution?: Evolution) => {
      const leader = reportedLeader(evolution);
      goalStatusNow = { type: "goal", state: next, goal: state?.goal ?? text ?? "", generation: state?.generation ?? 0, rendered: state?.rendered ?? 0, trend: (state?.trend.slice(-60) ?? []).map(Math.round),
        ...(leader?.score !== undefined ? { best: { label: leader.label, score: Math.round(leader.score) }, leader: `${leader.label} · ${leader.chain}` } : {}),
        ...(state?.first !== undefined ? { first: Math.round(state.first) } : {}), ...(state?.idea ? { idea: state.idea } : {}), elapsedMs: Date.now() - started,
        candidates: evolution?.slots.length ?? state?.slots.length ?? 0, ...(state?.bestTrack ? { bestTrack: state.bestTrack } : {}), ...(state?.why ? { why: state.why } : {}) };
      emit(goalStatusNow);
    };
    const persist = () => { const kept = state; const store = options.goals; if (kept && store) saving = saving.then(() => store.save(where(), kept)).catch(() => {}); };
    status("starting");
    let request: AuditionRequest;
    if (!state) {
      heardLast = undefined;
      // What won in earlier matches and goals, first.
      const brief = playbookBrief(await playbookSerial((store) => store.list()) ?? [], text!);
      const setup = await ask(`${goalSetup(text!)}${brief ? `\n\n${brief}` : ""}`);
      if (setup.stopReason !== "completed" || op.controller.signal.aborted) return { ...setup, usage };
      const heard = heardLast as AuditionEvent | undefined;
      if (!heard?.request?.reference) {
        emit({ type: "notice", message: "The goal needs something to reach: give a reference (a file, or an audio clip in the Set) and try /goal again." });
        return { stopReason: "completed", usage };
      }
      request = heard.request;
      goalReference = heard.reference;
      state = { version: 1, goal: text!, request: { ...request, candidates: [] }, ...(request.candidates.some((candidate) => candidate.clip) ? { clips: true } : {}), slots: [], generation: 0, rendered: 0, trend: [], elapsedMs: 0, status: "running", ...(heard.best ? { first: heard.best.score } : {}) };
    } else {
      // Picked up again: its candidates by their tracks' names.
      request = { ...state.request, candidates: state.slots.map((slot) => ({ track: slot.name, label: slot.label, ...(state!.clips ? { clip: "first" } : {}) })) };
      state.status = "running";
    }
    goalOp = op;
    let rig = await integration.goal(request, op.controller.signal);
    if (typeof rig === "string") { emit({ type: "notice", message: `The goal couldn't start its search: ${rig}` }); state.status = "paused"; persist(); return { stopReason: "completed", usage }; }
    const evolution = new Evolution(options.goalRandom ?? Math.random);
    const knobKey = (knob: Pick<Knob, "device" | "name">) => `${knob.device}|${knob.name}`;
    const join = (slot: { name: string; label: string; chain: string; knobs: Knob[] }) => {
      const added = evolution.add(slot);
      const kept = state!.slots.find((item) => item.name === slot.name);
      if (kept) {
        // What the search had found for it, by knob.
        const values = new Map(kept.knobs.map((knob, index) => [knobKey(knob), kept.elite[index]!]));
        added.elite = added.knobs.map((knob, index) => values.get(knobKey(knob)) ?? added.elite[index]!);
        if (kept.score !== undefined) added.score = kept.score;
        added.sigma = kept.sigma; added.stale = kept.stale;
      }
    };
    for (const slot of rig.slots) join(slot);
    evolution.generation = state.generation; evolution.rendered = state.rendered; evolution.trend.push(...state.trend);
    const sync = () => {
      state!.slots = evolution.slots.map((slot) => ({ ...slot, knobs: slot.knobs.map((knob) => ({ ...knob })) }));
      state!.generation = evolution.generation; state!.rendered = evolution.rendered; state!.trend = evolution.trend.slice(-500);
      state!.elapsedMs = Date.now() - started;
    };
    let gaps: string[] = []; let lastLeap = evolution.generation;
    let silentRuns = 0;
    /** Whether the rig is open (it closes around the model's leaps), and what closing it said. */
    let open = true; const closedNotes: string[] = [];
    op.linger = 180_000;
    try {
      sync(); persist(); status("running", evolution);
      while (!op.controller.signal.aborted) {
        const reached = screening ? reportedLeader(evolution)?.score ?? 0 : evolution.best ?? 0;
        if (reached >= goalBudget.target) { state.status = "done"; state.why = `reached ${Math.round(reached)}%`; break; }
        // Screening a long part: every fourth generation the slots' best settings are heard at full length.
        screening = rig.screens;
        if (screening && evolution.generation > 0 && evolution.generation % 4 === 0 && lastConfirm !== evolution.generation) {
          lastConfirm = evolution.generation;
          const elites = evolution.slots.filter((slot) => slot.score !== undefined);
          const checked = await rig.generation(elites.map((slot) => ({ slot: slot.name, knobs: slot.knobs, values: slot.elite })), op.controller.signal, { screen: false });
          for (const [name, score] of checked.scores) full.set(name, score);
          evolution.rendered += checked.scores.size; sync();
          status("running", evolution);
          continue;
        }
        if (Date.now() - started >= goalBudget.ms) { state.status = "done"; state.why = "the safety cap on its time"; break; }
        const trials = evolution.propose();
        const slots = new Map(evolution.slots.map((slot) => [slot.name, slot]));
        const result = await rig.generation(trials.map((trial) => ({ slot: trial.slot, knobs: slots.get(trial.slot)!.knobs, values: trial.values, ...(trial.how === "recheck" ? { fresh: true } : {}) })), op.controller.signal, { screen: screening });
        const { improved } = evolution.scored(trials, result.scores);
        // Nothing heard twice running: the renders aren't reaching Kumi, and searching on is pointless.
        silentRuns = result.scores.size ? 0 : silentRuns + 1;
        if (silentRuns >= 2) { state.status = "paused"; state.why = "nothing came through the last renders; check the candidates play at that spot"; break; }
        // Knobs Live wouldn't set leave the search (after scoring, so each slot's best stays aligned with its knobs).
        for (const [slot, keys] of result.frozen) evolution.freeze(slot, keys);
        if (state.first === undefined && evolution.best !== undefined) state.first = evolution.best;
        const leader = evolution.leader;
        if (leader) gaps = result.gaps.get(leader.name) ?? gaps;
        // The best's values are kept with the goal each generation (a crash loses nothing); its track is made at
        // the end, since copying a track mid-search moves the render tracks, whose undo is tied to their place.
        void improved;
        sync(); persist(); status("running", evolution);
        op.progress?.({ type: "tool-end" });
        const stalled = evolution.stalledFor >= goalBudget.stallGenerations;
        // A gap no knob closes (a missing sub, say) is handed to the model at once: turning knobs won't reach it.
        const structural = leader ? result.structural.get(leader.name) : undefined;
        const since = evolution.generation - lastLeap;
        if (since >= goalBudget.leapEvery || (stalled && since >= goalBudget.stallGenerations) || (structural && since >= 2)) {
          lastLeap = evolution.generation;
          heardLast = undefined;
          // The model's new tracks go after the render tracks, and Live undoes tracks from the last one back:
          // the render tracks go first, and come back after, with the new candidates.
          const closing = await rig.close().catch(() => [] as string[]); open = false;
          closedNotes.push(...closing);
          // Main not put back: the goal stops rather than render on over a Main it can't restore.
          if (closing.some((note) => /Main may still be silent/.test(note))) { state.status = "paused"; state.why = "Main couldn't be put back; set it in Live, then /goal carries on"; break; }
          const leap = await ask(goalLeap(state, leader?.score !== undefined ? { label: leader.label, score: Math.round(leader.score) } : undefined, gaps.slice(0, 3), stalled, structural));
          if (leap.stopReason === "cancelled" || op.controller.signal.aborted) break;
          // What it tried: its "Tried:" line, or its first line.
          const idea = (/Tried:\s*(.+)/i.exec(said)?.[1] ?? said.trim().split(/\n+/).find(Boolean))?.replace(/[*_`]/g, "").trim().slice(0, 200);
          if (idea) state.idea = idea;
          const offered = (heardLast as AuditionEvent | undefined)?.request?.candidates ?? [];
          const reopened = await integration.goal({ ...request, candidates: [...evolution.slots.map((slot) => ({ track: slot.name, label: slot.label, ...(state!.clips ? { clip: "first" } : {}) })),
            ...offered.map((candidate) => ({ ...candidate, ...(state!.clips && !candidate.clip ? { clip: "first" } : {}) }))] }, op.controller.signal);
          if (typeof reopened === "string") { state.status = "paused"; state.why = `the search couldn't start again after the model's idea: ${reopened}`.slice(0, 200); break; }
          rig = reopened; open = true;
          for (const slot of rig.slots) if (!evolution.slots.some((item) => item.name === slot.name)) join(slot);
          sync(); persist(); status("running", evolution);
        }
      }
    } catch (error) {
      if (!op.controller.signal.aborted) { state.status = "paused"; state.why = error instanceof Error ? error.message.slice(0, 200) : "it stopped"; }
    } finally {
      const cleanup = AbortSignal.timeout(150_000);
      if (op.controller.signal.aborted) { state.status = goalStopped ? "done" : "paused"; state.why = goalStopped ? "stopped" : "paused"; }
      const leader = reportedLeader(evolution);
      // In this order, so nothing moves a track whose undo is tied to its place: the render tracks go; then
      // (done, not paused) the top two candidates stay muted for the producer to A/B and the rest go, newest
      // first; then the best is copied to a track of its own, so stopping at any moment leaves a result.
      const notes = [...closedNotes, ...(open ? await rig.close().catch(() => ["Kumi couldn't remove its render tracks; delete the “Kumi · render” tracks by hand."]) : [])];
      if (state.status === "done") notes.push(...await rig.tidy([...evolution.slots].filter((slot) => slot.score !== undefined).sort((a, b) => b.score! - a.score!).slice(0, 2).map((slot) => slot.name), cleanup).catch(() => [] as string[]));
      if (leader?.score !== undefined) {
        const kept = await rig.keepBest(leader.name, leader.knobs, leader.elite, cleanup).catch(() => "");
        if (kept && kept.startsWith("Kumi · Goal best")) state.bestTrack = kept;
      }
      sync(); persist(); status(state.status, evolution);
      const best = reportedLeader(evolution);
      goalOp = undefined; goalStopped = false;
      emit({ type: "notice", message: `Goal ${state.status === "paused" ? "paused" : "done"}: ${best?.score !== undefined ? `${state.first !== undefined && Math.round(state.first) !== Math.round(best.score) ? `${Math.round(state.first)}% → ` : ""}${Math.round(best.score)}% (${best.label})` : "no score yet"} · ${state.generation} generations · ${state.rendered} candidates${state.bestTrack ? ` · the best is on “${state.bestTrack}”${state.status === "done" ? " (say if you want it on one of your tracks)" : ""}` : ""}${state.status === "paused" ? " · /goal carries on" : ""}.${notes.length ? ` ${notes.join(" ")}` : ""}` });
      goalState = state;
      // The goal's lesson, for the next match or goal: kept (replacing this goal's earlier one) once it has a leader.
      const lesson = lessonFromGoal(state.goal, goalReference, best?.score !== undefined ? { label: best.label, chain: best.chain, score: best.score } : undefined, state.first, state.trend, Date.now());
      if (lesson) {
        const kept = { ...lesson, ...(state.lesson ? { id: state.lesson } : {}) };
        state.lesson = kept.id; persist();
        void playbookSerial(async (store) => { const lessons = await store.list(); await store.save([...lessons.filter((item) => item.id !== kept.id), kept]); emit({ type: "lesson", action: lessons.some((item) => item.id === kept.id) ? "updated" : "learned", id: kept.id, line: lessonLine(kept) }); });
      }
    }
    return { stopReason: op.controller.signal.aborted ? "cancelled" : "completed", usage };
  }
  function perform(isTurn: boolean, phase: Operation["phase"], work: (op: Operation) => Promise<TurnResult | undefined>, limitMs = timeoutMs, input?: string): Promise<void> {
    if (state === "closed") return Promise.reject(new Error("Session is closed"));
    if (active) return Promise.reject(new Error("Session is busy; cancel first"));
    const op: Operation = { id: ++nextOperation, controller: new AbortController(), done: Promise.resolve(), isTurn, phase, ...(input !== undefined ? { input } : {}) };
    active = op; setState("running");
    const startedAt = performance.now();
    let timedOut: "quiet" | "limit" | undefined;
    let workSettled = false;
    let settledResult: TurnResult | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => { setState("cancelling"); grace = setTimeout(() => rejectAborted(new Error("Operation cancelled")), graceMs + (op.linger ?? 0)); };
    op.controller.signal.addEventListener("abort", onAbort, { once: true });
    // A turn runs while it makes progress, up to its limit; anything else gets timeoutMs.
    const stop = (why: "quiet" | "limit") => { timedOut ??= why; op.controller.abort(); };
    let timeout = setTimeout(() => stop("quiet"), isTurn ? idleMs : limitMs);
    let limit = isTurn ? setTimeout(() => stop("limit"), turnLimitMs) : undefined;
    if (isTurn) op.extend = (ms) => { clearTimeout(limit); limit = setTimeout(() => stop("limit"), ms); };
    if (isTurn) {
      // While a tool works (a plan recording for minutes, a long listen) the answer is making
      // progress: the quiet timer waits for it to end. The turn's own limit still holds.
      let working = 0;
      op.progress = (event) => {
        if (op.controller.signal.aborted) return;
        if (event?.type === "tool-start") working++;
        if (event?.type === "tool-end") working = Math.max(0, working - 1);
        clearTimeout(timeout);
        if (working === 0 && !op.steady) timeout = setTimeout(() => stop("quiet"), idleMs);
      };
    }
    op.done = (async () => {
      try {
        const working = Promise.resolve().then(() => work(op)).finally(() => { workSettled = true; });
        const result = await Promise.race([working, aborted]);
        settledResult = result;
        if (op.controller.signal.aborted) throw new Error("Operation cancelled");
        if (isTurn && result) {
          if (result.stopReason === "cancelled") learned?.drafts.abandon(); else learned?.drafts.turnEnded();
          emit({ type: "turn-complete", result, elapsedMs: Math.round(performance.now() - startedAt) });
          if (result.stopReason !== "cancelled") saveConversation(true);
        }
      } catch (error) {
        if (op.controller.signal.aborted) {
          // A kernel that stopped when asked keeps its conversation, finished steps included; one
          // that didn't is set aside, and the next turn starts from the last settled conversation.
          if (!workSettled) {
            mustReset = true;
            try { await dropKernel(); } catch { emit({ type: "error", message: "Inference cleanup did not finish within its deadline." }); }
          }
          if (timedOut && isTurn) {
            emit({ type: "error", message: timedOut === "limit" ? `Kumi stopped: this answer had run for ${span(turnLimitMs)}. Anything it changed is in HISTORY; ask it to carry on.`
              : `Kumi stopped after ${span(idleMs)} without progress. Anything it changed is in HISTORY; ask it to carry on.` });
          } else if (timedOut) emit({ type: "error", message: `Kumi stopped waiting after ${span(limitMs)}.` });
          if (isTurn) {
            learned?.drafts.abandon();
            emit({ type: "turn-complete", result: { stopReason: "cancelled", ...(settledResult?.usage ? { usage: settledResult.usage } : {}) }, elapsedMs: Math.round(performance.now() - startedAt) });
            if (workSettled) saveConversation(true);
          }
        } else {
          // Sign-in, billing and model problems say so wherever they happen (building the model's
          // kernel is part of reading the Set), with where they happened, so the fix can be offered.
          const actionable = error instanceof KumiError && (error.kind === "auth" || error.kind === "billing" || error.kind === "model" || error.kind === "config" || error.kind === "live");
          const message = actionable ? error.message
            : op.phase === "undo" ? (error instanceof KumiError ? error.message : "The undo didn't finish; check Live.")
            : op.phase !== "inference" ? "Context refresh failed; no answer was generated from old observations."
            : error instanceof KumiError ? error.message : "Inference failed; check the configured model, sign-in and connection.";
          emit({ type: "error", message, ...(error instanceof KumiError ? { kind: error.kind, ...(error.provider ? { provider: error.provider } : {}) } : {}) });
          // A failed answer keeps the steps it finished (see the kernel); keep them for next time too.
          if (isTurn && op.phase === "inference") saveConversation(true);
          // Like a stopped one, a failed answer's draft goes: what it built may be half done. Left open, it would
          // take the next turns' changes as its build and never hear what the producer said.
          if (isTurn) learned?.drafts.abandon();
          if (!isTurn && phase === "start") {
            try { await dropResources(); } catch { /* startup remains failed */ }
            throw new Error("Could not start Kumi session; check model login and connection.");
          }
        }
      } finally {
        clearTimeout(timeout); clearTimeout(limit); clearTimeout(grace);
        op.controller.signal.removeEventListener("abort", onAbort);
        if (active === op) { active = undefined; setState("idle"); }
      }
    })();
    return op.done;
  }
  return {
    start() {
      if (started) return Promise.reject(new Error("Session already started"));
      return perform(false, "start", async (op) => { await reset(op); return undefined; });
    },
    submit(input, extra) {
      if (state === "closed") return Promise.reject(new Error("Session is closed"));
      if (active) return Promise.reject(new Error("Session is busy; cancel first"));
      if (!started) return Promise.reject(new Error("Session is not started"));
      if (!input.trim() || Buffer.byteLength(input) > 16 * 1024) return Promise.reject(new Error("Enter a nonempty prompt of at most 16 KiB"));
      if (maxTurns !== undefined && turns >= maxTurns) return Promise.reject(new Error("Conversation limit reached; use /new"));
      turns++;
      // A new request: the one Live's going away stopped isn't offered again.
      interrupted = undefined;
      return perform(true, "refresh", async (op) => {
        const snapshot = await observe(op, extra?.pinned); assertCurrent(op);
        // The Set as it is now (read first: a deleted build's gone), then the producer's words, may say
        // what they thought of the last build; and a new turn begins.
        learned?.drafts.said(input); learned?.drafts.turnStarted(input);
        // "Make it sound like this" starts a match run; "keep going" after one carries it on.
        const carried = options.match !== false && !startsMatch(input) && KEEP_GOING.test(input) && lastRun !== undefined;
        if (!carried) judgeLesson(input);
        const run = options.match === false ? undefined : startsMatch(input) ? new MatchRun(input, budget) : carried ? MatchRun.carryOn(lastRun!, budget) : undefined;
        matching = run;
        // A new run reads what won in earlier ones first.
        const brief = run && !carried ? playbookBrief(await playbookSerial((store) => store.list()) ?? [], input) : "";
        assertCurrent(op);
        op.phase = "inference";
        const ask = (text: string, observation: string) => kernel!.value.run(`${text}${OBSERVATION_MARKER}\n${observation}\n</current_observation_untrusted>`, op.controller.signal,
          (event) => { if (current(op)) { op.progress?.(event); emit(event); } });
        const result = await ask(brief ? `${input}\n\n${brief}` : input, snapshot.context);
        if (!run) return result;
        try { return await runMatch(op, run, result, ask); } finally { matching = undefined; lastRun = run; learnFrom(run, carried); }
      }, undefined, input);
    },
    refresh() {
      if (!started) return Promise.reject(new Error("Session is not started"));
      return perform(false, "refresh", async (op) => { await observe(op); return undefined; });
    },
    newConversation() {
      return perform(false, "refresh", async (op) => {
        // The conversation so far stays kept with its Set (/conversations goes back to it); the next
        // one starts empty, over the same bridge, so HISTORY's undo still works.
        await dropKernel(); assertCurrent(op);
        startFresh = true; turns = 0; mustReset = false; settled = undefined; interrupted = undefined;
        const store = options.conversations; const where = place;
        if (store && where) saving = saving.then(() => store.fresh(where)).catch(() => {});
        if (integration) await observe(op); else await reset(op);
        emit({ type: "notice", message: "New conversation. The last one is kept; /conversations goes back to it." });
        return undefined;
      });
    },
    reconnect() {
      return perform(false, "start", async (op) => {
        // A fresh bridge; the conversation carries over (unless a different saved Set is open by then).
        let checkpoint: KernelCheckpoint | undefined;
        try { checkpoint = kernel?.value.checkpoint?.(); } catch { checkpoint = undefined; }
        checkpoint ??= settled?.checkpoint;
        if (checkpoint) carry = { checkpoint, place };
        await reset(op);
        if (connection === "connected") emit({ type: "notice", message: "Reconnected to Live; the conversation carries on." });
        return undefined;
      });
    },
    async conversations() {
      const store = options.conversations;
      return store ? store.list(place ?? currentProject ?? UNSAVED).catch(() => []) : [];
    },
    async resumeConversation(id) {
      const store = options.conversations; const where = place ?? currentProject ?? UNSAVED;
      if (!store) return false;
      if (id === conversationId && where === place) return true;
      await saving;
      const conversation = await store.load(where, id);
      if (!conversation) return false;
      await perform(false, "refresh", async (op) => {
        // This conversation is kept already (after each settled turn); the chosen one carries on.
        await dropKernel(); assertCurrent(op);
        chosen = { place: where, id, conversation }; mustReset = false; turns = 0; interrupted = undefined;
        await observe(op);
        saveConversation(false);
        return undefined;
      });
      return true;
    },
    watch(event) {
      // A match run hears every audition, and every change after one makes it stale; a goal takes its candidates from one.
      if (event.type === "auditioned") { matching?.auditioned(event, event.request); heardLast = event; return; }
      if (event.type === "change" && event.change.state === "applied") matching?.changed();
      // What happens after a drafted technique's build says whether the producer liked it: playing it, say.
      if (event.type === "action") { if (event.playing === true) learned?.drafts.played(); return; }
      learned?.drafts.change(event.change);
      const record = lean(event.change);
      seen.set(record.id, record);
      if (seen.size > 500) seen.delete(seen.keys().next().value!);
      const index = conversationChanges.findIndex((change) => change.id === record.id);
      if (index >= 0) conversationChanges[index] = record;
      else { conversationChanges.push(record); if (conversationChanges.length > MAX_CHANGES) conversationChanges.shift(); }
    },
    async undo(id) {
      if (!started) throw new Error("Session is not started");
      let outcome: ChangeRecord | undefined;
      await perform(false, "undo", async (op) => {
        if (!integration?.undo) throw new KumiError("request", "There's nothing Kumi can undo here.");
        outcome = await integration.undo(id, op.controller.signal);
        return undefined;
      });
      return outcome;
    },
    async memory() {
      if (!options.memory) return undefined;
      const memory = await options.memory.load(currentProject);
      return { ...memory, ...(currentSetName ? { setName: currentSetName } : {}), saved: currentProject !== undefined };
    },
    async forget(id) { return notes?.forget(id); },
    async recipes() {
      if (!options.recipes) return [];
      return (await options.recipes.list()).map((recipe) => ({ name: recipe.name, about: recipe.about, params: recipe.params, steps: recipe.steps.length, used: recipe.used, created: recipe.created,
        ...(recipe.lastUsed ? { lastUsed: recipe.lastUsed } : {}) }));
    },
    async runRecipe(name) {
      if (!started) throw new Error("Session is not started");
      const run = recipes.find((tool) => tool.name === RUN_RECIPE_TOOL);
      if (!run) return { text: "Kumi keeps no recipes here.", isError: true };
      let outcome = { text: "", isError: true };
      // A fresh look at the Set first, as for an answer: the recipe's steps need current references.
      // A recipe may record or wait, so it has as long as an answer does.
      await perform(false, "refresh", async (op) => {
        await observe(op);
        const result = await run.execute({ name, with: {}, final: true }, op.controller.signal);
        outcome = { text: result.reply ?? result.text, isError: Boolean(result.isError) };
        return undefined;
      }, turnLimitMs);
      return outcome.text ? outcome : { text: "it didn't finish; anything it changed is in HISTORY.", isError: true };
    },
    async techniques() {
      return learned ? (await learned.list()).map((technique) => ({ id: technique.id, name: technique.name, fits: technique.fits, ...(technique.source?.title ? { source: technique.source.title } : {}) })).reverse() : [];
    },
    async forgetTechnique(id) { return Boolean(await learned?.forget(id)); },
    goal(text) {
      if (state === "closed") return Promise.reject(new Error("Session is closed"));
      if (active) return Promise.reject(new Error("Session is busy; cancel first"));
      if (!started) return Promise.reject(new Error("Session is not started"));
      const goal = text?.trim() || undefined;
      if (goal && Buffer.byteLength(goal) > 4 * 1024) return Promise.reject(new Error("Say the goal in at most 4 KiB"));
      turns++; interrupted = undefined;
      return perform(true, "refresh", async (op) => runGoal(op, goal), undefined, goal ? `/goal ${goal}` : "/goal");
    },
    async stopGoal() {
      if (goalOp && active === goalOp) { goalStopped = true; goalOp.controller.abort(); await goalOp.done; return true; }
      const place = currentProject ?? UNSAVED;
      const kept = goalState?.status === "paused" ? goalState : await options.goals?.load(place);
      if (!kept || kept.status === "done") return false;
      kept.status = "done"; kept.why = "stopped"; goalState = kept;
      const store = options.goals; if (store) await store.save(place, kept).catch(() => {});
      goalStatusNow = goalStatusNow ? { ...goalStatusNow, state: "done", why: "stopped" } : undefined;
      if (goalStatusNow) emit(goalStatusNow);
      return true;
    },
    goalStatus() { return goalStatusNow; },
    async lessons() {
      return ((await playbookSerial((store) => store.list())) ?? []).map((lesson) => ({ id: lesson.id, line: lessonLine(lesson), at: lesson.at })).reverse();
    },
    async forgetLesson(id) {
      return Boolean(await playbookSerial(async (store) => {
        const lessons = await store.list(); const gone = lessons.find((lesson) => lesson.id === id);
        if (!gone) return false;
        await store.save(lessons.filter((lesson) => lesson.id !== id));
        emit({ type: "lesson", action: "forgot", id, line: lessonLine(gone) });
        return true;
      }));
    },
    async forgetRecipe(name) {
      const recipe = await options.recipes?.get(name);
      if (!recipe || !await options.recipes!.remove(recipe.name)) return false;
      emit({ type: "recipe", action: "forgotten", name: recipe.name, steps: recipe.steps.length });
      return true;
    },
    async sessionStrip(trackRef, scene) {
      if (!integration?.sessionStrip || connection !== "connected") return undefined;
      return integration.sessionStrip(trackRef, scene, AbortSignal.timeout(10_000)).catch(() => undefined);
    },
    async arrangementStrip() {
      if (!integration?.arrangementStrip || connection !== "connected") return undefined;
      return integration.arrangementStrip(AbortSignal.timeout(10_000)).catch(() => undefined);
    },
    async clipView(slotRef) {
      if (!integration?.clipView || connection !== "connected") return undefined;
      return integration.clipView(slotRef, AbortSignal.timeout(10_000)).catch(() => undefined);
    },
    async deviceTree(trackRef) {
      if (!integration?.deviceTree || connection !== "connected") return undefined;
      return integration.deviceTree(trackRef, AbortSignal.timeout(10_000)).catch(() => undefined);
    },
    async stopLive() {
      if (!integration?.stopLive) return false;
      const stopped = await integration.stopLive(AbortSignal.timeout(options.timeoutMs ?? 30_000)).catch(() => false);
      if (stopped) emit({ type: "action", title: "Stopped", playing: false, recording: false });
      return stopped;
    },
    async cancel() { const op = active; if (!op) return; op.controller.abort(); await op.done; },
    async reconfigure() {
      if (state === "closed") throw new Error("Session is closed");
      // Not now: an answer may be running. The next turn or refresh rebuilds the kernel for the new
      // model and carries the settled conversation on.
      rebuild = true;
    },
    close() {
      if (closing) return closing;
      const op = active;
      state = "closed"; options.onEvent({ type: "state", state });
      op?.controller.abort();
      clearTimeout(missing);
      closing = (async () => {
        try { if (op) await boundedClose(op.done).catch(() => {}); }
        finally {
          // A technique the producer left in place is kept, and the last turn's save lands, before Kumi goes.
          await learned?.drafts.close().catch(() => {});
          await boundedClose(saving).catch(() => {});
          await dropResources();
        }
      })();
      return closing;
    },
    status(): SessionStatus { return { state, connection, turns, ...(maxTurns === undefined ? {} : { maxTurns }), ...(observationLabel === undefined ? {} : { observation: observationLabel }) }; },
  };
}
