/**
 * Searching what the library learned: sounds by words, class, kind, tempo, key and length, or by
 * how close they sound to another; presets by name, device and kind; Sets by name, tracks, devices,
 * tempo and key. Everything is in memory and plain arrays, so a search over 50,000 sounds takes a
 * few milliseconds. Each result says why it matched.
 */
import { existsSync } from "node:fs";
import { basename, extname, sep } from "node:path";
import { randomInt } from "node:crypto";
import { CLASSES, parseKey, tokens, type SoundClass, type SoundKind } from "./classify.js";
import { VECTOR_GROUPS, VECTOR_LENGTH } from "./features.js";
import type { PresetEntry, SetEntry, SoundEntry } from "./learn.js";
import type { SetSummary, SetTrack } from "./sets.js";
import type { Source } from "./sources.js";
import { unpackVector } from "./store.js";
import { colourName, trackRole } from "./taste.js";

/** Words that name a class, plural or not ("kicks", "hi-hats", "vox"). */
const CLASS_WORDS = new Map<string, SoundClass>([
  ...CLASSES.map((name) => [name, name] as const), ...CLASSES.map((name) => [`${name}s`, name] as const),
  ["hihat", "hat"], ["hihats", "hat"], ["hh", "hat"], ["bd", "kick"], ["kik", "kick"], ["sd", "snare"], ["vox", "vocal"], ["vocals", "vocal"], ["voice", "vocal"],
  ["percussion", "perc"], ["crash", "cymbal"], ["ride", "cymbal"], ["808", "bass"], ["sub", "bass"], ["piano", "keys"], ["chord", "keys"], ["chords", "keys"],
  ["riser", "fx"], ["sfx", "fx"], ["impact", "fx"], ["atmos", "texture"], ["ambience", "texture"], ["drum", "drums"], ["break", "drums"], ["breaks", "drums"],
]);

type Measure = "brightness" | "flatness" | "attack" | "decay" | "seconds" | "loudness" | "width" | "low" | "high" | "onsets";
/** Words that describe how a sound sounds: they rank by a measurement rather than match a name. */
const DESCRIPTORS: Record<string, { measure: Measure; high: boolean; says: string }> = {
  dark: { measure: "brightness", high: false, says: "dark" }, warm: { measure: "brightness", high: false, says: "warm" }, muffled: { measure: "brightness", high: false, says: "muffled" },
  mellow: { measure: "brightness", high: false, says: "mellow" }, dull: { measure: "brightness", high: false, says: "dull" }, deep: { measure: "low", high: true, says: "deep" },
  bright: { measure: "brightness", high: true, says: "bright" }, crisp: { measure: "brightness", high: true, says: "crisp" }, airy: { measure: "high", high: true, says: "airy" },
  sharp: { measure: "attack", high: false, says: "sharp" }, harsh: { measure: "brightness", high: true, says: "harsh" }, shiny: { measure: "brightness", high: true, says: "shiny" },
  punchy: { measure: "attack", high: false, says: "punchy" }, snappy: { measure: "decay", high: false, says: "snappy" }, tight: { measure: "decay", high: false, says: "tight" },
  short: { measure: "seconds", high: false, says: "short" }, long: { measure: "seconds", high: true, says: "long" }, boomy: { measure: "decay", high: true, says: "boomy" },
  big: { measure: "decay", high: true, says: "big" }, soft: { measure: "attack", high: true, says: "soft" }, slow: { measure: "attack", high: true, says: "slow" },
  dusty: { measure: "flatness", high: true, says: "dusty" }, lofi: { measure: "flatness", high: true, says: "lo-fi" }, gritty: { measure: "flatness", high: true, says: "gritty" },
  dirty: { measure: "flatness", high: true, says: "dirty" }, crunchy: { measure: "flatness", high: true, says: "crunchy" }, noisy: { measure: "flatness", high: true, says: "noisy" },
  distorted: { measure: "flatness", high: true, says: "distorted" }, clean: { measure: "flatness", high: false, says: "clean" }, pure: { measure: "flatness", high: false, says: "pure" },
  wide: { measure: "width", high: true, says: "wide" }, stereo: { measure: "width", high: true, says: "wide" }, mono: { measure: "width", high: false, says: "mono" },
  narrow: { measure: "width", high: false, says: "narrow" }, loud: { measure: "loudness", high: true, says: "loud" }, quiet: { measure: "loudness", high: false, says: "quiet" },
  heavy: { measure: "low", high: true, says: "heavy" }, fat: { measure: "low", high: true, says: "fat" }, thick: { measure: "low", high: true, says: "thick" },
  thin: { measure: "low", high: false, says: "thin" }, busy: { measure: "onsets", high: true, says: "busy" }, sparse: { measure: "onsets", high: false, says: "sparse" },
};
const MEASURE_WORDS: Record<Measure, (value: number) => string> = {
  brightness: (value) => `brightness ${value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`}`, flatness: (value) => `noise ${Math.round(value * 100)}%`,
  attack: (value) => `attack ${Math.round(value)} ms`, decay: (value) => `decay ${Math.round(value)} ms`, seconds: (value) => `${value.toFixed(value < 10 ? 2 : 1)} s`,
  loudness: (value) => `${Math.round(value)} LUFS`, width: (value) => `width ${Math.round(value * 100)}%`, low: (value) => `low end ${Math.round(value * 100)}%`,
  high: (value) => `highs ${Math.round(value * 100)}%`, onsets: (value) => `${value.toFixed(1)} hits/s`,
};
const measureOf = (entry: SoundEntry, measure: Measure): number | undefined =>
  ({ brightness: entry.brightness, flatness: entry.flatness, attack: entry.attack, decay: entry.decay, seconds: entry.seconds, loudness: entry.loudness, width: entry.width, low: entry.low, high: entry.high, onsets: entry.onsets })[measure];
const plainWord = (word: string) => word.toLowerCase().replace(/[-_\s]/g, "");

export interface SoundQuery {
  /** Every word must be in the name or folders, or name the class; words that describe a sound rank by it instead. */
  words?: readonly string[];
  /** A vector to sound like, and its measurements (for saying how they differ); its own file isn't offered back. */
  like?: { vector: readonly number[]; name: string; path?: string; brightness: number; attack: number; seconds: number };
  kind?: SoundKind;
  classes?: readonly SoundClass[];
  /** A loop's tempo, with a little either way; half and double count, lower. */
  bpm?: number;
  /** A key ("A minor"); a sound in its relative key counts, lower. */
  key?: string;
  minSeconds?: number;
  maxSeconds?: number;
  /** Only sounds under these folders. */
  folders?: readonly string[];
  random?: boolean;
  limit: number;
}

export interface SoundHit {
  entry: SoundEntry;
  name: string;
  /** Where it is, for the producer: its source and folder. */
  where: string;
  score: number;
  why: string[];
  /** How close it sounds, 0–100, when asked for. */
  closeness?: number;
}

/** Relative keys: C major and A minor share their notes. */
function relativeKey(key: string): string | undefined {
  const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const [root, quality] = key.split(" ");
  const index = notes.indexOf(root ?? "");
  if (index < 0) return undefined;
  return quality === "minor" ? `${notes[(index + 3) % 12]} major` : quality === "major" ? `${notes[(index + 9) % 12]} minor` : undefined;
}

/** What an entry needs for searching, worked out once (a library is built again as it grows). */
interface Prepared { source: string; name: string; lower: string; where: string; hay: string; folders: string[]; vector: Float32Array }
const preparedEntries = new WeakMap<SoundEntry, Prepared>();
function prepared(entry: SoundEntry, source: Source): Prepared {
  const held = preparedEntries.get(entry);
  if (held && held.source === source.path) return held;
  const relative = entry.path.slice(source.path.length + 1);
  const folders = relative.split(/[\\/]/).slice(0, -1);
  const name = basename(entry.path, extname(entry.path));
  const made = { source: source.path, name, lower: name.toLowerCase(), where: [source.label, ...folders].join(" / "), hay: `${source.label}/${relative}`.toLowerCase(),
    folders: [source.label, ...folders].map((folder) => folder.toLowerCase()), vector: entry.vector ? unpackVector(entry.vector) : new Float32Array(0) };
  preparedEntries.set(entry, made);
  return made;
}

/** Sounds in memory, ready to search: built from the learned entries and the sources they're in. */
export class SoundIndex {
  readonly entries: SoundEntry[];
  private readonly hay: string[];
  private readonly names: string[];
  private readonly lowerNames: string[];
  private readonly wheres: string[];
  private readonly folderWords: string[][];
  private readonly vectors: Float32Array;
  private readonly hasVector: Uint8Array;
  private readonly weights: Float32Array;
  private readonly mean: Float32Array;
  private readonly scale: Float32Array;

  constructor(entries: Iterable<SoundEntry>, sources: readonly Source[]) {
    // Each sound in its source (the longest that holds it); sounds in sources not here now (a drive unplugged) aren't offered.
    const roots = [...sources].filter((source) => existsSync(source.path)).sort((a, b) => b.path.length - a.path.length);
    this.entries = []; this.hay = []; this.names = []; this.lowerNames = []; this.wheres = []; this.folderWords = [];
    const vectors: Float32Array[] = [];
    for (const entry of entries) {
      const source = roots.find((root) => entry.path.startsWith(`${root.path}${sep}`));
      if (!source) continue;
      const made = prepared(entry, source);
      this.entries.push(entry); this.names.push(made.name); this.lowerNames.push(made.lower); this.wheres.push(made.where); this.hay.push(made.hay); this.folderWords.push(made.folders);
      vectors.push(made.vector);
    }
    const count = this.entries.length;
    this.vectors = new Float32Array(count * VECTOR_LENGTH); this.hasVector = new Uint8Array(count);
    // Each measurement counts by how much it varies across the library, weighted by its group.
    this.mean = new Float32Array(VECTOR_LENGTH); this.scale = new Float32Array(VECTOR_LENGTH).fill(1); this.weights = new Float32Array(VECTOR_LENGTH);
    let at = 0;
    // A group of many numbers (the timbre's) counts as three; the rest one each, all by their group's weight.
    for (const part of VECTOR_GROUPS) for (let index = 0; index < part.count; index++) this.weights[at++] = Math.sqrt(part.weight * (part.count > 3 ? 3 / part.count : 1));
    let measured = 0;
    const squares = new Float64Array(VECTOR_LENGTH); const sums = new Float64Array(VECTOR_LENGTH);
    for (const [row, vector] of vectors.entries()) {
      if (vector.length !== VECTOR_LENGTH) continue;
      this.hasVector[row] = 1; measured++;
      for (let dimension = 0; dimension < VECTOR_LENGTH; dimension++) { const value = vector[dimension]!; sums[dimension]! += value; squares[dimension]! += value * value; }
    }
    for (let dimension = 0; dimension < VECTOR_LENGTH; dimension++) {
      const average = sums[dimension]! / Math.max(1, measured);
      this.mean[dimension] = average;
      this.scale[dimension] = this.weights[dimension]! / Math.max(1e-3, Math.sqrt(Math.max(0, squares[dimension]! / Math.max(1, measured) - average * average)));
    }
    for (const [row, vector] of vectors.entries()) {
      if (!this.hasVector[row]) continue;
      const offset = row * VECTOR_LENGTH;
      for (let dimension = 0; dimension < VECTOR_LENGTH; dimension++) this.vectors[offset + dimension] = (vector[dimension]! - this.mean[dimension]!) * this.scale[dimension]!;
    }
  }

  /** Built a few thousand sounds at a time, so the screen keeps drawing while a big library is first read. */
  static async build(entries: Iterable<SoundEntry>, sources: readonly Source[]): Promise<SoundIndex> {
    const list = [...entries];
    const roots = [...sources].sort((a, b) => b.path.length - a.path.length);
    for (let at = 0; at < list.length; at += 2_000) {
      for (const entry of list.slice(at, at + 2_000)) { const source = roots.find((root) => entry.path.startsWith(`${root.path}${sep}`)); if (source) prepared(entry, source); }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return new SoundIndex(list, sources);
  }

  get size() { return this.entries.length; }
  /** How many sounds were measured (the rest are known by name). */
  get measured() { let count = 0; for (const flag of this.hasVector) count += flag; return count; }
  /** Whether any sound is under `folder`. */
  holds(folder: string): boolean { return this.entries.some((entry) => entry.path.startsWith(`${folder}${sep}`)); }
  /** The stored vector of a sound the library knows, by its path (when it's unchanged). */
  vectorOf(path: string, size?: number): SoundEntry | undefined { return this.entries.find((entry) => entry.path === path && (size === undefined || entry.size === size)); }

  search(query: SoundQuery): { hits: SoundHit[]; matched: number } {
    const words = (query.words ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
    const describing = words.map((word) => DESCRIPTORS[plainWord(word)]).filter((found): found is typeof DESCRIPTORS[string] => Boolean(found));
    const naming = words.filter((word) => !DESCRIPTORS[plainWord(word)]);
    const classOf = naming.map((word) => CLASS_WORDS.get(plainWord(word)));
    const classes = query.classes?.length ? new Set(query.classes) : undefined;
    const key = query.key ? parseKey(query.key) ?? query.key : undefined;
    const relative = key ? relativeKey(key) : undefined;
    const folders = query.folders?.map((folder) => `${folder}${sep}`);
    const like = query.like ? this.normalized(query.like.vector) : undefined;
    const spread = Math.sqrt(2 * this.weights.reduce((sum, weight) => sum + weight * weight, 0));
    // Scores first, for everything that matches; the reasons are written only for what's returned.
    const rows: number[] = []; const scores: number[] = []; const closeness = new Map<number, number>();
    for (let row = 0; row < this.entries.length; row++) {
      const entry = this.entries[row]!;
      if (query.kind && entry.kind !== query.kind) continue;
      if (classes && (!entry.class || !classes.has(entry.class))) continue;
      if (query.minSeconds !== undefined && (entry.seconds === undefined || entry.seconds < query.minSeconds)) continue;
      if (query.maxSeconds !== undefined && (entry.seconds === undefined || entry.seconds > query.maxSeconds)) continue;
      if (folders && !folders.some((folder) => entry.path.startsWith(folder))) continue;
      let score = 0;
      if (query.bpm !== undefined) {
        if (entry.bpm === undefined) continue;
        const off = Math.abs(Math.log2(entry.bpm / query.bpm));
        if (off < 0.03) score += 6; else if (Math.abs(off - 1) < 0.03) score += 2; else continue;
      }
      if (key) {
        if (entry.key === key) score += 6; else if (entry.key && entry.key === relative) score += 3;
        else if (!entry.key && entry.note && key.startsWith(`${entry.note.replace(/-?\d+$/, "")} `)) score += 4; else continue;
      }
      // Words: each must be in its name or folders, or name its class.
      let missing = false;
      if (naming.length) {
        const hay = this.hay[row]!; const name = this.lowerNames[row]!; const folderWords = this.folderWords[row]!;
        for (const [index, word] of naming.entries()) {
          const inName = name.startsWith(word) ? 10 : name.includes(word) ? 5 : 0;
          const asClass = classOf[index] !== undefined && entry.class === classOf[index];
          if (!inName && !asClass && !hay.includes(word)) { missing = true; break; }
          score += inName + (folderWords.some((folder) => folder === word || folder === `${word}s`) ? 3 : 0) + (asClass ? 8 : 0);
        }
      }
      if (missing) continue;
      if (like) {
        if (!this.hasVector[row] || entry.path === query.like!.path) continue;
        let distance = 0; const offset = row * VECTOR_LENGTH;
        for (let dimension = 0; dimension < VECTOR_LENGTH; dimension++) { const delta = this.vectors[offset + dimension]! - like[dimension]!; distance += delta * delta; }
        const close = 100 * Math.exp(-2 * (Math.sqrt(distance) / spread) ** 2);
        score += close; closeness.set(row, close);
      }
      rows.push(row); scores.push(score);
    }
    // Describing words rank by where each sound falls among the matches (darkest first for "dark").
    const ranks = describing.map((describe) => {
      const values = new Float64Array(rows.length); let count = 0;
      for (const row of rows) { const value = measureOf(this.entries[row]!, describe.measure); if (value !== undefined) values[count++] = value; }
      const sorted = values.subarray(0, count).sort();
      const rank = new Map<number, number>();
      if (!count) return rank;
      for (const [index, row] of rows.entries()) {
        const value = measureOf(this.entries[row]!, describe.measure);
        if (value === undefined) continue;
        let low = 0; let high = count;
        while (low < high) { const middle = (low + high) >> 1; if (sorted[middle]! < value) low = middle + 1; else high = middle; }
        const place = low / Math.max(1, count - 1);
        const value01 = describe.high ? place : 1 - place;
        scores[index]! += value01 * 12; rank.set(row, value01);
      }
      return rank;
    });
    const order = Array.from(rows.keys());
    let chosen: number[];
    if (query.random) {
      for (let index = order.length - 1; index > 0; index--) { const other = randomInt(index + 1); [order[index], order[other]] = [order[other]!, order[index]!]; }
      chosen = order.slice(0, query.limit);
    } else {
      // The best by score (ties in the order learned), then those few by score and name.
      chosen = topBy(order, query.limit, (a, b) => scores[b]! - scores[a]! || a - b)
        .sort((a, b) => scores[b]! - scores[a]! || NAMES.compare(this.names[rows[a]!]!, this.names[rows[b]!]!));
    }
    return { matched: rows.length, hits: chosen.map((at) => {
      const row = rows[at]!; const entry = this.entries[row]!;
      const why = this.reasons(row, naming, classOf, query, key, relative);
      for (const [index, describe] of describing.entries()) {
        const value = measureOf(entry, describe.measure);
        if (value !== undefined && (ranks[index]!.get(row) ?? 0) >= 0.6) why.push(`${describe.says}: ${MEASURE_WORDS[describe.measure](value)}`);
      }
      const close = closeness.get(row);
      if (close !== undefined && query.like) why.unshift(`${Math.round(close)}% like ${query.like.name}${this.differences(entry, query.like)}`);
      return { entry, name: this.names[row]!, where: this.wheres[row]!, score: Math.round(scores[at]! * 10) / 10, why, ...(close !== undefined ? { closeness: Math.round(close) } : {}) };
    }) };
  }

  /** Why a sound matched the words, tempo and key, in a few words each. */
  private reasons(row: number, naming: readonly string[], classOf: readonly (SoundClass | undefined)[], query: SoundQuery, key: string | undefined, relative: string | undefined): string[] {
    const entry = this.entries[row]!; const why: string[] = [];
    if (query.bpm !== undefined && entry.bpm !== undefined) why.push(Math.abs(Math.log2(entry.bpm / query.bpm)) < 0.03 ? `${entry.bpm} BPM` : `${entry.bpm} BPM (half or double)`);
    if (key) why.push(entry.key === key ? key : entry.key && entry.key === relative ? `${entry.key} (relative key)` : `note ${entry.note}`);
    const name = this.lowerNames[row]!; const hay = this.hay[row]!;
    for (const [index, word] of naming.entries()) {
      if (name.includes(word)) why.push(`“${word}” in its name`);
      else if (hay.includes(word)) why.push(`in a “${word}” folder`);
      else if (classOf[index] && entry.class === classOf[index]) why.push(`a ${entry.class} by its ${entry.classFrom === "sound" ? "sound" : "folder"}`);
    }
    return why;
  }

  /** A vector as this library's measurements are scaled. */
  private normalized(vector: readonly number[]): Float32Array {
    const out = new Float32Array(VECTOR_LENGTH);
    for (let dimension = 0; dimension < VECTOR_LENGTH; dimension++) out[dimension] = ((vector[dimension] ?? 0) - this.mean[dimension]!) * this.scale[dimension]!;
    return out;
  }

  /** How a close sound still differs, in a few words: brighter, a slower attack, longer. */
  private differences(entry: SoundEntry, like: NonNullable<SoundQuery["like"]>): string {
    const notes: string[] = [];
    if (entry.brightness !== undefined && like.brightness > 0) {
      const ratio = entry.brightness / like.brightness;
      if (ratio > 1.3) notes.push("brighter"); else if (ratio < 0.77) notes.push("darker");
    }
    if (entry.attack !== undefined && Math.abs(entry.attack - like.attack) > Math.max(10, like.attack)) notes.push(entry.attack > like.attack ? "a slower attack" : "a faster attack");
    if (entry.seconds !== undefined && like.seconds > 0) { const ratio = entry.seconds / like.seconds; if (ratio > 1.6) notes.push("longer"); else if (ratio < 0.6) notes.push("shorter"); }
    return notes.length ? ` (${notes.join(", ")})` : "";
  }
}

/** Names in the order a person sorts them ("Kick 2" before "Kick 10"). */
const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The best `limit` by `compare`, without sorting everything. */
function topBy<T>(items: T[], limit: number, compare: (a: T, b: T) => number): T[] {
  if (items.length <= limit * 4) return items.sort(compare).slice(0, limit);
  const kept: T[] = [];
  for (const item of items) {
    if (kept.length < limit) { kept.push(item); if (kept.length === limit) kept.sort(compare); continue; }
    if (compare(item, kept[limit - 1]!) >= 0) continue;
    let low = 0; let high = limit - 1;
    while (low < high) { const middle = (low + high) >> 1; if (compare(item, kept[middle]!) < 0) high = middle; else low = middle + 1; }
    kept.splice(low, 0, item); kept.pop();
  }
  return kept;
}

export interface PresetQuery { words?: readonly string[]; device?: string; category?: string; limit: number }
export interface PresetHit { entry: PresetEntry; score: number; why: string[] }

/** Presets by name, folder, device and kind; the producer's own first. */
export function searchPresets(entries: Iterable<PresetEntry>, query: PresetQuery): { hits: PresetHit[]; matched: number } {
  const words = (query.words ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const device = query.device?.trim().toLowerCase();
  const found: PresetHit[] = [];
  for (const entry of entries) {
    if (query.category && entry.category !== query.category) continue;
    const deviceName = (entry.device ?? "").toLowerCase();
    if (device && !deviceName.includes(device) && !(entry.inside ?? []).some((inner) => inner.toLowerCase().includes(device))) continue;
    const name = entry.name.toLowerCase();
    const hay = `${entry.source}/${entry.folder}/${entry.name} ${entry.device ?? ""} ${entry.about ?? ""}`.toLowerCase();
    let score = entry.source === "User Library" ? 2 : 0; const why: string[] = [];
    let missing = false;
    for (const word of words) {
      if (!hay.includes(word)) { missing = true; break; }
      if (name.startsWith(word)) { score += 10; why.push(`“${word}” in its name`); } else if (name.includes(word)) { score += 5; why.push(`“${word}” in its name`); }
      else if (deviceName.includes(word)) { score += 4; why.push(`a ${entry.device} preset`); } else why.push(`“${word}” in its folder or notes`);
    }
    if (missing) continue;
    if (device) { score += deviceName === device ? 6 : 3; why.push(deviceName.includes(device) ? `a ${entry.device} preset` : `a rack with ${query.device}`); }
    found.push({ entry, score, why });
  }
  return { matched: found.length, hits: topBy(found, query.limit, (a, b) => b.score - a.score || NAMES.compare(a.entry.name, b.entry.name)) };
}

export interface SetQuery { words?: readonly string[]; minTempo?: number; maxTempo?: number; key?: string; limit: number }
export interface SetHit { entry: SetEntry & { set: SetSummary }; score: number; why: string[] }

/** Words found in a Set: its name, its tracks', its devices' and plug-ins', its samples'. */
function setWords(set: SetSummary): { where: string; text: string }[] {
  const all = [...set.tracks, ...set.returns, ...(set.main ? [set.main] : [])];
  return [
    { where: "its name", text: set.name },
    ...all.map((track) => ({ where: `track “${track.name}”`, text: track.name })),
    ...all.flatMap((track) => track.devices.flatMap((device) => [device.name, device.preset ?? "", ...(device.inside ?? [])].filter(Boolean).map((text) => ({ where: `“${track.name}” has ${device.preset ? `${device.preset} (${device.name})` : device.name}`, text })))),
    ...all.flatMap((track) => (track.plugins ?? []).map((text) => ({ where: `“${track.name}” has ${text}`, text }))),
    ...all.flatMap((track) => track.samples.map((file) => ({ where: `“${track.name}” plays ${basename(file)}`, text: basename(file) }))),
  ];
}

/** The producer's Sets by words, tempo and key; newest first among equals. */
export function searchSets(entries: Iterable<SetEntry>, query: SetQuery): { hits: SetHit[]; matched: number } {
  const words = (query.words ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const key = query.key ? parseKey(query.key) ?? query.key : undefined;
  const found: SetHit[] = [];
  for (const entry of entries) {
    const set = entry.set;
    if (!set) continue;
    if (query.minTempo !== undefined && (set.tempo === undefined || set.tempo < query.minTempo)) continue;
    if (query.maxTempo !== undefined && (set.tempo === undefined || set.tempo > query.maxTempo)) continue;
    if (key && set.key !== key) continue;
    const texts = words.length ? setWords(set) : [];
    let score = 0; const why: string[] = []; let missing = false;
    for (const word of words) {
      const hit = texts.find((item) => item.text.toLowerCase().includes(word));
      if (!hit) { missing = true; break; }
      score += hit.where === "its name" ? 10 : hit.where.startsWith("track") ? 6 : 3;
      if (!why.includes(hit.where)) why.push(hit.where === "its name" ? `“${word}” in its name` : hit.where);
    }
    if (missing) continue;
    found.push({ entry: entry as SetHit["entry"], score, why });
  }
  return { matched: found.length, hits: topBy(found, query.limit, (a, b) => b.score - a.score || b.entry.mtime - a.entry.mtime) };
}

/** A track as the model reads it: its job, chain, colour and what it plays. */
export function describeTrack(track: SetTrack): Record<string, unknown> {
  const role = trackRole(track);
  return { name: track.name, kind: track.kind, ...(role ? { role } : {}), ...(track.group ? { group: track.group } : {}),
    ...(track.color !== undefined ? { colour: `${colourName(track.color) ?? "colour"} (colour ${track.color})` } : {}),
    devices: track.devices.map((device) => `${device.preset ? `${device.preset} (${device.name})` : device.name}${device.plugin && device.plugin !== "Max for Live" ? ` [${device.plugin}]` : ""}${device.inside?.length ? `: ${device.inside.join(", ")}` : ""}`),
    clips: track.clips, ...(track.samples.length ? { samples: track.samples.slice(0, 12) } : {}), ...(track.frozen ? { frozen: true } : {}) };
}

/** Kept here so search words and learned classes agree on what a word names. */
export const classForWord = (word: string): SoundClass | undefined => CLASS_WORDS.get(plainWord(word));
export const isDescriptor = (word: string) => Boolean(DESCRIPTORS[plainWord(word)]);
export { tokens };
