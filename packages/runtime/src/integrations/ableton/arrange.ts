/**
 * Arranging: the producer's loop, Session scenes or a track's clips laid out as a whole track in the
 * Arrangement. The model gives the form (sections with their bars, the tracks that play in each, gaps,
 * fills and risers); Kumi reads the material, works out every copy and makes them as one change: one
 * line in HISTORY whose undo takes the arrangement back, and one Cmd-Z in Live.
 *
 * Only the Remote Script's changes are used (copies of Session clips, locators, the playhead), because
 * Live's undo step groups those. A part shorter than its clip is a copy of the clip with its loop
 * shortened, made in an empty Session slot of its track, copied where it goes and then taken back.
 * What's here doesn't need Live: the tool's shape, reading the material, the compiler and the run,
 * against a host that reads Live and makes the changes.
 */
import type { JsonObject, ToolResult } from "../../core/contracts.js";

export const ARRANGE_TOOL = "arrange";

export const ARRANGE_DESCRIPTION = [
  "Lay out an arrangement in the Arrangement from the producer's own clips, in one call: the sections in order, each with its name, its length in bars and the tracks that play in it,",
  "from Session scenes (a section plays a scene's clips, or chosen clips per track). Kumi copies the clips (whole loops, and a loop's first part where a section ends sooner), adds the gaps, fills and risers asked for,",
  "marks each section with a locator and puts the playhead at the start. It's one change: one line in HISTORY whose undo takes it all back, and one Cmd-Z in Live.",
  "Without sections it changes nothing and returns the material to plan with: each scene's clips by track with their lengths, where the Arrangement's clips end, and its locators.",
  "Vary it by subtraction and addition: tracks in and out per section; gap: tracks drop out for the last beats before the next section (the breath before a drop);",
  "fill: a track's other clip (its fill or a variation) in place of the loop's end; riser: a clip on an effects track (a riser, a sweep, a crash) placed to end where the section ends.",
].join(" ");

const TRACK = { type: "string", minLength: 1, maxLength: 256, description: "A track's name, or its ref" } as const;
const SCENE = { type: "integer", minimum: 0, maximum: 100000 } as const;
const CLIP = { type: "object", additionalProperties: false, required: ["track", "scene"], properties: { track: TRACK, scene: { ...SCENE, description: "The scene its clip is in (0 is the first)" } } } as const;
export const ARRANGE_SCHEMA: JsonObject = { type: "object", additionalProperties: false, properties: {
  sections: { type: "array", minItems: 1, maxItems: 64, description: "The form, in order. Left out, nothing changes and the material comes back", items: { type: "object", additionalProperties: false, required: ["name", "bars"], properties: {
    name: { type: "string", minLength: 1, maxLength: 48, description: "Its name, for its locator: Intro, Verse, Build, Drop, Break, Outro…" },
    bars: { type: "integer", minimum: 1, maximum: 512 },
    scene: { ...SCENE, description: "The scene whose clips play here (0 is the first); left out, the arrangement's scene" },
    tracks: { type: "array", maxItems: 256, description: "The tracks that play, each with its clip in this section's scene, or {track, scene} for another of its clips; [] is silence. Left out, every track with a clip in the scene", items: { anyOf: [TRACK, CLIP] } },
    gap: { type: "object", additionalProperties: false, required: ["beats"], description: "Tracks stop this many beats before the section ends", properties: {
      beats: { type: "number", minimum: 0.25, maximum: 64 }, tracks: { type: "array", maxItems: 256, items: TRACK, description: "Which; left out, every track that plays" } } },
    fill: { type: "array", maxItems: 32, items: CLIP, description: "A track's other clip, played at the section's end in place of the loop's end" },
    riser: { ...CLIP, description: "A clip on a track that doesn't play here (an effects track), placed to end where the section ends" },
  } } },
  scene: { ...SCENE, description: "The scene a section plays when it names none; left out, the first scene with clips" },
  start_bar: { type: "integer", minimum: 1, maximum: 10000, description: "Where the arrangement starts; left out, after the clips already in the Arrangement" },
  final: { type: "boolean", description: "The arrangement completes the request: Kumi says what it built and you aren't called again" },
} };

/** A track's clip, by the scene it's in (the section's scene when left out). */
export interface ClipChoice { track: string; scene?: number }
export interface SectionRequest { name: string; bars: number; scene?: number; tracks?: ClipChoice[]; gap?: { beats: number; tracks?: string[] }; fill: ClipChoice[]; riser?: ClipChoice }
export interface ArrangeRequest { sections: SectionRequest[]; scene?: number; startBar?: number; final: boolean }

const record = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const integer = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** A hair, in beats: positions are sums of bar lengths, and Live's own numbers come back as floats. */
const EPSILON = 1e-6;
/** The shortest part worth placing: a sixteenth. */
const SHORTEST = 0.25;
/** How many Session clips Kumi reads to arrange (a huge Session's others aren't needed). */
const MOST_CLIPS = 512;

/** The model's input as a request; a string says what's wrong. */
export function arrangeRequest(input: JsonObject): ArrangeRequest | string {
  const choice = (value: unknown, where: string): ClipChoice | string => {
    if (typeof value === "string") return text(value) ? { track: value.trim() } : `${where}: name the track.`;
    const row = record(value); const track = text(row.track);
    if (!track) return `${where}: give the track (its name or ref) and the scene its clip is in.`;
    return { track, ...(integer(row.scene) !== undefined ? { scene: integer(row.scene)! } : {}) };
  };
  const sections: SectionRequest[] = [];
  const given = input.sections === undefined ? [] : Array.isArray(input.sections) ? input.sections : undefined;
  if (!given) return "sections is a list: each section's name and bars, and which tracks play.";
  for (const [index, raw] of given.entries()) {
    const row = record(raw); const where = `Section ${index + 1}`;
    const name = text(row.name); const length = integer(row.bars);
    if (!name || !length) return `${where}: give its name and its length in bars (a whole number).`;
    const section: SectionRequest = { name: name.slice(0, 48), bars: length, fill: [] };
    if (integer(row.scene) !== undefined) section.scene = integer(row.scene)!;
    if (row.tracks !== undefined) {
      if (!Array.isArray(row.tracks)) return `${where}: tracks is a list of track names (or {track, scene}).`;
      const tracks: ClipChoice[] = [];
      for (const item of row.tracks) { const parsed = choice(item, where); if (typeof parsed === "string") return parsed; tracks.push(parsed); }
      section.tracks = tracks;
    }
    if (row.gap !== undefined) {
      const gap = record(row.gap); const beats = typeof gap.beats === "number" && Number.isFinite(gap.beats) && gap.beats > 0 ? gap.beats : undefined;
      if (!beats) return `${where}: a gap is how many beats before the section's end the tracks stop (beats).`;
      const names = Array.isArray(gap.tracks) ? gap.tracks.map(text).filter((item): item is string => Boolean(item)) : undefined;
      section.gap = { beats, ...(names ? { tracks: names } : {}) };
    }
    for (const item of Array.isArray(row.fill) ? row.fill : row.fill === undefined ? [] : [row.fill]) {
      const parsed = choice(item, `${where}'s fill`); if (typeof parsed === "string") return parsed;
      if (parsed.scene === undefined) return `${where}'s fill: say which scene the fill's clip is in.`;
      section.fill.push(parsed);
    }
    if (row.riser !== undefined) {
      const parsed = choice(row.riser, `${where}'s riser`); if (typeof parsed === "string") return parsed;
      if (parsed.scene === undefined) return `${where}'s riser: say which scene the riser's clip is in.`;
      section.riser = parsed;
    }
    sections.push(section);
  }
  return { sections, final: input.final === true, ...(integer(input.scene) !== undefined ? { scene: integer(input.scene)! } : {}),
    ...(integer(input.start_bar) ? { startBar: integer(input.start_bar)! } : {}) };
}

/** A Session clip as Kumi places it: its length in beats (its loop's, when it loops) and where its loop starts. */
export interface SourceClip { ref: string; name: string; beats: number; loopStart: number; audio: boolean; scene: number; /** Its loop can be shortened: MIDI, or warped audio. */ shortens: boolean }
export interface SourceTrack { ref: string; name: string; clips: SourceClip[]; /** Its clips in the Arrangement, start and end in beats. */ busy: [number, number][]; /** Scenes whose slot on it is empty. */ empty: number[] }
export interface Material {
  beatsPerBar: number; tempo?: number;
  tracks: SourceTrack[]; scenes: { index: number; name: string }[]; locators: { name: string; position: number }[];
  /** Where the Arrangement's last clip ends, in beats (0 when it's empty). */
  end: number;
  /** Live is playing: locators can't be added (the playhead would jump) and the playhead stays where it is. */
  playing: boolean;
  /** Session clips some tracks play now, which keep them from playing the Arrangement until Back to Arrangement. */
  sessionPlaying: boolean;
  /** Clips not read (a huge Session), so not offered. */
  unread: number;
}

/** What arranging needs from Live: reads, quiet changes and their undo, Live's undo step, HISTORY's line. */
export interface ArrangeHost {
  tempo(): number | undefined;
  beatsPerBar(): number;
  /** Every row of a kind (under `parent`), read fresh: references usable in this answer's changes. */
  read(kind: string, extra: JsonObject, signal: AbortSignal): Promise<JsonObject[]>;
  /** Whether this change tool can be used now: the bridge offers it and is new enough. */
  offers(tool: string): boolean;
  /** A change as its tool makes it: its id and what it made. Throws why it failed. */
  change(tool: string, input: JsonObject, signal: AbortSignal): Promise<{ id: string; ref?: string }>;
  /** Kumi's own undo of one of those changes: true when it's undone. */
  undo(id: string, signal: AbortSignal): Promise<boolean>;
  /** Changes made in `work` stay out of HISTORY (the arrangement gets one line): their ids, failed or not. */
  quietly<T>(work: () => Promise<T>): Promise<{ value: T; ids: string[] }>;
  /** HISTORY's one line for these changes, undone together, latest first (but those `apart`, which aren't kept): its id. */
  record(title: string, ids: readonly string[], apart?: readonly string[]): string | undefined;
  /** Live's undo step around what follows, so one Cmd-Z takes it back (where the bridge has one): its close. */
  undoStep(): Promise<{ opened: boolean; close: () => Promise<void> }>;
  /** A copy of the Set as last saved, before a big change: its file, when Kumi made one. */
  keepCopy(signal: AbortSignal): Promise<string | undefined>;
  /** NOW: what Kumi is doing. */
  tell(title: string): void;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The material, read fresh: the tracks with their Session clips, the scenes, the Arrangement's clips and locators. */
export async function readMaterial(host: ArrangeHost, signal: AbortSignal): Promise<Material> {
  // Reads that don't depend on each other go to Live together: they share its display ticks.
  const [sets, trackRows, sceneRows, locatorRows] = await Promise.all([
    host.read("set", { fields: ["playing"] }, signal), host.read("track", { fields: ["name", "kind", "playingSlotIndex"] }, signal),
    host.read("scene", { fields: ["name", "index"] }, signal), host.read("locator", { fields: ["name", "position"] }, signal).catch(() => [] as JsonObject[])]);
  // A group track holds no clips of its own.
  const tracks = trackRows.filter((row) => typeof row.ref === "string" && row.kind !== "group");
  const [slotRows, arrangementRows] = await Promise.all([
    Promise.all(tracks.map((track) => host.read("clip-slot", { parent: track.ref, fields: ["sceneIndex", "clipRef"] }, signal))),
    Promise.all(tracks.map((track) => host.read("arrangement-clip", { parent: track.ref, fields: ["start", "endTime", "length"] }, signal).catch(() => [] as JsonObject[])))]);
  const filled = slotRows.flatMap((slots, index) => slots.filter((slot) => typeof slot.clipRef === "string" && typeof slot.ref === "string").map((slot) => ({ index, slot })));
  const clipRows = await Promise.all(filled.slice(0, MOST_CLIPS).map(({ slot }) =>
    host.read("session-clip", { parent: slot.ref, fields: ["name", "length", "looping", "loopStart", "isAudio", "warping"] }, signal).then((rows) => rows[0])));
  const sources: SourceTrack[] = tracks.map((track, index) => {
    const slots = slotRows[index] ?? [];
    const busy = (arrangementRows[index] ?? []).flatMap((row): [number, number][] => {
      const start = number(row.start); const end = number(row.endTime) ?? (start !== undefined ? start + (number(row.length) ?? 0) : undefined);
      return start !== undefined && end !== undefined ? [[start, end]] : [];
    });
    return { ref: String(track.ref), name: typeof track.name === "string" ? track.name.slice(0, 120) : `Track ${index + 1}`, busy, clips: [],
      empty: slots.filter((slot) => typeof slot.clipRef !== "string" && integer(slot.sceneIndex) !== undefined).map((slot) => integer(slot.sceneIndex)!) };
  });
  for (const [at, { index, slot }] of filled.slice(0, MOST_CLIPS).entries()) {
    const clip = clipRows[at]; const beats = number(clip?.length); const scene = integer(slot.sceneIndex);
    if (!clip || typeof clip.ref !== "string" || !beats || beats <= 0 || scene === undefined) continue;
    const audio = clip.isAudio === true;
    sources[index]!.clips.push({ ref: clip.ref, name: typeof clip.name === "string" ? clip.name.slice(0, 120) : "", beats, loopStart: number(clip.loopStart) ?? 0, audio, scene, shortens: !audio || clip.warping === true });
  }
  const set = sets[0] ?? {};
  return {
    beatsPerBar: host.beatsPerBar(), ...(host.tempo() ? { tempo: host.tempo()! } : {}), tracks: sources,
    scenes: sceneRows.map((row, index) => ({ index: integer(row.index) ?? index, name: typeof row.name === "string" ? row.name.slice(0, 120) : "" })),
    locators: locatorRows.flatMap((row) => (number(row.position) !== undefined ? [{ name: typeof row.name === "string" ? row.name : "", position: number(row.position)! }] : [])),
    end: Math.max(0, ...sources.flatMap((track) => track.busy.map(([, end]) => end))),
    playing: set.playing === true, sessionPlaying: tracks.some((track) => integer(track.playingSlotIndex) !== undefined),
    unread: Math.max(0, filled.length - MOST_CLIPS),
  };
}

/** Where something goes: a clip (whole, or its loop's first `beats` when shorter) at a position. */
export interface Placement { track: SourceTrack; clip: SourceClip; at: number; beats: number; section: number; role?: "fill" | "riser" }
export interface PlannedSection { name: string; from: number; to: number; tracks: string[]; everything: boolean; extras: string[] }
export interface Plan { start: number; end: number; beatsPerBar: number; tempo?: number; sections: PlannedSection[]; placements: Placement[]; locators: { name: string; position: number }[]; notes: string[] }

export const isPart = (placement: Placement) => placement.beats < placement.clip.beats - EPSILON;

/**
 * The form as placements: each track's clip repeated through its section (the last copy only as much of
 * the loop as fits), fills at a section's end, risers ending with it, and a locator at each section's
 * start. `shortens` says whether a loop can be shortened for a part (Live offers the clip edits);
 * without, a part is left out and said. A string refuses, before anything changes.
 */
export function compile(material: Material, request: ArrangeRequest, shortens: { midi: boolean; audio: boolean }): Plan | string {
  const bpb = material.beatsPerBar;
  const bar = (beats: number) => Math.round((beats / bpb + 1) * 100) / 100;
  const find = (named: string): SourceTrack | string => {
    const byRef = material.tracks.find((track) => track.ref === named);
    if (byRef) return byRef;
    const matches = material.tracks.filter((track) => track.name.trim().toLowerCase() === named.trim().toLowerCase());
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return `Several tracks are called ${JSON.stringify(named)}: name each by its ref (${matches.map((track) => track.ref).join(", ")}).`;
    return `There's no track called ${JSON.stringify(named)}. Tracks with clips: ${material.tracks.filter((track) => track.clips.length).map((track) => track.name).slice(0, 32).join(", ") || "none"}.`;
  };
  const withClips = material.tracks.filter((track) => track.clips.length);
  if (!withClips.length) return "There are no clips in the Session to arrange: record or write the loop into Session clips first.";
  const defaultScene = request.scene ?? Math.min(...withClips.flatMap((track) => track.clips.map((clip) => clip.scene)));
  const start = request.startBar !== undefined ? (request.startBar - 1) * bpb : Math.max(0, Math.ceil(material.end / bpb - EPSILON)) * bpb;
  const placements: Placement[] = []; const sections: PlannedSection[] = []; const notes: string[] = [];
  // Section names are their locators' too, and Live's locators can't share one: each name is new ("Drop 2").
  const taken = new Set(material.locators.map((locator) => locator.name));
  const unique = (name: string) => { let candidate = name; for (let count = 2; taken.has(candidate); count++) candidate = `${name} ${count}`; taken.add(candidate); return candidate; };
  let from = start;
  for (const [index, section] of request.sections.entries()) {
    const to = from + section.bars * bpb;
    const scene = section.scene ?? defaultScene;
    const name = unique(section.name);
    const plays: { track: SourceTrack; clip: SourceClip }[] = [];
    const everything = section.tracks === undefined;
    if (everything) {
      for (const track of material.tracks) { const clip = track.clips.find((item) => item.scene === scene); if (clip) plays.push({ track, clip }); }
      if (!plays.length) return `Scene ${scene + 1} has no clips, so ${name} would be empty: name the tracks that play, or another scene.`;
    } else {
      for (const choice of section.tracks!) {
        const track = find(choice.track); if (typeof track === "string") return `${name}: ${track}`;
        // A track named to play whose only clip is in another scene plays that one.
        const clip = track.clips.find((item) => item.scene === (choice.scene ?? scene)) ?? (choice.scene === undefined && track.clips.length === 1 ? track.clips[0] : undefined);
        if (!clip) { notes.push(`${track.name} has no clip in scene ${(choice.scene ?? scene) + 1}, so it doesn't play in ${name}.`); continue; }
        if (plays.some((item) => item.track === track)) return `${name}: ${track.name} is named twice; a track plays one clip at a time.`;
        plays.push({ track, clip });
      }
    }
    const extras: string[] = [];
    const gapped = new Set<SourceTrack>();
    if (section.gap) {
      if (section.gap.beats >= section.bars * bpb) return `${name}: its gap (${section.gap.beats} beats) is as long as the section.`;
      for (const which of section.gap.tracks ?? plays.map((item) => item.track.ref)) { const track = find(which); if (typeof track === "string") return `${name}'s gap: ${track}`; gapped.add(track); }
      const who = [...gapped].filter((track) => plays.some((item) => item.track === track));
      if (who.length) extras.push(`${who.length === plays.length ? "everything" : who.map((track) => track.name).join(", ")} out for the last ${section.gap.beats === bpb ? "bar" : section.gap.beats % bpb === 0 ? `${section.gap.beats / bpb} bars` : `${section.gap.beats} beat${section.gap.beats === 1 ? "" : "s"}`}`);
    }
    const fills = new Map<SourceTrack, SourceClip>();
    for (const fill of section.fill) {
      const track = find(fill.track); if (typeof track === "string") return `${name}'s fill: ${track}`;
      const clip = track.clips.find((item) => item.scene === fill.scene);
      if (!clip) return `${name}'s fill: ${track.name} has no clip in scene ${fill.scene! + 1}.`;
      fills.set(track, clip);
    }
    // Each track: its fill at the end (before a gap), its loop repeated up to there.
    const tracks = [...new Set([...plays.map((item) => item.track), ...fills.keys()])];
    for (const track of tracks) {
      let end = to - (gapped.has(track) && section.gap ? section.gap.beats : 0);
      const fill = fills.get(track);
      if (fill) {
        if (fill.beats > end - from + EPSILON) notes.push(`${track.name}'s fill (${fill.beats} beats) is longer than ${name} leaves it, so Kumi left it out.`);
        else { end -= fill.beats; placements.push({ track, clip: fill, at: end, beats: fill.beats, section: index, role: "fill" }); extras.push(`${track.name} fill at the end`); }
      }
      const clip = plays.find((item) => item.track === track)?.clip;
      if (!clip) continue;
      for (let at = from; at < end - EPSILON; at += clip.beats) {
        const beats = Math.min(clip.beats, end - at);
        if (beats < clip.beats - EPSILON) {
          if (beats < SHORTEST) break;
          if (!clip.shortens || !(clip.audio ? shortens.audio : shortens.midi)) {
            notes.push(`${track.name}'s clip (${clip.beats} beats) doesn't fit ${name}'s end evenly and Live can't shorten ${clip.audio ? "this audio clip (it isn't warped)" : "its loop here"}, so its last ${beats} beats are left empty.`);
            break;
          }
        }
        placements.push({ track, clip, at, beats, section: index });
      }
    }
    if (section.riser) {
      const track = find(section.riser.track); if (typeof track === "string") return `${name}'s riser: ${track}`;
      const clip = track.clips.find((item) => item.scene === section.riser!.scene);
      if (!clip) return `${name}'s riser: ${track.name} has no clip in scene ${section.riser.scene! + 1}.`;
      if (to - clip.beats < start - EPSILON) notes.push(`${track.name}'s riser (${clip.beats} beats) would start before the arrangement does, so Kumi left it out of ${name}.`);
      else { placements.push({ track, clip, at: to - clip.beats, beats: clip.beats, section: index, role: "riser" }); extras.push(`${track.name} rises into what follows`); }
    }
    sections.push({ name, from, to, tracks: plays.map((item) => item.track.name), everything, extras });
    from = to;
  }
  const end = from;
  // Clips on one track can't overlap: not each other, nor what's in the Arrangement already.
  for (const track of material.tracks) {
    const mine = placements.filter((item) => item.track === track).sort((a, b) => a.at - b.at);
    for (const [index, placement] of mine.entries()) {
      const before = mine[index - 1];
      if (before && placement.at < before.at + before.beats - EPSILON) {
        const what = (item: Placement) => item.role ? `its ${item.role}` : "its loop";
        return `${track.name} would play two clips at once at bar ${bar(placement.at)} (${what(before)} and ${what(placement)}): give a riser a track of its own, and fills to tracks that play.`;
      }
      const clash = track.busy.find(([from, to]) => placement.at < to - EPSILON && from < placement.at + placement.beats - EPSILON);
      if (clash) return `${track.name} already has a clip in the Arrangement at bar ${bar(clash[0])}, where this arrangement would go: start it after what's there (start_bar ${Math.ceil(material.end / bpb - EPSILON) + 1}), or clear that stretch first.`;
    }
  }
  // A locator at each section's start. Live's are made in pairs here: an odd one out gets "End" with it.
  const marked = (position: number) => material.locators.some((locator) => Math.abs(locator.position - position) < EPSILON);
  const locators = sections.filter((section) => !marked(section.from)).map((section) => ({ name: section.name, position: section.from }));
  if (locators.length < sections.length) notes.push(`Locators already mark ${sections.length - locators.length === 1 ? "one of the sections' starts" : "some of the sections' starts"}, so Kumi left those as they are.`);
  if (locators.length % 2) { if (!marked(end)) locators.push({ name: unique("End"), position: end }); else locators.pop(); }
  return { start, end, beatsPerBar: bpb, ...(material.tempo ? { tempo: material.tempo } : {}), sections,
    placements: placements.sort((a, b) => a.at - b.at || material.tracks.indexOf(a.track) - material.tracks.indexOf(b.track)), locators, notes };
}

/** What a run made, and where it stopped if it did (the section it was in, and why). */
export interface Built { copies: number; parts: number; locators: number; /** The playhead's move: not undone with the rest (it isn't part of the Set). */ playhead?: string; opened: boolean; stopped?: string; stoppedIn?: string; notes: string[] }

/** Each part of a loop, made once in the Session and copied to every place it goes. */
function partsByClip(placements: readonly Placement[]): Placement[][] {
  const groups = new Map<string, Placement[]>();
  for (const placement of placements.filter(isPart)) {
    const key = `${placement.clip.ref}|${placement.beats}`;
    groups.set(key, [...(groups.get(key) ?? []), placement]);
  }
  return [...groups.values()];
}

/**
 * The run: the whole copies in time order, then the parts, then the locators and the playhead, all inside
 * one undo step in Live. A change that fails stops it; what was made stays (HISTORY's line takes it back),
 * and a shortened copy in the Session is always taken back.
 */
export async function build(plan: Plan, material: Material, host: ArrangeHost, signal: AbortSignal): Promise<Built> {
  const built: Built = { copies: 0, parts: 0, locators: 0, opened: false, notes: [] };
  const step = await host.undoStep();
  built.opened = step.opened;
  // The Session copies a part is made from, and a scene added for them: taken back latest first.
  const scratch: { id: string; what: string }[] = [];
  let scene: { id: string; index: number } | undefined;
  // Taking back runs to the end even when the answer is stopped: a copy left behind would be a surprise.
  const settle = () => AbortSignal.timeout(30_000);
  const takeBack = async () => {
    for (const item of scratch.splice(0).reverse()) if (!await host.undo(item.id, settle()).catch(() => false)) built.notes.push(item.what);
  };
  let current = -1;
  const progress = (placement: Placement) => {
    if (placement.section === current) return;
    current = placement.section; const section = plan.sections[current]!;
    host.tell(`Arranging · ${section.name}, bar ${Math.round(section.from / plan.beatsPerBar) + 1}`);
  };
  try {
    for (const placement of plan.placements.filter((item) => !isPart(item))) {
      signal.throwIfAborted(); progress(placement);
      await host.change("duplicate_clip", { clipRef: placement.clip.ref, arrangementPosition: placement.at }, signal);
      built.copies++;
    }
    const parts = partsByClip(plan.placements);
    if (parts.length) host.tell("Arranging · the shorter parts");
    for (const group of parts) {
      signal.throwIfAborted();
      const { track, clip, beats } = group[0]!;
      // An empty slot on the clip's track (a copy goes into the Arrangement on its own track), or a new scene's.
      let slot = track.empty.find((index) => index !== scene?.index);
      if (slot === undefined) {
        if (!scene) {
          const made = await host.change("add_tracks_and_scenes", { scenes: [{ name: "Kumi parts" }] }, signal);
          scene = { id: made.id, index: material.scenes.length };
        }
        slot = scene.index;
      }
      const copy = await host.change("duplicate_clip", { clipRef: clip.ref, targetTrackRef: track.ref, targetSceneIndex: slot }, signal);
      scratch.push({ id: copy.id, what: `A copy of ${clip.name ? `“${clip.name}”` : `${track.name}'s clip`} Kumi shortened is still in ${track.name}, scene ${slot + 1}: delete it in Live.` });
      if (!copy.ref) throw new Error("Live didn't say where the copy went");
      const loop = await host.change(clip.audio ? "set_audio_clip" : "set_clip", { clipRef: copy.ref, loopEnd: clip.loopStart + beats }, signal);
      scratch.push({ id: loop.id, what: `A copy of ${clip.name ? `“${clip.name}”` : `${track.name}'s clip`} is still shortened in ${track.name}, scene ${slot + 1}: delete it in Live.` });
      for (const placement of group) {
        signal.throwIfAborted(); progress(placement);
        await host.change("duplicate_clip", { clipRef: copy.ref, arrangementPosition: placement.at }, signal);
        built.parts++;
      }
      await takeBack();
    }
    if (scene) { if (await host.undo(scene.id, settle()).catch(() => false)) scene = undefined; }
    // Locators and the playhead would make Live jump while it plays, so they wait for it to stop.
    if (plan.locators.length && material.playing) built.notes.push("Live was playing, so the sections aren't marked with locators: stop, and ask Kumi to mark them.");
    else if (plan.locators.length && !host.offers("set_locators")) built.notes.push("Live doesn't offer adding locators for this Set, so the sections aren't marked.");
    else if (plan.locators.length) {
      host.tell("Arranging · naming the sections");
      for (let index = 0; index + 1 < plan.locators.length; index += 2) {
        const [first, second] = [plan.locators[index]!, plan.locators[index + 1]!];
        try { await host.change("set_locators", { start: first.position, end: second.position, startName: first.name, endName: second.name }, signal); built.locators += 2; }
        catch (error) { signal.throwIfAborted(); built.notes.push(`Live didn't add the locators ${first.name} and ${second.name}: ${message(error)}`); }
      }
    }
    if (!material.playing && host.offers("set_transport")) {
      try { built.playhead = (await host.change("set_transport", { position: plan.start }, signal)).id; } catch { signal.throwIfAborted(); }
    }
  } catch (error) {
    built.stopped = signal.aborted ? "Stopped before it finished." : message(error);
    if (plan.sections[current]) built.stoppedIn = plan.sections[current]!.name;
  } finally {
    await takeBack();
    if (scene && !await host.undo(scene.id, settle()).catch(() => false)) built.notes.push(`The scene Kumi added for its working copies (scene ${scene.index + 1}, “Kumi parts”) is still there: delete it in Live.`);
    await step.close();
  }
  return built;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

/** "bars 1–16" */
function barsOf(plan: Plan, from: number, to: number): string {
  const first = Math.round(from / plan.beatsPerBar) + 1; const last = Math.round(to / plan.beatsPerBar);
  return first === last ? `bar ${first}` : `bars ${first}–${last}`;
}
/** "3:06" */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** A line a section: where it is, what plays and how it moves. */
export function sectionLines(plan: Plan): string[] {
  return plan.sections.map((section) => {
    const plays = !section.tracks.length ? "silence" : section.everything && section.tracks.length > 2 ? "everything"
      : section.tracks.length > 6 ? `${section.tracks.slice(0, 5).join(", ")} and ${section.tracks.length - 5} more` : section.tracks.join(", ");
    return `${section.name}, ${barsOf(plan, section.from, section.to)}: ${plays}${section.extras.length ? `; ${section.extras.join("; ")}` : ""}`;
  });
}

/** The material, for planning: each scene's clips by track with their lengths, the Arrangement's end and locators. */
export function describe(material: Material): JsonObject {
  const bpb = material.beatsPerBar;
  const length = (beats: number) => (Math.abs(beats / bpb - Math.round(beats / bpb)) < EPSILON ? `${Math.round(beats / bpb)} bar${Math.round(beats / bpb) === 1 ? "" : "s"}` : `${Math.round(beats * 100) / 100} beats`);
  const used = material.scenes.filter((scene) => material.tracks.some((track) => track.clips.some((clip) => clip.scene === scene.index)));
  return {
    material: {
      ...(material.tempo ? { tempo: material.tempo } : {}), beatsPerBar: bpb,
      scenes: used.slice(0, 64).map((scene) => ({ scene: scene.index, ...(scene.name ? { name: scene.name } : {}),
        clips: material.tracks.flatMap((track) => track.clips.filter((clip) => clip.scene === scene.index).map((clip) => `${track.name}: ${clip.name ? `“${clip.name}”, ` : ""}${length(clip.beats)}${clip.audio ? ", audio" : ""}`)) })),
      ...(used.length > 64 ? { moreScenes: used.length - 64 } : {}), ...(material.unread ? { clipsNotRead: material.unread } : {}),
      arrangement: material.end > 0 ? { clipsEndAt: `bar ${Math.round(material.end / bpb * 100) / 100 + 1}`, ...(material.locators.length ? { locators: material.locators.slice(0, 32).map((locator) => `${locator.name} at bar ${Math.round(locator.position / bpb * 100) / 100 + 1}`) } : {}) } : { empty: true },
      ...(material.playing ? { playing: true } : {}),
    },
    next: "Call arrange again with the sections: each one's name, bars and the scene or tracks that play, with gaps, fills and risers where they help; it starts after the Arrangement's clips unless start_bar says where.",
  };
}

/** The arrange tool: the material without sections; with them, the arrangement, built as one change. */
export async function arrange(input: JsonObject, host: ArrangeHost, signal: AbortSignal): Promise<ToolResult> {
  const request = arrangeRequest(input);
  if (typeof request === "string") return { text: request, isError: true };
  let material: Material;
  try { material = await readMaterial(host, signal); }
  catch (error) { signal.throwIfAborted(); return { text: `Kumi couldn't read the Set's clips: ${message(error)}`, isError: true }; }
  if (!request.sections.length) return { text: JSON.stringify(describe(material)) };
  const plan = compile(material, request, { midi: host.offers("set_clip"), audio: host.offers("set_audio_clip") });
  if (typeof plan === "string") return { text: plan, isError: true };
  if (!plan.placements.length) return { text: "Those sections place no clips: name tracks with clips in the scenes they play.", isError: true };
  if (!host.offers("duplicate_clip")) return { text: "Live doesn't offer copying clips into the Arrangement for this Set right now.", isError: true };
  const began = Date.now();
  host.tell(`Arranging ${plan.sections.length} sections, ${barsOf(plan, plan.start, plan.end)}`);
  const copy = await host.keepCopy(signal).catch(() => undefined);
  const { value: built, ids } = await host.quietly(() => build(plan, material, host, signal));
  const bars = Math.round((plan.end - plan.start) / plan.beatsPerBar);
  const title = built.stopped ? `Arrangement, stopped${built.stoppedIn ? ` in ${built.stoppedIn}` : ""} · ${built.copies + built.parts} clips from bar ${Math.round(plan.start / plan.beatsPerBar) + 1}`
    : `Arrangement · ${plan.sections.length} sections, ${barsOf(plan, plan.start, plan.end)}`;
  const change = host.record(title, ids, built.playhead ? [built.playhead] : []);
  const lines = sectionLines(plan);
  const length = plan.tempo ? `${clock((plan.end - plan.start) * 60 / plan.tempo)} at ${Math.round(plan.tempo * 100) / 100} BPM` : undefined;
  const notes = [...plan.notes, ...built.notes, ...(material.sessionPlaying ? ["Some tracks are playing Session clips, which keeps them from playing the Arrangement: press Back to Arrangement in Live to hear it."] : [])];
  const result: JsonObject = {
    arranged: { from: `bar ${Math.round(plan.start / plan.beatsPerBar) + 1}`, bars, ...(length ? { length } : {}), sections: lines },
    made: { clips: built.copies + built.parts, locators: built.locators, ...(built.playhead ? { playhead: `bar ${Math.round(plan.start / plan.beatsPerBar) + 1}` } : {}) },
    ...(change ? { change } : {}), seconds: Math.round((Date.now() - began) / 100) / 10,
    ...(notes.length ? { notes } : {}), ...(copy ? { copy, copyNote: "Before this, Kumi kept a copy of the Set as last saved, next to it. Tell the producer in a few words, with the file's name." } : {}),
    ...(built.stopped ? { stopped: built.stopped, note: "What was made stays, as one change in HISTORY whose undo takes it back. Say where it stopped and why." } : {}),
  };
  if (built.stopped) return { text: JSON.stringify(result), isError: true };
  if (!request.final) return { text: JSON.stringify(result) };
  const undo = `Undo in HISTORY takes it all back${built.opened ? " (or one Cmd-Z in Live)" : ""}.`;
  const marked = built.locators ? `Locators mark the sections${built.playhead ? `, and the playhead is at bar ${Math.round(plan.start / plan.beatsPerBar) + 1}` : ""}. ` : built.playhead ? `The playhead is at bar ${Math.round(plan.start / plan.beatsPerBar) + 1}. ` : "";
  const reply = [`Arranged ${bars} bars from bar ${Math.round(plan.start / plan.beatsPerBar) + 1}${length ? ` (${length})` : ""}:`, ...lines.map((line) => `- ${line}`), "",
    `${marked}${undo}`, ...notes, ...(copy ? [`First, Kumi kept a copy of your Set as last saved, next to it: ${copy.split(/[\\/]/).at(-1)}`] : [])].join("\n");
  return { text: JSON.stringify(result), reply };
}
