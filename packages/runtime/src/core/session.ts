import type {
  ConnectionState, Integration, IntegrationFactory, Kernel, KernelCheckpoint, KernelFactory, Observation,
  SessionController, SessionEvent, SessionStatus, TurnResult, TurnState,
} from "./contracts.js";
import { KumiError } from "./errors.js";

interface Options {
  kernelFactory: KernelFactory;
  integrationFactory: IntegrationFactory;
  onEvent: (event: SessionEvent) => void;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  cancelGraceMs?: number;
  maxTurns?: number;
}
interface Operation {
  id: number;
  controller: AbortController;
  done: Promise<void>;
  isTurn: boolean;
  phase: "start" | "refresh" | "inference";
}

export function createSession(options: Options): SessionController {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  const graceMs = options.cancelGraceMs ?? 500;
  const maxTurns = options.maxTurns ?? 30;
  for (const value of [timeoutMs, closeTimeoutMs, graceMs, maxTurns]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid session bound");
  let state: TurnState = "idle";
  let connection: ConnectionState = "disconnected";
  let observationLabel: string | undefined;
  let integration: Integration | undefined;
  let integrationGeneration = 0;
  let kernel: { value: Kernel; key: string; revision: string; lifetime: AbortController } | undefined;
  let mustReset = false;
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
    connection = next; emit({ type: "connection", state: next });
    if (lost) {
      observationLabel = undefined; mustReset = true;
      emit({ type: "notice", message: "Connection lost; observations discarded. No Live access. Use /new to reconnect." });
      active?.controller.abort();
    }
  }
  async function ensureKernel(op: Operation, observation: Observation) {
    assertCurrent(op);
    const identityChanged = kernel !== undefined && kernel.key !== observation.key;
    const revision = observation.revision ?? "";
    let carried: KernelCheckpoint | undefined;
    if (kernel && !identityChanged && !mustReset && kernel.revision !== revision) {
      // Same Set, new tools (say, a first clip made clip tools appear): keep the conversation.
      if (kernel.value.checkpoint) carried = kernel.value.checkpoint();
      if (carried) { await dropKernel(); assertCurrent(op); }
    }
    if (kernel && (identityChanged || mustReset || kernel.revision !== revision)) {
      await dropKernel(); assertCurrent(op);
      emit({ type: "notice", message: identityChanged ? "The open Set changed; starting a fresh conversation."
        : mustReset ? "Cancelled work was discarded; starting a fresh conversation." : "Kumi's tools changed; starting a fresh conversation." });
      if (identityChanged) turns = op.isTurn ? 1 : 0;
    }
    if (!kernel) {
      if (mustReset) emit({ type: "notice", message: "Unsettled work was discarded; starting a fresh conversation." });
      const lifetime = new AbortController();
      const abortCreation = () => lifetime.abort();
      op.controller.signal.addEventListener("abort", abortCreation, { once: true });
      let value: Kernel | undefined;
      try {
        value = await options.kernelFactory({ instructions: observation.instructions, tools: observation.tools, signal: lifetime.signal, ...(carried ? { checkpoint: carried } : {}) });
        if (!current(op)) { lifetime.abort(); await boundedClose(value.close()); throw new Error("Operation cancelled"); }
        kernel = { value, key: observation.key, revision, lifetime };
      } catch (error) { lifetime.abort(); throw error; }
      finally { op.controller.signal.removeEventListener("abort", abortCreation); }
    }
    mustReset = false;
  }
  async function observe(op: Operation) {
    assertCurrent(op);
    if (!integration) throw new Error("Integration not started");
    op.phase = "refresh";
    observationLabel = undefined;
    const snapshot = await integration.observe(op.controller.signal);
    assertCurrent(op);
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
  function perform(isTurn: boolean, phase: Operation["phase"], work: (op: Operation) => Promise<TurnResult | undefined>): Promise<void> {
    if (state === "closed") return Promise.reject(new Error("Session is closed"));
    if (active) return Promise.reject(new Error("Session is busy; cancel first"));
    const op: Operation = { id: ++nextOperation, controller: new AbortController(), done: Promise.resolve(), isTurn, phase };
    active = op; setState("running");
    const startedAt = performance.now();
    let timedOut = false;
    let workSettled = false;
    let settledResult: TurnResult | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => { setState("cancelling"); grace = setTimeout(() => rejectAborted(new Error("Operation cancelled")), graceMs); };
    op.controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; op.controller.abort(); }, timeoutMs);
    op.done = (async () => {
      try {
        const working = Promise.resolve().then(() => work(op)).finally(() => { workSettled = true; });
        const result = await Promise.race([working, aborted]);
        settledResult = result;
        if (op.controller.signal.aborted) throw new Error("Operation cancelled");
        if (isTurn && result) emit({ type: "turn-complete", result, elapsedMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        if (op.controller.signal.aborted) {
          if (!workSettled || timedOut) {
            mustReset = true;
            try { await dropKernel(); } catch { emit({ type: "error", message: "Inference cleanup did not finish within its deadline." }); }
          }
          if (timedOut) emit({ type: "error", message: "Turn timed out; work cancelled and late output discarded." });
          if (isTurn) emit({ type: "turn-complete", result: { stopReason: "cancelled", ...(settledResult?.usage ? { usage: settledResult.usage } : {}) }, elapsedMs: Math.round(performance.now() - startedAt) });
        } else {
          const message = op.phase !== "inference" ? "Context refresh failed; no answer was generated from old observations."
            : error instanceof KumiError ? error.message : "Inference failed; check the configured model, sign-in and connection.";
          emit({ type: "error", message });
          if (!isTurn && phase === "start") {
            try { await dropResources(); } catch { /* startup remains failed */ }
            throw new Error("Could not start Kumi session; check model login and connection.");
          }
        }
      } finally {
        clearTimeout(timeout); clearTimeout(grace);
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
      if (turns >= maxTurns) return Promise.reject(new Error("Conversation limit reached; use /new"));
      turns++;
      return perform(true, "refresh", async (op) => {
        const snapshot = await observe(op); assertCurrent(op);
        op.phase = "inference";
        return kernel!.value.run(`${input}\n\n<current_observation_untrusted>\n${snapshot.context}\n</current_observation_untrusted>`, op.controller.signal,
          (event) => { if (current(op)) emit(event); });
      });
    },
    refresh() {
      if (!started) return Promise.reject(new Error("Session is not started"));
      return perform(false, "refresh", async (op) => { await observe(op); return undefined; });
    },
    newConversation() { return perform(false, "start", async (op) => { await reset(op); emit({ type: "notice", message: "New ephemeral conversation; previous history discarded." }); return undefined; }); },
    async cancel() { const op = active; if (!op) return; op.controller.abort(); await op.done; },
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
    status(): SessionStatus { return { state, connection, turns, maxTurns, ...(observationLabel === undefined ? {} : { observation: observationLabel }) }; },
  };
}
