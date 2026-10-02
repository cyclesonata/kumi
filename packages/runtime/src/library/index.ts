/**
 * The producer's library, as Kumi knows it: every sound, preset and Set they own, learned in the
 * background (a process of its own, at low priority, holding while Live plays), kept in
 * ~/.kumi/library, and searched in memory. It also learns how they work from their own Sets, and
 * reads Live's manual when asked. It starts by itself, says one quiet line the first time, and
 * otherwise stays out of the way.
 */
import { fork, type ChildProcess } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { KernelTool, LibraryStatus, SessionEvent } from "../core/contracts.js";
import type { WebClient } from "../web/net.js";
import { learn, libraryLogs, LOG_VERSION, type LearnProgress, type PresetEntry, type SetEntry, type SoundEntry } from "./learn.js";
import { planLearning, rememberedFile, rememberedFolders, type PlanOptions } from "./plan.js";
import { manualTool } from "./manual.js";
import { SoundIndex } from "./search.js";
import { librarySources, type Source, type SourceOptions } from "./sources.js";
import { acquireLock, readState, writeState, type LibraryState } from "./state.js";
import { LogReader, readJson, writeJson } from "./store.js";
import { tasteInstructions, type Taste, type TasteLine } from "./taste.js";
import { libraryTools, type LearningState } from "./tools.js";

export { CLASSES, type SoundClass, type SoundKind } from "./classify.js";
export { FIND_PRESETS_TOOL, FIND_SOUNDS_TOOL, MY_SETS_TOOL } from "./tools.js";
export { MANUAL_TOOL } from "./manual.js";
export { librarySources, type Source } from "./sources.js";
export { readState, type LibraryState } from "./state.js";
export type { LearnProgress } from "./learn.js";
export type { TasteLine } from "./taste.js";

export interface LibraryOptions {
  /** Where the library is kept: ~/.kumi/library, or KUMI_LIBRARY_DIR. */
  dir: string;
  /** Folders the producer listed (settings.json's libraryFolders). */
  folders?: readonly string[];
  /** Kumi's own record of the Sets it has seen, which knows where they are. */
  projectsDir?: string;
  /** For tests: the home folder and platform sources are found from. */
  sources?: SourceOptions;
  /** Learn in a process of its own (true), or here (tests). */
  fork?: boolean;
  /** Threads measuring sounds while learning; 0 measures on the learner's own (tests). */
  workers?: number;
  /** How long after Kumi starts learning begins, and how often it looks again. */
  delayMs?: number;
  everyMs?: number;
  /** Look for Sets in Live's logs and Kumi's projects, and in ~/Music (false in tests). */
  findSets?: boolean;
  /** For the manual: how Kumi reads the web (tests give their own), and the manual's address. */
  web?: { client: WebClient; base?: string };
}

export interface Library {
  /** Learn in the background now, and look again now and then. */
  start(): void;
  /** Hold learning (Live is playing), and carry on. */
  pause(): void;
  resume(): void;
  status(): LibraryStatus;
  onStatus(listener: (status: LibraryStatus) => void): () => void;
  /** find_sounds, find_presets, my_sets and live_manual. `resolve` names a clip in the Set by its file. */
  tools(options: { resolve?: (named: string, signal: AbortSignal) => Promise<string | undefined>; onEvent?: (event: SessionEvent) => void }): KernelTool[];
  /** The producer's habits from their Sets, for the model's instructions ("" when none). */
  instructions(): Promise<string>;
  taste(): Promise<TasteLine[]>;
  forgetTaste(id: string): Promise<boolean>;
  /** Learn now, here, and say how it goes (kumi library); undefined when another Kumi is learning. */
  learnNow(options: { rebuild?: boolean; signal: AbortSignal; onProgress?: (progress: LearnProgress) => void }): Promise<LearnProgress | undefined>;
  /** Where it looks, as it stands now. */
  sources(): Source[];
  close(): Promise<void>;
}

export function createLibrary(options: LibraryOptions): Library {
  const dir = resolve(options.dir);
  const readers = { sounds: new LogReader<SoundEntry>(join(dir, "sounds.jsonl"), "sounds", LOG_VERSION), presets: new LogReader<PresetEntry>(join(dir, "presets.jsonl"), "presets", LOG_VERSION),
    sets: new LogReader<SetEntry>(join(dir, "sets.jsonl"), "sets", LOG_VERSION) };
  const listeners = new Set<(status: LibraryStatus) => void>();
  let learner: ChildProcess | undefined;
  let inProcess: AbortController | undefined;
  let progress: LearnProgress | undefined;
  let saved: LibraryState | undefined;
  let paused = false; let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastTold = 0; let toldTimer: ReturnType<typeof setTimeout> | undefined;
  let held: { index: SoundIndex; key: string; at: number } | undefined;
  /** Sounds were added since the index was built. */
  let stale = false;
  let sourceCache: { at: number; sources: Source[] } | undefined;
  let remembered: string[] | undefined;
  void readState(dir).then((state) => { saved = state; notify(); }, () => {});

  const forgottenFile = join(dir, "forgotten.json");
  const remembering = async () => (remembered ??= await rememberedFolders(dir));
  const planning: PlanOptions = { dir, ...(options.folders ? { folders: options.folders } : {}), ...(options.projectsDir ? { projectsDir: options.projectsDir } : {}),
    ...(options.sources ? { sources: options.sources } : {}), ...(options.findSets === false ? { findSets: false } : {}), ...(options.workers !== undefined ? { workers: options.workers } : {}) };
  function sources(): Source[] {
    // Live's preferences are read at most once a minute.
    if (sourceCache && Date.now() - sourceCache.at < 60_000) return sourceCache.sources;
    const list = librarySources({ ...options.sources, folders: [...(options.folders ?? []), ...(remembered ?? [])] });
    sourceCache = { at: Date.now(), sources: list };
    return list;
  }
  function status(): LibraryStatus {
    const learnedAt = saved?.last?.finishedAt;
    const counts = progress ? { sounds: progress.sounds.known, presets: progress.presets.known, sets: progress.sets.known }
      : { sounds: Math.max(readers.sounds.entries.size, saved?.last?.sounds ?? 0), presets: Math.max(readers.presets.entries.size, saved?.last?.presets ?? 0), sets: Math.max(readers.sets.entries.size, saved?.last?.sets ?? 0) };
    if (progress && progress.phase !== "done") return { state: paused ? "paused" : "learning", ...counts, todo: progress.sounds.todo, done: progress.sounds.done, ...(learnedAt ? { learnedAt } : {}) };
    return { state: learnedAt ? "ready" : "new", ...counts, ...(learnedAt ? { learnedAt } : {}) };
  }
  /** Listeners hear at most a few times a second, and always the last word. */
  function notify() {
    clearTimeout(toldTimer);
    const wait = 400 - (Date.now() - lastTold);
    const tellNow = () => { lastTold = Date.now(); const now = status(); for (const listener of listeners) { try { listener(now); } catch { /* a listener's trouble isn't learning's */ } } };
    if (wait <= 0) tellNow(); else { toldTimer = setTimeout(tellNow, wait); toldTimer.unref?.(); }
  }
  const finished = async () => {
    saved = await readState(dir).catch(() => saved);
    progress = undefined; held = undefined;
    notify();
    // Look again in a while: new downloads, new Sets.
    if (!closed) { clearTimeout(timer); timer = setTimeout(() => start(), options.everyMs ?? 30 * 60_000); timer.unref?.(); }
  };
  function start(): void {
    if (closed || learner || inProcess) return;
    clearTimeout(timer);
    sourceCache = undefined;
    progress = { phase: "looking", sounds: { known: status().sounds, todo: 0, done: 0 }, presets: { known: status().presets, todo: 0, done: 0 }, sets: { known: status().sets, todo: 0, done: 0 }, failed: 0, startedAt: Date.now() };
    notify();
    if (options.fork === false) { void learnHere({ signal: new AbortController().signal }).then(finished, finished); return; }
    // The learner works out what to look through itself, off Kumi's main thread.
    const child = fork(fileURLToPath(new URL("./learner.js", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], serialization: "json" });
    learner = child;
    child.on("message", (message: { type: string; progress?: LearnProgress }) => {
      if (message.type === "progress" && message.progress) { progress = message.progress; notify(); }
      if (message.type === "done" && message.progress) progress = message.progress;
    });
    // However it ends (done, stopped, or never started), Kumi looks again later.
    child.on("exit", () => { if (learner === child) { learner = undefined; void finished(); } });
    child.on("error", () => { if (learner === child) { learner = undefined; void finished(); } });
    tell(child, { type: "learn", options: { ...planning, paused } });
  }
  /** A word to the learner; one that has gone hears nothing. */
  function tell(child: ChildProcess | undefined, message: object) { try { child?.send(message); } catch { /* it's ending: its exit says so */ } }
  /** Learning in this process, with the same lock as the learner's. */
  async function learnHere(run: { rebuild?: boolean; signal: AbortSignal; onProgress?: (progress: LearnProgress) => void }): Promise<LearnProgress | undefined> {
    const release = await acquireLock(dir);
    if (!release) return undefined;
    const controller = new AbortController();
    inProcess = controller;
    const signal = AbortSignal.any([controller.signal, run.signal]);
    let latest: LearnProgress | undefined;
    try {
      const result = await learn({ ...await planLearning(planning), ...(run.rebuild ? { rebuild: true } : {}), signal,
        gate: () => (paused ? new Promise<void>((resolve) => { const check = setInterval(() => { if (!paused || signal.aborted) { clearInterval(check); resolve(); } }, 200); }) : Promise.resolve()),
        onProgress: (value) => { latest = value; progress = value; notify(); run.onProgress?.(value); } });
      await writeState(dir, result);
      saved = await readState(dir).catch(() => saved);
      return result;
    } catch (error) {
      if (latest) await writeState(dir, latest, true).catch(() => {});
      throw error;
    } finally { inProcess = undefined; progress = undefined; held = undefined; await release(); notify(); }
  }
  async function soundIndex(): Promise<SoundIndex> {
    await remembering();
    if ((await readers.sounds.refresh()).changed) stale = true;
    const current = sources();
    const key = current.map((source) => source.path).join("\n");
    // While learning, the sounds grow by the second: searches use what's built until it's a few seconds old.
    if (!held || held.key !== key || (stale && (progress === undefined || Date.now() - held.at >= 3_000))) {
      held = { index: await SoundIndex.build(readers.sounds.entries.values(), current), key, at: Date.now() };
      stale = false;
    }
    return held.index;
  }
  const learning = (): LearningState => {
    const now = status();
    return { learning: now.state === "learning" || now.state === "paused", first: !now.learnedAt, sounds: now.sounds, ...(now.todo !== undefined ? { todo: now.todo, done: now.done ?? 0 } : {}) };
  };
  async function readTaste(): Promise<{ taste: Taste | undefined; forgotten: Set<string> }> {
    const taste = await readJson<Taste>(join(dir, "taste.json"));
    const forgotten = new Set(((await readJson<string[]>(forgottenFile)) ?? []).filter((id) => typeof id === "string"));
    return { taste: taste && Array.isArray(taste.lines) ? taste : undefined, forgotten };
  }
  /** Measure one file off Kumi's main thread, as the library would. */
  function measure(path: string, part: { start?: number; seconds?: number; signal: AbortSignal }): Promise<SoundEntry> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./measure-worker.js", import.meta.url));
      const stop = () => { void worker.terminate(); reject(part.signal.reason ?? new Error("Listening was stopped.")); };
      part.signal.addEventListener("abort", stop, { once: true });
      worker.once("message", (message: { entry: SoundEntry }) => { part.signal.removeEventListener("abort", stop); void worker.terminate(); resolve(message.entry); });
      worker.once("error", (error) => { part.signal.removeEventListener("abort", stop); reject(error); });
      worker.postMessage({ id: 0, path, relative: path.split(/[\\/]/).at(-1)!, size: 0, mtime: 0, ...(part.start !== undefined ? { start: part.start } : {}), ...(part.seconds !== undefined ? { seconds: part.seconds } : {}) });
    });
  }

  return {
    start() {
      if (closed) return;
      clearTimeout(timer);
      // Learning starts a moment after Kumi does; what's learned already is read meanwhile, so the first search is quick.
      timer = setTimeout(() => { start(); void soundIndex().catch(() => {}); }, options.delayMs ?? 4_000);
      timer.unref?.();
    },
    pause() { if (paused) return; paused = true; tell(learner, { type: "pause" }); notify(); },
    resume() { if (!paused) return; paused = false; tell(learner, { type: "resume" }); notify(); },
    status,
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    tools(tools) {
      const access = {
        sounds: soundIndex,
        presets: async () => { await readers.presets.refresh(); return readers.presets.entries.values(); },
        sets: async () => { await readers.sets.refresh(); return readers.sets.entries.values(); },
        learning,
        remember(folders: readonly string[]) {
          void remembering().then(async (known) => {
            const added = folders.filter((folder) => !known.includes(folder) && !sources().some((source) => folder === source.path || folder.startsWith(`${source.path}${sep}`)));
            if (!added.length) return;
            remembered = [...known, ...added].slice(-32);
            await writeJson(rememberedFile(dir), remembered);
            sourceCache = undefined;
            start();
          }).catch(() => {});
        },
        measure,
        folders: () => sources().map((source) => source.path),
      };
      return [...libraryTools(access, tools), manualTool({ dir, ...(options.web ? { client: options.web.client, ...(options.web.base ? { base: options.web.base } : {}) } : {}), ...(tools.onEvent ? { onEvent: tools.onEvent } : {}) })];
    },
    async instructions() {
      const { taste, forgotten } = await readTaste();
      return taste ? tasteInstructions(taste, forgotten) : "";
    },
    async taste() {
      const { taste, forgotten } = await readTaste();
      return (taste?.lines ?? []).filter((line) => !forgotten.has(line.id));
    },
    async forgetTaste(id) {
      const { taste, forgotten } = await readTaste();
      if (!taste?.lines.some((line) => line.id === id) || forgotten.has(id)) return false;
      await writeJson(forgottenFile, [...forgotten, id]);
      return true;
    },
    learnNow: (run) => learnHere(run),
    sources,
    async close() {
      closed = true; clearTimeout(timer); clearTimeout(toldTimer); listeners.clear();
      inProcess?.abort();
      const child = learner;
      if (child) {
        // It stops between files, keeping what it learned; one that doesn't is ended.
        tell(child, { type: "stop" });
        await new Promise<void>((resolve) => { const kill = setTimeout(() => { child.kill(); resolve(); }, 1_500); kill.unref?.(); child.once("exit", () => { clearTimeout(kill); resolve(); }); });
      }
    },
  };
}

/** Where the library is, from Kumi's folder (KUMI_LIBRARY_DIR overrides). */
export const libraryDir = (kumiDir: string, env: Readonly<Record<string, string | undefined>> = process.env) => env.KUMI_LIBRARY_DIR || join(kumiDir, "library");
export { libraryLogs };
