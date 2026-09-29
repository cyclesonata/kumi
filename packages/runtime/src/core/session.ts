import type {
  ChangeRecord, ConnectionState, ConversationStore, Integration, IntegrationFactory, Kernel, KernelCheckpoint, KernelFactory, KernelTool, MemoryStore, Observation, SavedConversation,
  SessionController, SessionEvent, SessionStatus, TurnResult, TurnState,
} from "./contracts.js";
import { KumiError } from "./errors.js";
import { memoryInstructions, memoryTools } from "./memory.js";
import { recipeInstructions, recipeTools, RUN_RECIPE_TOOL, type RecipeStore } from "./recipes.js";
import { listeningTools } from "../audio/tools.js";
import { OBSERVATION_MARKER } from "../kernel/budget.js";

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
  /** Keeps each saved Set's conversation between sessions; without it conversations end with Kumi. */
  conversations?: ConversationStore;
  /** What Kumi remembers about the producer and each saved Set; without it Kumi keeps no notes. */
  memory?: MemoryStore;
  /** Let the model hear audio files (reference tracks, samples, bounces). */
  listen?: boolean;
  /** The producer's saved recipes; without it none are offered. */
  recipes?: RecipeStore;
}
interface Operation {
  id: number;
  controller: AbortController;
  done: Promise<void>;
  isTurn: boolean;
  phase: "start" | "refresh" | "inference" | "undo";
  /** The turn moved on (text, a tool step): its no-progress timer starts over. */
  progress?: (event?: { type: string }) => void;
}
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
  /** The saved Set the conversation is about, when known. */
  let currentProject: string | undefined;
  /** The open Set's name, for /memory. */
  let currentSetName: string | undefined;
  // Notes are kept by the model's own calls; each write is quiet, so it costs no model reply.
  const notes = options.memory ? memoryTools({ store: options.memory, project: () => currentProject, onEvent: (event) => emit(event) }) : undefined;
  // Recipes run through the open Set's plan tool, with its checks, HISTORY and undo.
  let planTool: KernelTool | undefined;
  const recipes = options.recipes ? recipeTools({ store: options.recipes, plan: () => planTool, onEvent: (event) => emit(event) }) : [];
  // Files are found by path; the integration can also name something in the Set by its file.
  const listening = options.listen ? listeningTools({ onEvent: (event) => emit(event),
    resolve: (named, signal) => integration?.audioFile?.(named, signal) ?? Promise.resolve(undefined) }) : [];
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
  function connectionChanged(generation: number, next: ConnectionState) {
    if (generation !== integrationGeneration || state === "closed") return;
    const lost = connection === "connected" && (next === "disconnected" || next === "error");
    const back = away && next === "connected";
    connection = next; emit({ type: "connection", state: next });
    if (lost) {
      // Work in progress stops (it would act on a Live that's gone); a settled conversation stays.
      observationLabel = undefined; away = true;
      emit({ type: "notice", message: "Live disconnected. Kumi keeps the conversation and reconnects when Live is back; if it doesn't, use /new." });
      active?.controller.abort();
    } else if (back) {
      away = false;
      emit({ type: "notice", message: "Live is back." });
      // Read the Set again right away when nothing else is running.
      if (!active && started) void perform(false, "refresh", async (op) => { await observe(op); return undefined; }).catch(() => {});
    }
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
      // A saved Set's conversation carries on from its last settled turn.
      let resumed: SavedConversation | undefined;
      // A model change carries the conversation on (same Set only; a new Set starts its own).
      if (!carried && switched?.key === observation.key) carried = switched.checkpoint;
      switched = undefined;
      if (!carried && observation.project && options.conversations) {
        resumed = await options.conversations.load(observation.project.id).catch(() => undefined);
        assertCurrent(op);
      }
      const checkpoint = carried ?? resumed?.checkpoint;
      const lifetime = new AbortController();
      const abortCreation = () => lifetime.abort();
      op.controller.signal.addEventListener("abort", abortCreation, { once: true });
      let value: Kernel | undefined;
      try {
        // The notes go into the instructions once, when the conversation's kernel is built: they stay
        // in the prompt cache, and a note kept meanwhile is in the conversation already.
        const remembered = options.memory ? await options.memory.load(observation.project?.id).catch(() => undefined) : undefined;
        assertCurrent(op);
        const saved = options.recipes ? await options.recipes.list().catch(() => []) : [];
        assertCurrent(op);
        const extra = [remembered ? memoryInstructions(remembered, observation.project?.name) : "", recipeInstructions(saved)].filter(Boolean).join("\n\n");
        value = await options.kernelFactory({ instructions: extra ? `${observation.instructions}\n\n${extra}` : observation.instructions,
          tools: [...observation.tools, ...(notes?.tools ?? []), ...listening, ...recipes], signal: lifetime.signal, ...(checkpoint ? { checkpoint } : {}) });
        if (!current(op)) { lifetime.abort(); await boundedClose(value.close()); throw new Error("Operation cancelled"); }
        kernel = { value, key: observation.key, revision, lifetime };
      } catch (error) { lifetime.abort(); throw error; }
      finally { op.controller.signal.removeEventListener("abort", abortCreation); }
      const set = observation.project?.name ?? "this Set";
      if (reason === "set") emit({ type: "notice", message: resumed ? `The open Set changed; continuing your conversation about ${set}.` : "The open Set changed; starting a fresh conversation." });
      else if (reason === "cancelled") emit({ type: "notice", message: resumed ? "Cancelled work was discarded; the conversation continues from before it." : "Cancelled work was discarded; starting a fresh conversation." });
      else if (reason === "tools") emit({ type: "notice", message: resumed ? "Kumi's tools changed; the conversation continues." : "Kumi's tools changed; starting a fresh conversation." });
      // Show the earlier exchanges when this conversation isn't already on screen.
      if (resumed && (first || reason === "set")) emit({ type: "resumed", savedAt: resumed.savedAt, lines: value.transcript?.().slice(-20) ?? [] });
    }
    mustReset = false;
  }
  /** Keep the settled conversation for its saved Set; best effort, never in the way of the answer. */
  function saveConversation() {
    const held = kernel; const project = currentProject;
    if (!options.conversations || !held?.value.checkpoint || !project) return;
    try {
      const checkpoint = held.value.checkpoint();
      void options.conversations.save(project, { savedAt: Date.now(), checkpoint }).catch(() => {});
    } catch { /* the kernel was busy */ }
  }
  async function observe(op: Operation) {
    assertCurrent(op);
    if (!integration) throw new Error("Integration not started");
    op.phase = "refresh";
    observationLabel = undefined;
    const snapshot = await integration.observe(op.controller.signal);
    assertCurrent(op);
    currentProject = snapshot.project?.id; currentSetName = snapshot.project?.name;
    planTool = snapshot.tools.find((tool) => tool.name === "make_changes");
    // Notes about a Set made before its first save are kept now that it has a file.
    if (currentProject) void notes?.flush().catch(() => {});
    await ensureKernel(op, snapshot); assertCurrent(op);
    observationLabel = snapshot.label;
    emit({ type: "observation", label: snapshot.label });
    return snapshot;
  }
  async function reset(op: Operation) {
    op.phase = "start";
    await dropResources(); assertCurrent(op);
    turns = 0; mustReset = false;
    const generation = ++integrationGeneration;
    integration = options.integrationFactory((next) => connectionChanged(generation, next));
    await integration.start(op.controller.signal); assertCurrent(op);
    await observe(op); started = true;
  }
  function perform(isTurn: boolean, phase: Operation["phase"], work: (op: Operation) => Promise<TurnResult | undefined>, limitMs = timeoutMs): Promise<void> {
    if (state === "closed") return Promise.reject(new Error("Session is closed"));
    if (active) return Promise.reject(new Error("Session is busy; cancel first"));
    const op: Operation = { id: ++nextOperation, controller: new AbortController(), done: Promise.resolve(), isTurn, phase };
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
          emit({ type: "turn-complete", result, elapsedMs: Math.round(performance.now() - startedAt) });
          if (result.stopReason !== "cancelled") saveConversation();
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
            emit({ type: "turn-complete", result: { stopReason: "cancelled", ...(settledResult?.usage ? { usage: settledResult.usage } : {}) }, elapsedMs: Math.round(performance.now() - startedAt) });
            if (workSettled) saveConversation();
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
          if (isTurn && op.phase === "inference") saveConversation();
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
      return perform(true, "refresh", async (op) => {
        const snapshot = await observe(op); assertCurrent(op);
        op.phase = "inference";
        return kernel!.value.run(`${input}${OBSERVATION_MARKER}\n${snapshot.context}\n</current_observation_untrusted>`, op.controller.signal,
          (event) => { if (current(op)) { op.progress?.(event); emit(event); } });
      });
    },
    refresh() {
      if (!started) return Promise.reject(new Error("Session is not started"));
      return perform(false, "refresh", async (op) => { await observe(op); return undefined; });
    },
    newConversation() {
      return perform(false, "start", async (op) => {
        // A fresh start means the saved Set's conversation is gone too.
        if (currentProject && options.conversations) await options.conversations.clear(currentProject).catch(() => {});
        await reset(op);
        emit({ type: "notice", message: "New conversation; the previous one is discarded." });
        return undefined;
      });
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
      closing = (async () => {
        try { if (op) await boundedClose(op.done).catch(() => {}); }
        finally { await dropResources(); }
      })();
      return closing;
    },
    status(): SessionStatus { return { state, connection, turns, ...(maxTurns === undefined ? {} : { maxTurns }), ...(observationLabel === undefined ? {} : { observation: observationLabel }) }; },
  };
}
