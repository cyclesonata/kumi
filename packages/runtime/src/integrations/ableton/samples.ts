/**
 * Finding samples on disk: in the folders a producer names, or in Live's User Library, by words in
 * file and folder names ("kick", "808", "vinyl"), or at random. It only lists audio files and reads
 * the first bytes of the ones it returns, for their length; it never follows links out of a folder.
 * Formats are the ones Live and the bridge load.
 */
import { existsSync, readdirSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomInt } from "node:crypto";

export const SAMPLE_EXTENSIONS = new Set([".wav", ".wave", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a"]);
/** How much one search looks through, so a huge drive answers in seconds. */
const MAX_FILES = 60_000;
const MAX_FOLDERS = 12_000;
const MAX_DEPTH = 12;
const MAX_MATCHES = 5_000;

export interface Sample {
  /** The file's name without its extension, as Live shows it. */
  name: string;
  path: string;
  /** The searched folder it was found in. */
  folder: string;
  bytes: number;
  /** Length in seconds, for WAV and AIFF. */
  seconds?: number;
}

export interface SampleSearch {
  samples: Sample[];
  /** Audio files looked at, and how many matched. */
  scanned: number;
  matched: number;
  /** The search stopped at its bounds; narrower folders or words find the rest. */
  partial: boolean;
  /** Folders that don't exist or can't be read. */
  missing: string[];
}

/** Live's User Library, where it is by default. */
export function userLibrary(platform = process.platform, home = homedir()): string {
  return platform === "win32" ? join(home, "Documents", "Ableton", "User Library") : join(home, "Music", "Ableton", "User Library");
}

/**
 * Where Live keeps samples when the producer names no folder: the User Library, the Core Library's
 * samples (inside the app on macOS, under ProgramData on Windows; the first Live found) and
 * Factory Packs. Only folders that exist.
 */
export function defaultSampleFolders(platform = process.platform, home = homedir(), programData = process.env.ProgramData ?? "C:\\ProgramData"): string[] {
  const list = (folder: string) => { try { return readdirSync(folder).sort(); } catch { return []; } };
  const core = platform === "win32"
    ? list(join(programData, "Ableton")).filter((name) => /^Live /i.test(name)).map((name) => join(programData, "Ableton", name, "Resources", "Core Library", "Samples"))
    : list("/Applications").filter((name) => /^Ableton Live.*\.app$/i.test(name)).map((name) => join("/Applications", name, "Contents", "App-Resources", "Core Library", "Samples"));
  const packs = platform === "win32" ? join(home, "Documents", "Ableton", "Factory Packs") : join(home, "Music", "Ableton", "Factory Packs");
  return [userLibrary(platform, home), ...core.filter((folder) => existsSync(folder)).slice(0, 1), packs].filter((folder) => existsSync(folder));
}

/** "~/Samples" and absolute paths; anything else isn't a folder Kumi can find. */
export function folderPath(value: string, home = homedir()): string | undefined {
  const trimmed = value.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? join(home, trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

export async function findSamples(options: { folders: readonly string[]; words?: readonly string[]; limit: number; random?: boolean; signal?: AbortSignal }): Promise<SampleSearch> {
  const words = (options.words ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const found: Array<Sample & { score: number }> = [];
  const missing: string[] = [];
  let scanned = 0; let folders = 0; let partial = false;
  for (const root of options.folders) {
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    let readable = false;
    while (queue.length) {
      options.signal?.throwIfAborted();
      const { path, depth } = queue.shift()!;
      if (++folders > MAX_FOLDERS) { partial = true; break; }
      let entries: Awaited<ReturnType<typeof opendir>>;
      try { entries = await opendir(path); readable = true; } catch { continue; }
      for await (const entry of entries) {
        // Hidden files, and the folders where Live keeps previews and other metadata, aren't samples.
        if (entry.name.startsWith(".") || entry.name.toLowerCase() === "ableton folder info") continue;
        const full = join(path, entry.name);
        // Links are skipped: they could lead out of the folder, or round in a circle.
        if (entry.isDirectory()) { if (depth < MAX_DEPTH) queue.push({ path: full, depth: depth + 1 }); else partial = true; continue; }
        if (!entry.isFile() || !SAMPLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        if (++scanned > MAX_FILES) { partial = true; break; }
        const where = relative(root, full).toLowerCase();
        if (!words.every((word) => where.includes(word))) continue;
        const name = basename(entry.name, extname(entry.name));
        // A name that starts with a word ranks first ("Kick 808" for "kick"), then one that has it,
        // and a folder named for it ("Kick", "Kicks") adds a little.
        const lower = name.toLowerCase(); const folders = where.split(/[\\/]/).slice(0, -1);
        const score = words.reduce((total, word) => total + (lower.startsWith(word) ? 10 : lower.includes(word) ? 5 : 0)
          + (folders.some((folder) => folder === word || folder === `${word}s`) ? 3 : 0), 0);
        if (found.length < MAX_MATCHES) found.push({ name, path: full, folder: root, bytes: 0, score }); else partial = true;
      }
      if (scanned > MAX_FILES) break;
    }
    if (!readable) missing.push(root);
    if (scanned > MAX_FILES || folders > MAX_FOLDERS) break;
  }
  const chosen = options.random ? shuffle(found).slice(0, options.limit)
    : found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })).slice(0, options.limit);
  const samples = await Promise.all(chosen.map(async ({ score: _score, ...sample }) => ({ ...sample, ...(await describe(sample.path)) })));
  return { samples, scanned: Math.min(scanned, MAX_FILES), matched: found.length, partial, missing };
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) { const other = randomInt(index + 1); [copy[index], copy[other]] = [copy[other]!, copy[index]!]; }
  return copy;
}

/** Size, and length for WAV and AIFF from their headers. */
async function describe(path: string): Promise<{ bytes: number; seconds?: number }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const header = Buffer.alloc(Math.min(size, 64 * 1024));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const seconds = audioSeconds(header.subarray(0, bytesRead), size);
    return { bytes: size, ...(seconds !== undefined ? { seconds: Math.round(seconds * 1000) / 1000 } : {}) };
  } catch { return { bytes: 0 }; }
  finally { await file?.close().catch(() => {}); }
}

/** Seconds of audio from a WAV or AIFF header; undefined for anything else or anything odd. */
export function audioSeconds(header: Buffer, fileBytes: number): number | undefined {
  const tag = (at: number) => header.toString("latin1", at, at + 4);
  if (header.length >= 12 && tag(0) === "RIFF" && tag(8) === "WAVE") {
    let at = 12; let byteRate: number | undefined;
    while (at + 8 <= header.length) {
      const id = tag(at); const size = header.readUInt32LE(at + 4);
      if (id === "fmt " && at + 16 <= header.length) byteRate = header.readUInt32LE(at + 16);
      if (id === "data") {
        // A streamed WAV can leave the size unset; the rest of the file is audio then.
        const bytes = size === 0 || size === 0xffffffff ? fileBytes - at - 8 : size;
        return byteRate ? bytes / byteRate : undefined;
      }
      at += 8 + size + (size % 2);
    }
    return undefined;
  }
  if (header.length >= 12 && tag(0) === "FORM" && (tag(8) === "AIFF" || tag(8) === "AIFC")) {
    let at = 12;
    while (at + 8 <= header.length) {
      const id = tag(at); const size = header.readUInt32BE(at + 4);
      if (id === "COMM" && at + 26 <= header.length) {
        const frames = header.readUInt32BE(at + 10);
        const rate = extended(header.subarray(at + 16, at + 26));
        return rate > 0 ? frames / rate : undefined;
      }
      at += 8 + size + (size % 2);
    }
  }
  return undefined;
}

/** The 80-bit extended float AIFF uses for its sample rate. */
function extended(bytes: Buffer): number {
  const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;
  const mantissa = bytes.readUInt32BE(2) * 2 ** 32 + bytes.readUInt32BE(6);
  if (exponent === 0 && mantissa === 0) return 0;
  return mantissa * 2 ** (exponent - 16383 - 63) * (bytes[0]! & 0x80 ? -1 : 1);
}
