import type { JsonObject } from "../../core/contracts.js";

/**
 * The Set's tracks as the model sees them each turn, within about the same size whatever the Set's size
 * (tokens cost the producer money, and a 200-track Set listed whole is hundreds of KiB). A Set that fits
 * is shown whole. A bigger one is folded, a step at a time until it fits: the tracks in focus (selected
 * in Live, pinned in Kumi, changed lately) keep their devices, and every other track becomes one line
 * ("track:3 Kick (audio, in track:1) · Simpler, EQ Eight +1"); then those lines give only how many
 * devices ("· 3 devices"); then, on a huge Set, the list stops (focus tracks always stay) and says how
 * many more there are. Every track's reference stays usable: discovery registered them all.
 */
export const OBSERVATION_TRACK_BYTES = 12 * 1024;

export const FOLDED_NOTE = "A big Set: only the tracks in focus (selected in Live, pinned, or changed lately) list their devices; each other track is one line: \"ref name (type, in its group) · its first devices +how many more\" (or \"· N devices\"). For another track's devices, discover kind device with parent that track's ref.";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const devicesOf = (track: JsonObject) => (Array.isArray(track.devices) ? track.devices as JsonObject[] : []);

/** One line for a track: its reference, name, type and group, and (with `names`) its first devices. */
export function trackLine(track: JsonObject, names: boolean): string {
  const where = [track.type, typeof track.group === "string" ? `in ${track.group}` : undefined].filter((part) => typeof part === "string" && part).join(", ");
  const devices = devicesOf(track);
  const first = devices.slice(0, 2).map((device) => String(device.name ?? "?").slice(0, 40));
  const list = !devices.length ? "" : names ? ` · ${first.join(", ")}${devices.length > 2 ? ` +${devices.length - 2}` : ""}` : ` · ${devices.length} device${devices.length === 1 ? "" : "s"}`;
  return `${String(track.ref ?? "?")} ${String(track.name ?? "(unnamed)").slice(0, 60)}${where ? ` (${where})` : ""}${list}`;
}

/** A track whose racks show their chains' names only, not what's in them. */
function chainsCounted(track: JsonObject): JsonObject {
  if (!Array.isArray(track.devices)) return track;
  return { ...track, devices: devicesOf(track).map((device) => (Array.isArray(device.chains) ? { ...device, chains: (device.chains as JsonObject[]).map((chain) => chain.name ?? null) } : device)) };
}

export interface FoldedTracks {
  tracks: Array<JsonObject | string>;
  /** Present when the tracks are folded: what the lines mean and how to see more. */
  folded?: string;
  /** Present when the list stops before the Set does: how many tracks it leaves out. */
  moreTracks?: string;
}

export function foldTracks(tracks: readonly JsonObject[], inFocus: (track: JsonObject) => boolean, budget = OBSERVATION_TRACK_BYTES): FoldedTracks {
  if (size(tracks) <= budget) return { tracks: [...tracks] };
  const focus = tracks.map(inFocus);
  const fits = (rows: Array<JsonObject | string>) => size(rows) <= budget;
  // The steps, each smaller than the one before; the first that fits is shown.
  const steps: Array<() => Array<JsonObject | string>> = [
    () => tracks.map((track, index) => (focus[index] ? track : chainsCounted(track))),
    () => tracks.map((track, index) => (focus[index] ? track : trackLine(track, true))),
    () => tracks.map((track, index) => (focus[index] ? chainsCounted(track) : trackLine(track, false))),
  ];
  for (const step of steps) { const rows = step(); if (fits(rows)) return { tracks: rows, folded: FOLDED_NOTE }; }
  // A huge Set: the focus tracks and as many lines as fit, in the Set's order.
  const rows = tracks.map((track, index) => (focus[index] ? chainsCounted(track) : trackLine(track, false)));
  const kept: Array<JsonObject | string> = []; let used = 2; let left = 0;
  for (const [index, row] of rows.entries()) {
    const cost = size(row) + 1;
    if (focus[index] || used + cost <= budget) { kept.push(row); used += cost; } else left++;
  }
  return { tracks: kept, folded: FOLDED_NOTE, ...(left ? { moreTracks: `${left} more tracks aren't listed; discover kind track (with cursor) for them` } : {}) };
}
