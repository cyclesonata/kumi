/**
 * Kumi's changes in Live. Each change tool runs the bridge's preview and apply as one step, so
 * the model never handles confirmations or idempotency keys, and each applied change becomes a
 * HISTORY entry with its own undo (the bridge's guarded live_undo). Titles are plain words for
 * producers; names inside them are data.
 */
import type { ChangeFamily, ChangeRecord, JsonObject } from "../../core/contracts.js";

/** A track as Kumi last saw it in discovery, for HISTORY's colour chip. */
export interface KnownTrack { name: string; color?: string }

export interface ChangeSummary {
  title: string;
  track?: KnownTrack;
  from?: number;
  to?: number;
  range?: [number, number];
}

export interface ChangeKind {
  /** The tool the model calls. */
  tool: string;
  preview: string;
  apply: string;
  family: ChangeFamily;
  description: string;
  /** Moves tracks or scenes, so earlier references point elsewhere afterwards. */
  restructures?: boolean;
  /** Adjust the preview's input schema where Kumi's behaviour differs from the bridge's wording. */
  schema?(schema: JsonObject): JsonObject;
  /** `applied` is the bridge's apply result, when there is one: it can carry Live's own text for the new values. */
  summarize(preview: JsonObject, input: JsonObject, track: (ref: unknown) => KnownTrack | undefined, applied?: JsonObject): ChangeSummary;
}

const record = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const label = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined);
const quoted = (value: unknown, fallback: string) => { const text = label(value); return text ? `“${text}”` : fallback; };
export const formatNumber = (value: number, digits = 2) => String(Number(value.toFixed(digits)));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A value stays whole when a line wraps: its number and unit are joined by a no-break space. */
const whole = (text: string) => text.trim().replace(/ /g, "\u00a0");
/** "0.0 dB → -3.2 dB" from Live's own text, when both sides have it. */
const shown = (before: unknown, after: unknown) => (typeof before === "string" && typeof after === "string" && before && after ? `${whole(before)} → ${whole(after)}` : undefined);

function mixerParts(prior: JsonObject, proposed: JsonObject, was: JsonObject, now: JsonObject): string[] {
  const parts: string[] = [];
  const volume = number(proposed.volume); const before = number(prior.volume);
  const volumeText = shown(was.volume, now.volume);
  if (volume !== undefined) parts.push(volumeText ? `volume ${volumeText}` : before === undefined || volume === before ? "volume" : volume > before ? "volume up" : "volume down");
  const pan = number(proposed.pan);
  const panText = shown(was.pan, now.pan);
  if (pan !== undefined) parts.push(panText ? `pan ${panText}` : pan === 0 ? "pan centre" : pan < 0 ? "pan left" : "pan right");
  if (typeof proposed.mute === "boolean") parts.push(proposed.mute ? "muted" : "unmuted");
  if (typeof proposed.solo === "boolean") parts.push(proposed.solo ? "soloed" : "unsoloed");
  if (number(proposed.cueVolume) !== undefined) parts.push("cue volume");
  if (Array.isArray(proposed.sends) && proposed.sends.length) {
    const before = Array.isArray(was.sends) ? was.sends : []; const after = Array.isArray(now.sends) ? now.sends : [];
    const named = proposed.sends.map((_, index) => { const text = shown(before[index], after[index]); return text && text.split(" → ")[0] !== text.split(" → ")[1] ? `send ${String.fromCharCode(65 + index)} ${text}` : undefined; }).filter(Boolean) as string[];
    parts.push(...(named.length ? named : [proposed.sends.length === 1 ? "send A" : "sends"]));
  }
  return parts;
}

/**
 * The changes Kumi can make, one tool each. Every one was exercised on real Live with its
 * undo (see docs/evidence/kumi-poc.md); a change is only offered while the bridge advertises
 * both its preview and apply for the open Set.
 */
export const CHANGES: readonly ChangeKind[] = [
  {
    tool: "set_tempo", preview: "live_tempo_preview", apply: "live_tempo_apply", family: "tempo",
    description: "Change the Set's tempo in BPM (20–999).",
    summarize(preview) {
      const from = number(preview.priorTempo); const to = number(preview.proposedTempo);
      return { title: from !== undefined && to !== undefined ? `Tempo ${formatNumber(from)} → ${formatNumber(to)} BPM` : "Tempo changed", ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    },
  },
  {
    tool: "set_mixer", preview: "live_mixer_preview", apply: "live_mixer_apply", family: "mixer",
    description: "Change one track's mixer. volume is the fader position from 0 to 1 (0.85 is 0 dB, 1 is +6 dB); pan goes from -1 (left) to 1 (right); mute and solo are on/off; sends are levels from 0 to 1 for return tracks A, B, … in order (a shorter list leaves the rest). trackRef comes from discovery in this turn; return tracks and the main track work too.",
    summarize(preview, _input, track, applied) {
      const prior = record(preview.prior); const proposed = record(preview.proposed);
      const known = track(preview.trackRef);
      const parts = mixerParts(prior, proposed, record(preview.priorDisplay), record(applied?.display));
      const from = number(prior.volume); const to = number(proposed.volume);
      return { title: `${known?.name ?? "Track"} ${parts.join(", ") || "mixer"}`, ...(known ? { track: known } : {}),
        ...(from !== undefined && to !== undefined ? { from, to, range: [0, 1] as [number, number] } : {}) };
    },
  },
  {
    tool: "rename", preview: "live_object_rename_preview", apply: "live_object_rename_apply", family: "rename",
    description: "Rename a track, scene, clip, device or locator. kind says which; ref comes from discovery in this turn.",
    summarize(preview, input, track) {
      const target = record(preview.target);
      const kind = label(target.kind) ?? label(input.kind) ?? "item";
      const known = kind === "track" ? track(target.ref ?? input.ref) : undefined;
      return { title: `Renamed ${kind} ${quoted(target.currentName, "(unnamed)")} → ${quoted(preview.proposedName ?? input.name, "(unnamed)")}`,
        ...(known ? { track: { ...known, name: label(preview.proposedName ?? input.name) ?? known.name } } : {}) };
    },
  },
  {
    tool: "add_tracks_and_scenes", preview: "live_session_structure_preview", apply: "live_session_structure_apply", family: "structure", restructures: true,
    description: "Add new MIDI or audio tracks and named scenes. New ones go after the last track or scene unless you give an index (0 is first). Earlier track and scene references are out of date afterwards; discover again before using them.",
    schema(schema) {
      const copy = structuredClone(schema);
      for (const list of ["tracks", "scenes"]) {
        const index = record(record(record(record(copy.properties)[list]).items).properties).index;
        if (index && typeof index === "object") (index as JsonObject).description = "Position, 0 is first. Leave it out to add after the last one.";
      }
      return copy;
    },
    summarize(preview) {
      const proposed = Array.isArray(preview.proposed) ? preview.proposed.map(record) : [];
      const tracks = proposed.filter((item) => item.kind === "track");
      const scenes = proposed.filter((item) => item.kind === "scene");
      if (tracks.length === 1 && !scenes.length) {
        const kind = tracks[0]!.trackKind === "audio" ? "audio" : "MIDI";
        return { title: `Added ${kind} track ${quoted(tracks[0]!.name, "")}`.trim(), track: { name: label(tracks[0]!.name) ?? `New ${kind} track` } };
      }
      if (scenes.length === 1 && !tracks.length) return { title: `Added scene ${quoted(scenes[0]!.name, "")}`.trim() };
      return { title: `Added ${[tracks.length ? plural(tracks.length, "track") : "", scenes.length ? plural(scenes.length, "scene") : ""].filter(Boolean).join(" and ") || "tracks and scenes"}` };
    },
  },
  {
    tool: "write_midi_clip", preview: "live_midi_clip_preview", apply: "live_midi_clip_apply", family: "clip",
    description: "Write a new MIDI clip into an empty Session slot. trackRef is a MIDI track from discovery in this turn; sceneIndex 0 is the first scene; length and every note's start and duration are in beats from the clip start (a 4/4 bar is 4 beats); pitch 60 is middle C (C3 in Live); velocity is 1–127.",
    summarize(preview, input, track) {
      const proposed = record(preview.proposed);
      const notes = Array.isArray(proposed.notes) ? proposed.notes.length : Array.isArray(input.notes) ? input.notes.length : 0;
      const known = track(record(preview.target).trackRef ?? input.trackRef);
      return { title: `New MIDI clip ${quoted(proposed.name ?? input.name, "")} · ${plural(notes, "note")}`.replace("  ", " "), ...(known ? { track: known } : {}) };
    },
  },
  {
    tool: "load_device", preview: "live_browser_load_preview", apply: "live_browser_load_apply", family: "device",
    description: "Load an instrument, effect or preset from Live's Browser onto a track. itemId comes from live_browser_search in this turn; trackRef from discovery in this turn.",
    summarize(preview, input, track) {
      const known = track(preview.trackRef ?? input.trackRef);
      return { title: `Loaded ${label(record(preview.item).name) ?? "a device"}${known ? ` on ${known.name}` : ""}`, ...(known ? { track: known } : {}) };
    },
  },
  {
    tool: "set_device_parameter", preview: "live_device_parameter_preview", apply: "live_device_parameter_apply", family: "parameter",
    description: "Set one device parameter to a value between its min and max. deviceRef and parameterRef come from discovery in this turn.",
    summarize(preview, input, track) {
      const parameter = record(preview.parameter); const device = record(preview.device);
      const name = label(parameter.name) ?? "parameter";
      const from = number(parameter.currentValue); const to = number(parameter.proposedValue ?? input.value);
      const known = track(device.trackRef);
      const values = from !== undefined && to !== undefined ? ` ${formatNumber(from)} → ${formatNumber(to)}` : "";
      const min = number(parameter.min); const max = number(parameter.max);
      return { title: `${label(device.name) ? `${label(device.name)} · ` : ""}${name}${values}`, ...(known ? { track: known } : {}),
        ...(from !== undefined && to !== undefined ? { from, to, ...(min !== undefined && max !== undefined && max > min ? { range: [min, max] as [number, number] } : {}) } : {}) };
    },
  },
  {
    tool: "set_locators", preview: "live_arrangement_section_preview", apply: "live_arrangement_section_apply", family: "locators",
    description: "Mark a section in the Arrangement with two named locators. start and end are in beats from the start of the song (bar 1 is beat 0; a 4/4 bar is 4 beats).",
    summarize(_preview, input) {
      const start = number(input.start); const end = number(input.end);
      return { title: `Locators ${quoted(input.startName, "")} and ${quoted(input.endName, "")}${start !== undefined && end !== undefined ? ` (beats ${formatNumber(start)}–${formatNumber(end)})` : ""}`.replace("  ", " ") };
    },
  },
  {
    tool: "set_track_color", preview: "live_track_properties_preview", apply: "live_track_properties_apply", family: "color",
    description: "Change a track's colour to one of Live's 70 palette colours (colorIndex 0–69). ref comes from discovery in this turn.",
    summarize(preview, input, track) {
      const known = track(preview.ref ?? input.ref);
      return { title: `${known?.name ?? "Track"} colour changed`, ...(known ? { track: known } : {}) };
    },
  },
];

export const UNDO_TOOL = "undo_change";
export const UNDO_DESCRIPTION = "Undo one of your changes from this session: pass its change id (such as c3), or \"last\" for the latest one. It only works while nobody changed the same thing in Live since; if so, say what happened.";

/** Bridge tools only Kumi calls, behind its change tools: previews, applies and undo. */
export const HOST_TOOLS: ReadonlySet<string> = new Set([...CHANGES.flatMap((kind) => [kind.preview, kind.apply]), "live_undo"]);

/** The fields of a change tool's input that name Live objects; they must come from discovery in this turn. */
export const REFERENCE_FIELDS = ["trackRef", "ref", "clipRef", "deviceRef", "parameterRef"] as const;

/** A bridge refusal, in plain words for HISTORY. The model also gets the bridge's own message. */
export function undoNote(message: string): string {
  if (/epoch|connection/i.test(message)) return "Live restarted or reconnected since, so Kumi can't undo this.";
  if (/unknown|expired|not found/i.test(message)) return "Kumi can't undo this anymore.";
  if (/changed|postcondition|no longer|fingerprint|revision|identity|mismatch/i.test(message)) return "It changed in Live since, so Kumi left it as it is.";
  return "Live didn't accept the undo, so Kumi left it as it is.";
}

let counter = 0;
/** Change ids are unique for the process, so HISTORY never mixes up two sessions' changes. */
export function nextChangeId(): string {
  counter++;
  return `c${counter}`;
}

export function newRecord(kind: ChangeKind, summary: ChangeSummary, state: ChangeRecord["state"], at: number): ChangeRecord {
  return { id: nextChangeId(), family: kind.family, title: summary.title, state, at,
    ...(summary.track ? { track: summary.track } : {}),
    ...(summary.from !== undefined ? { from: summary.from } : {}), ...(summary.to !== undefined ? { to: summary.to } : {}),
    ...(summary.range ? { range: summary.range } : {}) };
}
