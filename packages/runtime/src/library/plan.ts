/**
 * What one learning run looks through: the library's sources (Live's own folders, the producer's,
 * folders they named in a request), the Sets Live and Kumi know of, and plug-ins' preset folders.
 * Worked out where learning runs, so reading Live's logs never holds up Kumi's screen.
 */
import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pluginPresetFolders, setFolders, type LearnOptions } from "./learn.js";
import { librarySources, recentSets, type SourceOptions } from "./sources.js";
import { readJson } from "./store.js";

export interface PlanOptions {
  dir: string;
  /** Folders the producer listed (settings.json's libraryFolders). */
  folders?: readonly string[];
  /** Kumi's own record of the Sets it has seen. */
  projectsDir?: string;
  sources?: SourceOptions;
  /** Look for Sets in Live's logs, Kumi's projects and ~/Music (false in tests). */
  findSets?: boolean;
  workers?: number;
}

/** Folders the producer named in requests, kept so they're learned too. */
export const rememberedFile = (dir: string) => join(dir, "folders.json");
export async function rememberedFolders(dir: string): Promise<string[]> {
  return ((await readJson<unknown[]>(rememberedFile(dir))) ?? []).filter((folder): folder is string => typeof folder === "string");
}

/** Where Kumi's own record of each saved Set says it is (the start of its last-seen.json). */
export async function kumiSets(projectsDir: string | undefined): Promise<string[]> {
  if (!projectsDir) return [];
  const found: string[] = [];
  for (const id of await readdir(projectsDir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{32}$/.test(id)) continue;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(projectsDir, id, "last-seen.json"), "r");
      const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
      const path = /"path":"((?:[^"\\]|\\.)*)"/.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
      if (path) { const value = JSON.parse(`"${path}"`) as string; if (value.endsWith(".als") && existsSync(value)) found.push(value); }
    } catch { /* no record */ } finally { await handle?.close().catch(() => {}); }
  }
  return found;
}

export async function planLearning(options: PlanOptions): Promise<Omit<LearnOptions, "signal" | "gate" | "onProgress">> {
  const remembered = await rememberedFolders(options.dir);
  const home = options.sources?.home ?? homedir(); const platform = options.sources?.platform ?? process.platform;
  const recent = options.findSets === false ? [] : [...new Set([...recentSets(options.sources), ...await kumiSets(options.projectsDir)])];
  return {
    dir: options.dir,
    sources: librarySources({ ...options.sources, folders: [...(options.folders ?? []), ...remembered] }),
    setFolders: options.findSets === false ? [] : setFolders(recent, home, platform), setFiles: recent,
    pluginPresets: options.findSets === false ? [] : pluginPresetFolders(home, platform).filter((folder) => existsSync(folder)),
    ...(options.workers !== undefined ? { workers: options.workers } : {}),
  };
}
