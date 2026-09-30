/**
 * Auditioning: Kumi renders what it built (one track, or several candidates in one pass), listens,
 * and sets it against a reference, in one call. The render is silent: Main goes to -inf while Live
 * records each source's Post FX onto a scratch track, and comes back exactly, whatever happens.
 * What's here is what doesn't need Live: the tool's shape, the arithmetic of a render, and the file
 * that puts Main back after a crash.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Analysis } from "../../audio/analyze.js";
import { MIX_CANDIDATE, type AuditionCandidate, type AuditionRequest, type JsonObject } from "../../core/contracts.js";

export type { AuditionCandidate, AuditionRequest, AuditionResult, AuditionTake } from "../../core/contracts.js";

export const AUDITION_TOOL = "audition";

export const AUDITION_DESCRIPTION = [
  "Hear what you built, quietly, and how close it is to a reference, in one call: Kumi renders each candidate track (its Post FX, so its devices are in it) onto a scratch track with Main silenced,",
  "listens, compares with the reference, then removes the scratch tracks and puts everything back. Up to 8 candidates render together in one real-time pass, so try several ideas at once (different instruments, chains, settings on separate tracks).",
  "Say where the part is: from_beat and beats in the Arrangement, or a Session clip per candidate (clip), which Kumi plays from the Arrangement for the render and removes after.",
  "A candidate can be the whole mix ({\"mix\": true}, on its own): what Main plays at from_beat, recorded as quietly as a track (through Resampling); audition it against a reference to match a mix, changing EQ, compression and levels between rounds.",
  "Returns each candidate's closeness to the reference (0–100) with the biggest gaps in words, and what it heard. A silent render is reported, not compared. Without a reference it only listens.",
].join(" ");

const REF = { type: "string", minLength: 1, maxLength: 256 } as const;
export const AUDITION_SCHEMA: JsonObject = { type: "object", additionalProperties: false, required: ["candidates"], properties: {
  candidates: { type: "array", minItems: 1, maxItems: 8, description: "The tracks to render, each on its own (a candidate sound, or the track to check), or the whole mix", items: { type: "object", additionalProperties: false, properties: {
    track: REF, mix: { type: "boolean", description: "true: the whole mix (Main's output) instead of a track" },
    clip: { ...REF, description: "A Session clip on that track to play (its clipRef); left out, the Arrangement at from_beat" },
    label: { type: "string", minLength: 1, maxLength: 60, description: "A short name for it (\"Collision + parallel delay\")" } } } },
  from_beat: { type: "number", minimum: 0, description: "Where the part starts in the Arrangement, in beats (a 4/4 bar is 4)" },
  beats: { type: "number", exclusiveMinimum: 0, maximum: 64, description: "How long to render, in beats; a clip's length when left out, 8 at most by default" },
  reference: { type: "string", minLength: 1, maxLength: 1024, description: "What to match: an audio file's path or ~/…, or an audio clip's clipRef" },
  reference_from_seconds: { type: "number", minimum: 0, description: "Where in the reference the part is" },
  reference_seconds: { type: "number", exclusiveMinimum: 0, maximum: 120, description: "How much of the reference to hear" },
  focus: { type: "string", enum: ["sound", "section"], description: "sound: one patch or hit (timbre, envelope, pitch); section: a part or mix (balance, density, rhythm too). Left out, by length" },
} };

/** The model's input as a request; a string says what's wrong. */
export function auditionRequest(input: JsonObject): AuditionRequest | string {
  const raw = Array.isArray(input.candidates) ? input.candidates : [];
  const candidates: AuditionCandidate[] = [];
  for (const item of raw) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const label = typeof row.label === "string" && row.label.trim() ? { label: row.label.trim().slice(0, 60) } : {};
    if (row.mix === true) {
      if (row.track !== undefined || row.clip !== undefined) return "A mix candidate is the whole mix: give it no track or clip.";
      candidates.push({ track: MIX_CANDIDATE, mix: true, ...label });
      continue;
    }
    if (typeof row.track !== "string" || !row.track) return "Each candidate needs its track (a trackRef from discovery), or is the whole mix ({\"mix\": true}).";
    candidates.push({ track: row.track, ...(typeof row.clip === "string" && row.clip ? { clip: row.clip } : {}), ...label });
  }
  if (!candidates.length || candidates.length > 8) return "Give 1 to 8 candidates.";
  const mix = candidates.some((candidate) => candidate.mix);
  // The mix is everything Main plays: other candidates rendered in the same pass would play into it.
  if (mix && candidates.length > 1) return "The whole mix renders on its own: every other candidate would play into it. Audition the mix alone (and tracks in another call).";
  if (new Set(candidates.map((candidate) => candidate.track)).size !== candidates.length) return "Each candidate is a track of its own; put ideas on separate tracks to hear them side by side.";
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const fromBeat = number(input.from_beat); const beats = number(input.beats);
  if (fromBeat === undefined && candidates.some((candidate) => !candidate.clip)) return "Say where the part is: from_beat (and beats) in the Arrangement, or a Session clip for each candidate.";
  if (beats !== undefined && !(beats > 0 && beats <= 64)) return "beats is from just above 0 to 64.";
  return { candidates, ...(fromBeat !== undefined ? { fromBeat } : {}), ...(beats !== undefined ? { beats } : {}),
    ...(typeof input.reference === "string" && input.reference.trim() ? { reference: input.reference.trim() } : {}),
    ...(number(input.reference_from_seconds) !== undefined ? { referenceFrom: number(input.reference_from_seconds)! } : {}),
    ...(number(input.reference_seconds) !== undefined ? { referenceSeconds: number(input.reference_seconds)! } : {}),
    ...(input.focus === "sound" || input.focus === "section" ? { focus: input.focus } : mix ? { focus: "section" as const } : {}) };
}

/** A render nothing came through: no measurable loudness, or next to none. */
export function silentRender(analysis: Analysis): boolean {
  const lufs = analysis.loudness.integratedLufs;
  return lufs === null || lufs < -60 || analysis.loudness.samplePeakDbfs < -55;
}

/** How long before the part a pass starts at least: it jumps there while playing, then starts recording, and each step through the bridge takes a second or so. */
const LEAD_IN_SECONDS = 3;

/**
 * Where a render pass plays from and how long it waits, in beats: whole bars of lead-in before the
 * part, at least LEAD_IN_SECONDS of them (twice that for a pass again after one that started late),
 * and a half bar of tail after it (releases and delays ring on). A part too near the Set's start for
 * that plays from the start (position 0).
 */
export function renderSpan(fromBeat: number, beats: number, beatsPerBar: number, tempo: number, longer = false): { position: number; preroll: number; wait: number } {
  const bar = beatsPerBar * 60 / tempo;
  const lead = Math.max(1, Math.ceil(LEAD_IN_SECONDS * (longer ? 2 : 1) / bar)) * beatsPerBar;
  const position = fromBeat > lead ? fromBeat - lead : 0;
  const preroll = fromBeat - position;
  return { position, preroll, wait: preroll + beats + beatsPerBar / 2 };
}

/**
 * What puts Main back after a crash: its level before a render, and which Set, written before Main
 * goes quiet and removed once it's back. On the next start with that Set open, Kumi puts it back.
 */
export interface MainRestore { set: string; path?: string; volume: number; at: number; scratch?: string[] }
export function restoreStore(file: string) {
  return {
    save(value: MainRestore) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); } catch { /* best effort: the render still restores Main itself */ } },
    load(): MainRestore | undefined {
      if (!existsSync(file)) return undefined;
      try {
        const value = JSON.parse(readFileSync(file, "utf8")) as Partial<MainRestore>;
        return typeof value.set === "string" && typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1 && typeof value.at === "number" ? value as MainRestore : undefined;
      } catch { return undefined; }
    },
    clear() { try { rmSync(file, { force: true }); } catch { /* nothing to clear */ } },
  };
}
export type RestoreStore = ReturnType<typeof restoreStore>;
