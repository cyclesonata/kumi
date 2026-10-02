/**
 * Where the producer's sounds, presets and Sets are: Live's User Library and Places (as Live's own
 * preferences name them), the packs Live installed and its Core Library, Splice's folder, and folders
 * the producer named. Only folders that exist; a folder inside another counts once.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export type SourceKind = "user-library" | "place" | "pack" | "core" | "splice" | "folder";
export interface Source {
  path: string;
  /** What the producer calls it: "User Library", a Place's name, a pack's. */
  label: string;
  kind: SourceKind;
}

export interface SourceOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  /** Folders the producer named (settings.json's libraryFolders, folders Kumi was asked to search): absolute or ~/…. */
  folders?: readonly string[];
  /** Where Live's apps are (macOS) and its shared files (Windows), for tests. */
  applications?: string;
  programData?: string;
}

const list = (folder: string) => { try { return readdirSync(folder); } catch { return []; } };
const isFolder = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const unescape = (value: string) => value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** "~/Samples" and absolute paths; anything else isn't a folder Kumi can find. */
export function expandFolder(value: string, home = homedir()): string | undefined {
  const trimmed = value.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? join(home, trimmed.slice(2)) : trimmed;
  return expanded && isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** Live's preference folders, newest first ("Live 12.1.5", "Live 12.0.20"…). */
export function livePreferenceFolders(options: SourceOptions = {}): string[] {
  const home = options.home ?? homedir(); const platform = options.platform ?? process.platform; const env = options.env ?? process.env;
  const root = platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Ableton") : join(home, "Library", "Preferences", "Ableton");
  return list(root).filter((name) => /^Live \d/.test(name))
    .map((name) => join(root, name, ...(platform === "win32" ? ["Preferences"] : [])))
    .filter((folder) => existsSync(join(folder, "Library.cfg")))
    .sort((a, b) => statSync(join(b, "Library.cfg")).mtimeMs - statSync(join(a, "Library.cfg")).mtimeMs);
}

/** What Live's newest Library.cfg says: the User Library, Places, where packs and Splice's downloads go. */
export function readLibraryConfig(text: string): { userLibrary?: string; places: string[]; packs?: string; splice?: string } {
  const value = (block: string, field: string) => { const found = new RegExp(`<${field} Value="([^"]*)"`).exec(block)?.[1]; return found === undefined ? undefined : unescape(found); };
  const user = /<UserLibrary>([\s\S]*?)<\/UserLibrary>/.exec(text)?.[1] ?? "";
  const folder = value(user, "ProjectPath"); const name = value(user, "ProjectName") || "User Library";
  // Places are listed with their paths (or "userfolder:" addresses that hold them), whatever Live's version calls the fields.
  const placesBlock = /<UserFolderInfoList>([\s\S]*?)<\/UserFolderInfoList>/.exec(text)?.[1] ?? "";
  const places = [...placesBlock.matchAll(/Value="([^"]+)"/g)].map((match) => unescape(match[1]!))
    .map((raw) => {
      const address = /^userfolder:(.+?)(?:#.*)?$/.exec(raw)?.[1];
      if (address) { try { return decodeURIComponent(address); } catch { return address; } }
      return raw;
    })
    .filter((path) => isAbsolute(path) && !/\.\w{2,4}$/.test(path));
  const packs = value(text, "PreferredFactoryPacksInstallationPath");
  const splice = value(text, "CustomSpliceDownloadPathMember");
  return { ...(folder && isAbsolute(folder) ? { userLibrary: join(folder, name) } : {}), places: [...new Set(places)], ...(packs && isAbsolute(packs) ? { packs } : {}), ...(splice && isAbsolute(splice) ? { splice } : {}) };
}

/**
 * The folders Live's indexer last said it looks after, from its log ("Configure: UserFolders:
 * '/Users/me/Samples' [Samples]"): Places by `UserFolders`, packs by `FactoryPacks`.
 */
export function readIndexerLog(text: string): { places: Source[]; packs: Source[] } {
  const last = (kind: string) => {
    const lines = text.split(/\r?\n/).filter((line) => line.includes(`Configure: ${kind}:`));
    const line = lines.at(-1) ?? "";
    return [...line.slice(line.indexOf(`${kind}:`) + kind.length + 1).matchAll(/'([^']+)'\s*\[([^\]]*)\]/g)].map((match) => ({ path: match[1]!, label: match[2]!.trim() || basename(match[1]!) }));
  };
  return {
    places: last("UserFolders").map((entry) => ({ ...entry, kind: "place" as const })),
    packs: [...last("FactoryPacks"), ...last("LegacyFactoryPacks")].map((entry) => ({ ...entry, kind: /Core Library$/i.test(entry.path) ? "core" as const : "pack" as const })),
  };
}

/** The Core Library inside Live (the newest found): the app's on macOS, ProgramData's on Windows. */
function coreLibraries(options: SourceOptions): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const programData = options.programData ?? options.env?.ProgramData ?? process.env.ProgramData ?? "C:\\ProgramData";
    return list(join(programData, "Ableton")).filter((name) => /^Live /i.test(name)).sort().reverse().map((name) => join(programData, "Ableton", name, "Resources", "Core Library"));
  }
  const applications = options.applications ?? "/Applications";
  return list(applications).filter((name) => /^Ableton Live.*\.app$/i.test(name)).sort().reverse().map((name) => join(applications, name, "Contents", "App-Resources", "Core Library"));
}

/** Where everything is, User Library first. */
export function librarySources(options: SourceOptions = {}): Source[] {
  const home = options.home ?? homedir(); const platform = options.platform ?? process.platform;
  const documents = platform === "win32" ? join(home, "Documents") : join(home, "Music");
  const found: Source[] = [];
  const add = (path: string | undefined, label: string, kind: SourceKind) => { if (path && isAbsolute(path)) found.push({ path: resolve(path), label, kind }); };
  const preferences = livePreferenceFolders(options)[0];
  let config: ReturnType<typeof readLibraryConfig> = { places: [] };
  let indexer: ReturnType<typeof readIndexerLog> = { places: [], packs: [] };
  if (preferences) {
    try { config = readLibraryConfig(readFileSync(join(preferences, "Library.cfg"), "utf8")); } catch { /* none to read */ }
    try { indexer = readIndexerLog(readFileSync(join(preferences, "Indexer.txt"), "utf8")); } catch { /* none to read */ }
  }
  add(config.userLibrary ?? join(documents, "Ableton", "User Library"), "User Library", "user-library");
  for (const place of indexer.places) add(place.path, place.label, "place");
  for (const place of config.places) add(place, basename(place), "place");
  for (const folder of options.folders ?? []) { const path = expandFolder(folder, home); add(path, path ? basename(path) : folder, "folder"); }
  // Splice's own app keeps its downloads in ~/Splice (Documents on Windows); Live's Splice browser may keep them elsewhere.
  add(config.splice, "Splice", "splice");
  add([join(home, "Splice"), join(home, "Documents", "Splice")].find(isFolder), "Splice", "splice");
  for (const pack of indexer.packs) add(pack.path, pack.label, pack.kind);
  for (const folder of [config.packs, join(documents, "Ableton", "Factory Packs")]) {
    if (!folder) continue;
    for (const name of list(folder).sort()) if (!name.startsWith(".") && isFolder(join(folder, name))) add(join(folder, name), name, "pack");
  }
  if (!found.some((source) => source.kind === "core")) add(coreLibraries(options).find(isFolder), "Core Library", "core");
  // Each folder once, and not again inside another: the outer one is searched whole.
  const unique: Source[] = [];
  for (const source of found) {
    if (!isFolder(source.path)) continue;
    if (unique.some((kept) => kept.path === source.path || source.path.startsWith(`${kept.path}${sep}`))) continue;
    for (let index = unique.length - 1; index >= 0; index--) if (unique[index]!.path.startsWith(`${source.path}${sep}`)) unique.splice(index, 1);
    unique.push(source);
  }
  return unique;
}

/** A sound's or preset's place in Live's Browser ("user_library/Samples/Kick.wav"), for the sources the Browser lists by path. */
export function browserPath(source: Source, relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return undefined;
  const root = source.kind === "user-library" ? ["user_library"] : source.kind === "place" ? ["user_folders", source.label] : source.kind === "pack" ? ["packs", source.label] : undefined;
  return root ? [...root, ...parts].join("/") : undefined;
}

/**
 * Sets Live opened lately, from its logs ("Loading document "/Users/me/Song Project/Song.als""): the
 * producer's own, wherever they keep them. Live's own templates and lessons aren't the producer's.
 */
export function recentSets(options: SourceOptions = {}): string[] {
  const found = new Set<string>();
  for (const folder of livePreferenceFolders(options)) {
    let text = "";
    try { text = readFileSync(join(folder, "Log.txt"), "utf8"); } catch { continue; }
    for (const match of text.matchAll(/Loading document "([^"\r\n]+\.als)"/g)) {
      const path = match[1]!;
      if (!/[\\/](App-Resources|Resources)[\\/](Builtin|Core Library)[\\/]/.test(path) && !/\.app[\\/]/.test(path)) found.add(path);
    }
  }
  return [...found].filter((path) => existsSync(path));
}
