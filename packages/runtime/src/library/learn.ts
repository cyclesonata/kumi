/**
 * Learning the library: find every sound, preset and Set in the producer's folders and learn the
 * ones that are new or changed since last time (a file is the same while its size and time are).
 * Presets and Sets come first, since they're quick and say most about how the producer works; then
 * sounds, the producer's own folders before packs. What's learned is written as it's learned, so
 * stopping loses nothing, and pausing holds between files.
 */
import { existsSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { SAMPLE_EXTENSIONS } from "../integrations/ableton/samples.js";
import { classify, nameHints, type SoundClass, type SoundKind } from "./classify.js";
import { FEATURES_VERSION, measureSound } from "./features.js";
import { PRESET_EXTENSIONS, pluginPresetFacts, readLivePreset, readMaxDevice, type PresetCategory } from "./presets.js";
import { readSet, type SetSummary } from "./sets.js";
import { browserPath, type Source } from "./sources.js";
import { Log, packVector, writeJson, type Entry } from "./store.js";
import { buildTaste } from "./taste.js";

export interface SoundEntry extends Entry {
  seconds?: number;
  kind?: SoundKind;
  class?: SoundClass;
  classFrom?: "name" | "folder" | "sound";
  bpm?: number;
  key?: string;
  note?: string;
  loudness?: number;
  peak?: number;
  brightness?: number;
  flatness?: number;
  attack?: number;
  decay?: number;
  width?: number;
  onsets?: number;
  low?: number;
  high?: number;
  /** The sound's vector (base64 Float32), at `features`' version. */
  vector?: string;
  features?: number;
  /** Room for a learned embedding beside the measured vector, and the model that made it. */
  embedding?: string;
  embeddingModel?: string;
  /** Why it couldn't be measured; it's still found by name. */
  error?: string;
}

export interface PresetEntry extends Entry {
  name: string;
  /** "adv", "adg", "amxd", "vstpreset"… */
  format: string;
  device?: string;
  category?: PresetCategory;
  inside?: string[];
  about?: string;
  /** Where it came from: "User Library", a pack's name, "Core Library", "Plug-in presets". */
  source: string;
  /** Its folder within that ("Presets/Instruments/Wavetable"). */
  folder: string;
  /** Its path in Live's Browser, for load_device. */
  browser?: string;
  error?: string;
}

export interface SetEntry extends Entry { set?: SetSummary; error?: string }

export const LOG_VERSION = 1;
/** The library's logs in `dir`. */
export function libraryLogs(dir: string) {
  return {
    sounds: new Log<SoundEntry>(join(dir, "sounds.jsonl"), "sounds", LOG_VERSION),
    presets: new Log<PresetEntry>(join(dir, "presets.jsonl"), "presets", LOG_VERSION),
    sets: new Log<SetEntry>(join(dir, "sets.jsonl"), "sets", LOG_VERSION),
  };
}

/** Formats Live loads that need a converter to read: one this long is known by its name only. */
const CONVERTED_MAX_BYTES = 60 * 1024 * 1024;
const DIRECT = new Set([".wav", ".wave", ".aif", ".aiff"]);

/** Learn one sound: measure it, and say what it is from its name and how it sounds. */
export async function learnSound(path: string, relativePath: string, size: number, mtime: number, part: { start?: number; seconds?: number } = {}): Promise<SoundEntry> {
  const hints = nameHints(relativePath);
  const base: SoundEntry = { path, size, mtime };
  if (!DIRECT.has(extname(path).toLowerCase()) && size > CONVERTED_MAX_BYTES) {
    return { ...base, ...(hints.class ? { class: hints.class, classFrom: hints.classFrom! } : {}), ...(hints.kind ? { kind: hints.kind } : {}), error: "too long to measure" };
  }
  const heard = await measureSound(path, part);
  const found = classify(hints, { seconds: heard.seconds, centroidHz: heard.centroidHz, flatness: heard.flatness, attackMs: heard.attackMs, decayMs: heard.decayMs,
    onsetsPerSecond: heard.onsetsPerSecond, lowShare: heard.lowShare, highShare: heard.highShare,
    ...(heard.pitch ? { pitch: heard.pitch } : {}), ...(heard.rhythm ? { rhythmBpm: heard.rhythm.bpm, rhythmConfidence: heard.rhythm.confidence } : {}), ...(heard.key ? { key: heard.key } : {}) });
  return { ...base, seconds: heard.seconds, kind: found.kind, ...(found.class ? { class: found.class, classFrom: found.classFrom! } : {}),
    ...(found.bpm ? { bpm: found.bpm } : {}), ...(found.key ? { key: found.key } : {}), ...(found.note ? { note: found.note } : {}),
    loudness: heard.loudnessDb, peak: heard.peakDb, brightness: heard.centroidHz, flatness: heard.flatness, attack: heard.attackMs, decay: heard.decayMs,
    width: heard.width, onsets: heard.onsetsPerSecond, low: heard.lowShare, high: heard.highShare, vector: packVector(heard.vector), features: FEATURES_VERSION };
}

export interface Counts { known: number; todo: number; done: number }
export interface LearnProgress {
  phase: "looking" | "presets" | "sets" | "sounds" | "tidying" | "done";
  sounds: Counts; presets: Counts; sets: Counts;
  /** Files that couldn't be read this run. */
  failed: number;
  startedAt: number;
  finishedAt?: number;
  /** What's being learned: a source's name. */
  at?: string;
}

export interface LearnOptions {
  dir: string;
  sources: readonly Source[];
  /** More places to look for Sets (folders), and Sets known by path (Live's recent ones, Kumi's). */
  setFolders?: readonly string[];
  setFiles?: readonly string[];
  /** Plug-ins' preset folders. */
  pluginPresets?: readonly string[];
  /** Start afresh: forget everything learned. */
  rebuild?: boolean;
  signal: AbortSignal;
  /** Threads measuring sounds; 0 measures on this one (tests). */
  workers?: number;
  /** Resolves when learning may go on (it waits here while paused). */
  gate?: () => Promise<void>;
  onProgress?: (progress: LearnProgress) => void;
}

interface Found { path: string; size: number; mtime: number; source: Source; relative: string }
/** What looking found, each file once however many folders lead to it. */
interface Finds { sounds: Found[]; presets: Found[]; sets: Found[]; seen: Set<string> }
/** Folders that never hold the producer's sounds: Live's own metadata, backups, project copies. */
const SKIP = new Set(["ableton folder info", "ableton project info", "__macosx", "node_modules", "$recycle.bin", "system volume information", "defaults"]);
const PROJECT_COPIES = new Set(["recorded", "processed", "imported", "freeze", "consolidated"]);
const backupSet = (path: string) => /\.backup-|\[\d{4}-\d{2}-\d{2} \d{6}\]\.als$/i.test(path);
const MAX_DEPTH = 16;

/** Every sound, preset and Set under a folder (links aren't followed: they could lead out, or round). */
async function walk(source: Source, kinds: { sounds: boolean; presets: boolean; sets: boolean }, found: Finds, signal: AbortSignal, depthLimit = MAX_DEPTH, skip: ReadonlySet<string> = new Set()): Promise<boolean> {
  const queue: { path: string; depth: number }[] = [{ path: source.path, depth: 0 }];
  let complete = true;
  while (queue.length) {
    signal.throwIfAborted();
    const { path, depth } = queue.pop()!;
    let entries: Awaited<ReturnType<typeof opendir>>;
    try { entries = await opendir(path); } catch { if (depth === 0) return false; continue; }
    const parent = basename(path).toLowerCase();
    for await (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(path, entry.name);
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (SKIP.has(lower) || lower === "backup" || lower.endsWith(".app") || (parent === "samples" && PROJECT_COPIES.has(lower)) || skip.has(full)) continue;
        if (depth + 1 > depthLimit) { complete = false; continue; }
        queue.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(lower);
      // A Set's backup copies ("Song.backup-2026-…als") aren't more of the producer's work.
      if (extension === ".als" && backupSet(lower)) continue;
      const list = kinds.sounds && SAMPLE_EXTENSIONS.has(extension) ? found.sounds : kinds.presets && PRESET_EXTENSIONS.has(extension) ? found.presets : kinds.sets && extension === ".als" ? found.sets : undefined;
      if (!list || found.seen.has(full)) continue;
      found.seen.add(full);
      try {
        const info = await stat(full);
        if (info.size < 64) continue;
        list.push({ path: full, size: info.size, mtime: Math.round(info.mtimeMs), source, relative: relative(source.path, full) });
      } catch { /* gone meanwhile */ }
    }
  }
  return complete;
}

const ORDER: Record<Source["kind"], number> = { "user-library": 0, place: 1, folder: 2, splice: 3, pack: 4, core: 5 };
const changed = (known: Entry | undefined, file: Found) => !known || known.size !== file.size || known.mtime !== file.mtime;

/** A small pool of threads measuring sounds; with none, sounds are measured here. A thread that fails or hangs is replaced. */
class Pool {
  private readonly workers: (Worker | undefined)[] = [];
  private readonly waiting = new Map<number, { slot: number; file: Found; resolve: (entry: SoundEntry) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  constructor(readonly size: number, private readonly timeoutMs = 90_000) {}
  private worker(slot: number): Worker {
    const held = this.workers[slot];
    if (held) return held;
    const worker = new Worker(new URL("./measure-worker.js", import.meta.url));
    worker.on("message", (message: { id: number; entry: SoundEntry }) => this.settle(message.id, message.entry));
    // A thread that dies takes its file with it: that file is noted as unreadable, and the slot gets a new thread.
    const lost = () => {
      if (this.workers[slot] === worker) this.workers[slot] = undefined;
      for (const [id, job] of this.waiting) if (job.slot === slot) this.settle(id, failed(job.file, "Kumi couldn't read it"));
    };
    worker.on("error", lost); worker.on("exit", lost);
    this.workers[slot] = worker;
    return worker;
  }
  private settle(id: number, entry: SoundEntry) {
    const job = this.waiting.get(id);
    if (!job) return;
    clearTimeout(job.timer); this.waiting.delete(id); job.resolve(entry);
  }
  run(slot: number, file: Found): Promise<SoundEntry> {
    if (!this.size) return learnSound(file.path, file.relative, file.size, file.mtime).catch((error: unknown) => failed(file, error instanceof Error ? error.message : "unreadable"));
    const id = this.nextId++;
    const worker = this.worker(slot % this.size);
    return new Promise((resolve) => {
      // A file that takes far too long (a broken one a converter chews on) is given up on, with its thread.
      const timer = setTimeout(() => { this.settle(id, failed(file, "it took too long to read")); void worker.terminate(); }, this.timeoutMs);
      timer.unref();
      this.waiting.set(id, { slot: slot % this.size, file, resolve, timer });
      worker.postMessage({ id, path: file.path, relative: file.relative, size: file.size, mtime: file.mtime });
    });
  }
  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker?.terminate()));
  }
}
const failed = (file: Found, why: string): SoundEntry => ({ path: file.path, size: file.size, mtime: file.mtime, error: why.slice(0, 160) });

/**
 * Appends go one at a time, in batches, so a log's lines never interleave. One that fails (a full
 * disk) loses only its batch: those files aren't in the log, so the next run learns them again.
 */
function writer<T extends Entry>(log: Log<T>) {
  let batch: (T | Entry)[] = []; let last = Date.now(); let chain: Promise<void> = Promise.resolve();
  const flush = () => { const lines = batch; batch = []; last = Date.now(); chain = chain.then(() => log.append(lines).catch(() => {})); return chain; };
  return {
    add(entry: T | Entry) { batch.push(entry); if (batch.length >= 100 || Date.now() - last > 2_000) void flush(); },
    flush,
  };
}

/** The newest Set in each folder: a song's versions count once. */
export function songsOf(entries: Iterable<SetEntry>): SetSummary[] {
  const newest = new Map<string, SetEntry>();
  for (const entry of entries) {
    if (!entry.set) continue;
    const folder = dirname(entry.path); const held = newest.get(folder);
    if (!held || held.mtime < entry.mtime) newest.set(folder, entry);
  }
  return [...newest.values()].map((entry) => entry.set!);
}

/** Learn what's new or changed; resolves with how it went. Throws only when stopped (the signal). */
export async function learn(options: LearnOptions): Promise<LearnProgress> {
  const { signal } = options;
  const logs = libraryLogs(options.dir);
  if (options.rebuild) await Promise.all([logs.sounds.write([]), logs.presets.write([]), logs.sets.write([])]);
  const [sounds, presets, sets] = await Promise.all([logs.sounds.load(), logs.presets.load(), logs.sets.load()]);
  const progress: LearnProgress = { phase: "looking", sounds: { known: sounds.size, todo: 0, done: 0 }, presets: { known: presets.size, todo: 0, done: 0 },
    sets: { known: sets.size, todo: 0, done: 0 }, failed: 0, startedAt: Date.now() };
  let told = 0;
  const tell = (force = false) => { if (force || Date.now() - told > 250) { told = Date.now(); options.onProgress?.({ ...progress, sounds: { ...progress.sounds }, presets: { ...progress.presets }, sets: { ...progress.sets } }); } };
  tell(true);
  // Look: every source once, for everything in it; Sets also where the producer keeps them.
  const found: Finds = { sounds: [], presets: [], sets: [], seen: new Set() };
  // Folders looked through whole, for each kind: only there can a file Kumi knew be gone.
  const walked = { sounds: [] as string[], presets: [] as string[], sets: [] as string[] };
  const sources = [...options.sources].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  for (const source of sources) {
    progress.at = source.label; tell();
    const own = source.kind === "user-library" || source.kind === "place" || source.kind === "folder";
    if (await walk(source, { sounds: true, presets: true, sets: own }, found, signal)) { walked.sounds.push(source.path); walked.presets.push(source.path); if (own) walked.sets.push(source.path); }
  }
  const setsOnly: Source[] = (options.setFolders ?? []).filter((folder) => !sources.some((source) => folder === source.path || folder.startsWith(`${source.path}${sep}`)))
    .map((path) => ({ path, label: basename(path), kind: "folder" as const }));
  // Looking for more Sets around the library (~/Music holds it), the library's own folders are left out: walked already, or packs.
  const sourcePaths = new Set(sources.map((source) => source.path));
  for (const source of setsOnly) if (await walk(source, { sounds: false, presets: false, sets: true }, found, signal, 6, sourcePaths)) walked.sets.push(source.path);
  for (const path of options.setFiles ?? []) {
    if (found.seen.has(path) || backupSet(basename(path))) continue;
    try { const info = await stat(path); found.seen.add(path); found.sets.push({ path, size: info.size, mtime: Math.round(info.mtimeMs), source: { path: dirname(path), label: basename(dirname(path)), kind: "folder" }, relative: basename(path) }); }
    catch { /* gone */ }
  }
  for (const folder of options.pluginPresets ?? []) {
    const source: Source = { path: folder, label: "Plug-in presets", kind: "folder" };
    if (await walk(source, { sounds: false, presets: true, sets: false }, found, signal, 6)) walked.presets.push(folder);
  }
  // What's gone: known files in folders looked through whole that weren't found (a drive that isn't there keeps its files).
  const within = (roots: readonly string[], path: string) => roots.some((root) => path.startsWith(`${root}${sep}`));
  // A Set known by path alone is gone when its file is and its folder's still there.
  const vanished = (path: string) => !existsSync(path) && existsSync(dirname(dirname(path)));
  const gone = <T extends Entry>(known: Map<T["path"], T>, seen: Found[], log: Log<T>, roots: readonly string[], outside = false) => {
    const present = new Set(seen.map((file) => file.path));
    const lost = [...known.keys()].filter((path) => !present.has(path) && (within(roots, path) || (outside && (vanished(path) || backupSet(path)))));
    for (const path of lost) known.delete(path);
    return lost.length ? log.append(lost.map((path) => ({ path, size: 0, mtime: 0, gone: true as const }))) : Promise.resolve();
  };
  await gone(sounds, found.sounds, logs.sounds, walked.sounds); await gone(presets, found.presets, logs.presets, walked.presets); await gone(sets, found.sets, logs.sets, walked.sets, true);
  const todo = {
    sounds: found.sounds.filter((file) => { const known = sounds.get(file.path); return changed(known, file) || (known!.vector !== undefined && known!.features !== FEATURES_VERSION); }),
    presets: found.presets.filter((file) => changed(presets.get(file.path), file)),
    sets: found.sets.filter((file) => changed(sets.get(file.path), file)),
  };
  progress.sounds = { known: sounds.size, todo: todo.sounds.length, done: 0 };
  progress.presets = { known: presets.size, todo: todo.presets.length, done: 0 };
  progress.sets = { known: sets.size, todo: todo.sets.length, done: 0 };
  // Presets: a few kilobytes each.
  progress.phase = "presets"; tell(true);
  const presetWriter = writer(logs.presets);
  for (const file of todo.presets) {
    await options.gate?.(); signal.throwIfAborted();
    const extension = extname(file.path).toLowerCase().slice(1);
    const plugin = file.source.label === "Plug-in presets";
    const facts = await (extension === "adv" || extension === "adg" ? readLivePreset(file.path) : extension === "amxd" ? readMaxDevice(file.path) : Promise.resolve(pluginPresetFacts(file.relative)))
      .catch((error: unknown) => { progress.failed++; return { error: error instanceof Error ? error.message.slice(0, 120) : "unreadable" }; });
    const browser = browserPath(file.source, file.relative);
    const entry: PresetEntry = { path: file.path, size: file.size, mtime: file.mtime, name: basename(file.path, extname(file.path)), format: extension, ...facts,
      ...(plugin ? { category: "plug-in" as const } : {}), source: file.source.label, folder: dirname(file.relative) === "." ? "" : dirname(file.relative), ...(browser && !plugin ? { browser } : {}) };
    presets.set(file.path, entry); presetWriter.add(entry);
    progress.presets.done++; progress.presets.known = presets.size; tell();
  }
  await presetWriter.flush();
  // Sets: a fraction of a second each, read as they stream.
  progress.phase = "sets"; tell(true);
  const setWriter = writer(logs.sets);
  for (const file of todo.sets) {
    await options.gate?.(); signal.throwIfAborted();
    const entry: SetEntry = await readSet(file.path, { signal }).then((set) => ({ path: file.path, size: file.size, mtime: file.mtime, set }),
      (error: unknown) => { signal.throwIfAborted(); progress.failed++; return { path: file.path, size: file.size, mtime: file.mtime, error: error instanceof Error ? error.message.slice(0, 120) : "unreadable" }; });
    sets.set(file.path, entry); setWriter.add(entry);
    progress.sets.done++; progress.sets.known = sets.size; tell();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await setWriter.flush();
  // The producer's habits, from the newest Set of each song.
  await writeJson(join(options.dir, "taste.json"), buildTaste(songsOf(sets.values())));
  // Sounds: the producer's own first, a few at a time.
  progress.phase = "sounds"; tell(true);
  const soundWriter = writer(logs.sounds);
  const size = Math.max(0, Math.min(options.workers ?? Math.min(2, Math.max(1, availableParallelism() - 2)), 4));
  const pool = new Pool(size);
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, size) }, async (_, slot) => {
      while (next < todo.sounds.length) {
        await options.gate?.(); signal.throwIfAborted();
        const file = todo.sounds[next++]!;
        progress.at = file.source.label;
        const entry = await pool.run(slot, file);
        signal.throwIfAborted();
        if (entry.error && !entry.class && !entry.kind) progress.failed++;
        sounds.set(file.path, entry); soundWriter.add(entry);
        progress.sounds.done++; progress.sounds.known = sounds.size; tell();
      }
    }));
  } finally { await soundWriter.flush().catch(() => {}); await pool.close(); }
  // Tidy: logs written afresh with only what stands, when this run changed them.
  progress.phase = "tidying"; delete progress.at; tell(true);
  if (todo.sounds.length) await logs.sounds.write(sounds.values());
  if (todo.presets.length) await logs.presets.write(presets.values());
  if (todo.sets.length) await logs.sets.write(sets.values());
  progress.phase = "done"; progress.finishedAt = Date.now(); tell(true);
  return progress;
}

/** Where Sets usually are besides the library's folders: Live's default places and the folders of Sets the producer opened. */
export function setFolders(recent: readonly string[], home = homedir(), platform = process.platform): string[] {
  const folders = new Set<string>();
  for (const base of platform === "win32" ? [join(home, "Documents", "Ableton"), join(home, "Music")] : [join(home, "Music")]) folders.add(base);
  // A Set's project folder's own folder usually holds the producer's other projects.
  for (const file of recent) { const project = dirname(file); const parent = dirname(project); if (parent !== project && parent !== home && parent.length > home.length) folders.add(parent); }
  return [...folders];
}

/** Plug-ins' own preset folders. */
export function pluginPresetFolders(home = homedir(), platform = process.platform): string[] {
  return platform === "win32" ? [join(home, "Documents", "VST3 Presets")] : platform === "darwin" ? [join(home, "Library", "Audio", "Presets")] : [join(home, ".vst3", "presets")];
}
