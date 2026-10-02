/**
 * `kumi library`: what Kumi knows of the producer's library (sounds, presets, Sets), where it looks,
 * and what it learned from their Sets. `--rebuild` learns it all again, here, saying how it goes.
 * Kumi learns by itself in the background while it runs; this is for looking, and starting over.
 */
import { homedir } from "node:os";
import type { Writable } from "node:stream";
import { createLibrary, KUMI, libraryLogs, readLibraryState, since, type LearnProgress, type Library } from "@kumi/runtime";
import { loadLibraryDir, loadProjectsDir, loadSettingsFile, readSettings } from "./config.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface LibraryIo {
  out: Writable & { isTTY?: boolean };
  env: Env;
  rebuild: boolean;
  signal?: AbortSignal;
  /** For tests: a library of their own. */
  library?: Library;
  now?: () => number;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const grouped = (value: number) => value.toLocaleString("en-US");
const counted = (value: number, one: string) => `${grouped(value)} ${one}${value === 1 ? "" : "s"}`;
const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} seconds` : `${Math.round(ms / 60_000)} minutes`);

/** "1,204 of 8,311 new sounds", as learning goes. */
function progressLine(progress: LearnProgress): string {
  if (progress.phase === "looking") return `Looking through your folders${progress.at ? ` (${progress.at})` : ""}…`;
  if (progress.phase === "presets") return `Presets: ${grouped(progress.presets.done)} of ${grouped(progress.presets.todo)}`;
  if (progress.phase === "sets") return `Sets: ${grouped(progress.sets.done)} of ${grouped(progress.sets.todo)}`;
  if (progress.phase === "sounds") return `Sounds: ${grouped(progress.sounds.done)} of ${grouped(progress.sounds.todo)}${progress.at ? ` (${progress.at})` : ""}`;
  return progress.phase === "tidying" ? "Tidying up…" : "Done.";
}

export async function runLibrary(io: LibraryIo): Promise<number> {
  const { out } = io;
  const now = io.now ?? Date.now;
  const dir = loadLibraryDir(io.env);
  const library = io.library ?? createLibrary({ dir, folders: readSettings(loadSettingsFile(io.env)).libraryFolders ?? [], projectsDir: loadProjectsDir(io.env) });
  try {
    if (io.rebuild) {
      out.write("Learning your library again, from the start. Ctrl-C stops; Kumi carries on from there next time it runs.\n");
      let shown = ""; let last = 0;
      const result = await library.learnNow({ rebuild: true, signal: io.signal ?? new AbortController().signal, onProgress: (progress) => {
        const line = progressLine(progress);
        if (line === shown || (now() - last < 1_000 && progress.phase !== "done")) return;
        shown = line; last = now();
        out.write(out.isTTY ? `\r\u001b[2K  ${line}` : `  ${line}\n`);
      } }).catch((error: unknown) => {
        if (io.signal?.aborted) { out.write(`${out.isTTY ? "\n" : ""}Stopped. What Kumi learned so far is kept.\n`); return null; }
        throw error;
      });
      if (result === null) return 1;
      if (!result) { out.write("Kumi is learning your library in another window right now. Quit that Kumi first, then run this again.\n"); return 1; }
      out.write(`${out.isTTY ? "\n" : ""}Learned ${counted(result.sounds.known, "sound")}, ${counted(result.presets.known, "preset")} and ${counted(result.sets.known, "Set")} in ${minutes((result.finishedAt ?? now()) - result.startedAt)}.\n\n`);
    }
    const state = await readLibraryState(dir);
    const logs = libraryLogs(dir);
    const [sounds, presets, sets] = await Promise.all([logs.sounds.load(), logs.presets.load(), logs.sets.load()]);
    const nameOnly = [...sounds.values()].filter((entry) => !entry.vector).length;
    const lines = [`Kumi's library (${tilde(dir)})`, ""];
    if (!sounds.size && !presets.size && !sets.size && !state?.learning) {
      lines.push("  Not learned yet. Kumi learns it by itself in the background while it runs,", `  or here, now: ${KUMI} library --rebuild`);
    } else {
      lines.push(`  Sounds    ${grouped(sounds.size)}${nameOnly ? ` (${grouped(nameOnly)} known by name only: Kumi couldn't read ${nameOnly === 1 ? "it" : "them"})` : ""}`, `  Presets   ${grouped(presets.size)}`, `  Sets      ${grouped(sets.size)}`);
      if (state?.learning) {
        const learning = state.learning;
        lines.push(`  Learning  now: ${learning.phase === "sounds" ? `${grouped(learning.sounds.done)} of ${grouped(learning.sounds.todo)} new sounds` : `${learning.phase}…`}`);
      }
      if (state?.last) lines.push(`  Learned   ${since(state.last.finishedAt, now())} (in ${minutes(state.last.finishedAt - state.last.startedAt)}); Kumi looks again every half hour while it runs`);
    }
    lines.push("", "Where Kumi looks");
    const sources = library.sources();
    const width = Math.max(12, ...sources.map((source) => source.label.length)) + 2;
    for (const source of sources) lines.push(`  ${source.label.padEnd(width)}${tilde(source.path)}`);
    if (!sources.length) lines.push("  Nowhere yet: Live's User Library wasn't found.");
    const taste = await library.taste();
    if (taste.length) { lines.push("", "From your Sets (forget a line in Kumi's /memory)"); for (const line of taste) lines.push(`  ${line.line}`); }
    lines.push("", `More folders: add them to ${tilde(loadSettingsFile(io.env))} as "libraryFolders": ["~/Samples"]. ${KUMI} library --rebuild learns everything again.`);
    out.write(`${lines.join("\n")}\n`);
    return 0;
  } finally { if (!io.library) await library.close(); }
}
