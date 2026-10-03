/**
 * How learning the library is going, on disk, for whoever asks (Kumi's screen, `kumi doctor`,
 * `kumi library`): the run under way and the last one that finished. A lock keeps two Kumis from
 * learning into the same library at once.
 */
import { open, readFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Counts, LearnProgress } from "./learn.js";
import { readJson, writeJson } from "./store.js";

export interface LibraryState {
  version: 1;
  /** The run under way: its process, and how far it's got. */
  learning?: { pid: number; startedAt: number; phase: LearnProgress["phase"]; sounds: Counts; presets: Counts; sets: Counts; updatedAt: number };
  /** The last run that finished. */
  last?: { startedAt: number; finishedAt: number; sounds: number; presets: number; sets: number; failed: number };
}

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The state as it stands: a run whose process is gone isn't under way. */
export async function readState(dir: string): Promise<LibraryState | undefined> {
  const state = await readJson<LibraryState>(join(dir, "state.json"));
  if (state?.version !== 1) return undefined;
  if (state.learning && !alive(state.learning.pid)) delete state.learning;
  return state;
}

/** Record how this run is going (or how it ended); `stopped` clears the run without finishing it. */
export async function writeState(dir: string, progress: LearnProgress, stopped = false): Promise<void> {
  const before = await readJson<LibraryState>(join(dir, "state.json"));
  const state: LibraryState = { version: 1, ...(before?.version === 1 && before.last ? { last: before.last } : {}) };
  if (progress.phase === "done") state.last = { startedAt: progress.startedAt, finishedAt: progress.finishedAt ?? Date.now(), sounds: progress.sounds.known, presets: progress.presets.known, sets: progress.sets.known, failed: progress.failed };
  else if (!stopped) state.learning = { pid: process.pid, startedAt: progress.startedAt, phase: progress.phase, sounds: progress.sounds, presets: progress.presets, sets: progress.sets, updatedAt: Date.now() };
  await writeJson(join(dir, "state.json"), state);
}

/** Take the library's lock, or undefined when another living Kumi holds it. Resolves with its release. */
export async function acquireLock(dir: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "learning.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return async () => { await rm(file, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: unknown; at?: unknown } = {};
      try { holder = JSON.parse(await readFile(file, "utf8")) as typeof holder; } catch { /* half-written: stale */ }
      // A day-old lock is stale even if its number now belongs to another process.
      if (typeof holder.pid === "number" && holder.pid !== process.pid && alive(holder.pid) && typeof holder.at === "number" && Date.now() - holder.at < 24 * 60 * 60_000) return undefined;
      await rm(file, { force: true });
    }
  }
  return undefined;
}
