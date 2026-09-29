import { randomBytes } from "node:crypto";
import type {
  ChangeRecord, ConnectionState, ConversationStore, DisconnectCause, Integration, IntegrationFactory, JsonObject, Kernel, KernelCheckpoint, KernelFactory, KernelTool, MemoryStore, Observation, SavedConversation,
  SessionController, SessionEvent, SessionStatus, ToolResult, TurnResult, TurnState,
} from "./contracts.js";
import { KumiError } from "./errors.js";
import { memoryInstructions, memoryTools } from "./memory.js";
import { recipeInstructions, recipeTools, RUN_RECIPE_TOOL, type RecipeStore } from "./recipes.js";
import { listeningTools } from "../audio/tools.js";
import { videoTools } from "../video/tool.js";
import { asksForTechnique, PLAN_TECHNIQUE, TECHNIQUE_GUIDANCE, TECHNIQUE_NUDGE, techniqueInstructions, techniqueTools, type TechniqueStore } from "./techniques.js";
import { GAP_GUIDANCE, gapTools } from "./gaps.js";
import { OBSERVATION_MARKER, transcriptOf } from "../kernel/budget.js";

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
}
/** Where an unsaved Set keeps its conversations until it's saved. */
const UNSAVED = "unsaved";
const newConversationId = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
/** HISTORY kept with a conversation: what it shows, without a clip's notes or where devices sit. */
const MAX_CHANGES = 100;
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
  async function observe(op: Operation) {
    assertCurrent(op);
    if (!integration) throw new Error("Integration not started");
    op.phase = "refresh";
    observationLabel = undefined;
    const snapshot = await integration.observe(op.controller.signal);
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
    const onAbort = () => { setState("cancelling"); grace = setTimeout(() => rejectAborted(new Error("Operation cancelled")), graceMs); };
    op.controller.signal.addEventListener("abort", onAbort, { once: true });
    // A turn runs while it makes progress, up to its limit; anything else gets timeoutMs.
    const stop = (why: "quiet" | "limit") => { timedOut ??= why; op.controller.abort(); };
    let timeout = setTimeout(() => stop("quiet"), isTurn ? idleMs : limitMs);
    const limit = isTurn ? setTimeout(() => stop("limit"), turnLimitMs) : undefined;
    if (isTurn) {
      // While a tool works (a plan recording for minutes, a long listen) the answer is making
      // progress: the quiet timer waits for it to end. The turn's own limit still holds.
      let working = 0;
      op.progress = (event) => {
        if (op.controller.signal.aborted) return;
        if (event?.type === "tool-start") working++;
        if (event?.type === "tool-end") working = Math.max(0, working - 1);
        clearTimeout(timeout);
        if (working === 0) timeout = setTimeout(() => stop("quiet"), idleMs);
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
    submit(input) {
      if (state === "closed") return Promise.reject(new Error("Session is closed"));
      if (active) return Promise.reject(new Error("Session is busy; cancel first"));
      if (!started) return Promise.reject(new Error("Session is not started"));
      if (!input.trim() || Buffer.byteLength(input) > 16 * 1024) return Promise.reject(new Error("Enter a nonempty prompt of at most 16 KiB"));
      if (maxTurns !== undefined && turns >= maxTurns) return Promise.reject(new Error("Conversation limit reached; use /new"));
      turns++;
      // A new request: the one Live's going away stopped isn't offered again.
      interrupted = undefined;
      return perform(true, "refresh", async (op) => {
        const snapshot = await observe(op); assertCurrent(op);
        // The Set as it is now (read first: a deleted build's gone), then the producer's words, may say
        // what they thought of the last build; and a new turn begins.
        learned?.drafts.said(input); learned?.drafts.turnStarted(input);
        op.phase = "inference";
        return kernel!.value.run(`${input}${OBSERVATION_MARKER}\n${snapshot.context}\n</current_observation_untrusted>`, op.controller.signal,
          (event) => { if (current(op)) { op.progress?.(event); emit(event); } });
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
    async forgetRecipe(name) {
      const recipe = await options.recipes?.get(name);
      if (!recipe || !await options.recipes!.remove(recipe.name)) return false;
      emit({ type: "recipe", action: "forgotten", name: recipe.name, steps: recipe.steps.length });
      return true;
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
