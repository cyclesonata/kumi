/**
 * live_command: Live's own commands, through its menus and keys, for what Live's scripting doesn't
 * offer (grouping, freezing, bouncing, consolidating, converting to MIDI, separating stems, saving,
 * exporting). Each command names what it works on; Kumi selects that first, presses the command in
 * Live (found by its title wherever it is in Live's menus), and checks what changed. What's here is
 * the tool's shape and the commands; the work is in the integration, which has Live.
 */
import type { JsonObject } from "../../core/contracts.js";
import type { MenuItem } from "../../hands/index.js";

export const LIVE_COMMAND_TOOL = "live_command";

/** What a command works on: nothing, one track, several side by side, or one clip. */
export type Target = "none" | "track" | "tracks" | "clip" | "track-or-clip";

export interface Command {
  /** The menu item's title (or its start), as Live names it; the first that's there is pressed. */
  titles: string[];
  target: Target;
  /** In plain words, for HISTORY: "Grouped", "Froze"… */
  done: string;
  /** Live opens a dialog for it (answer it with answer). */
  dialog?: boolean;
}

export const COMMANDS: Record<string, Command> = {
  save: { titles: ["Save Live Set", "Save"], target: "none", done: "Saved the Set" },
  collect_all_and_save: { titles: ["Collect All and Save"], target: "none", done: "Collected all and saved the Set" },
  // Live 12.4 calls them Edit › Group and Ungroup (they group devices too, when devices are selected).
  group_tracks: { titles: ["Group", "Group Tracks"], target: "tracks", done: "Grouped" },
  ungroup_tracks: { titles: ["Ungroup", "Ungroup Tracks"], target: "track", done: "Ungrouped" },
  // One menu item that Live retitles with the selection (its menus catch up a moment later): Kumi checks the
  // track's state before pressing it, so either title does the one asked for.
  freeze_track: { titles: ["Freeze Track", "Unfreeze Track"], target: "track", done: "Froze" },
  unfreeze_track: { titles: ["Unfreeze Track", "Freeze Track"], target: "track", done: "Unfroze" },
  flatten_track: { titles: ["Flatten Track", "Flatten Tracks", "Flatten"], target: "track", done: "Flattened" },
  bounce_to_new_track: { titles: ["Bounce to New Track", "Bounce Track to New Track"], target: "track-or-clip", done: "Bounced to a new track" },
  bounce_track_in_place: { titles: ["Bounce Track in Place", "Bounce Tracks in Place"], target: "track", done: "Bounced in place" },
  paste_bounced_audio: { titles: ["Paste Bounced Audio"], target: "track", done: "Pasted bounced audio" },
  consolidate: { titles: ["Consolidate"], target: "clip", done: "Consolidated" },
  convert_melody_to_midi: { titles: ["Convert Melody to New MIDI Track"], target: "clip", done: "Converted the melody to MIDI" },
  convert_harmony_to_midi: { titles: ["Convert Harmony to New MIDI Track"], target: "clip", done: "Converted the harmony to MIDI" },
  convert_drums_to_midi: { titles: ["Convert Drums to New MIDI Track"], target: "clip", done: "Converted the drums to MIDI" },
  slice_to_midi_track: { titles: ["Slice to New MIDI Track"], target: "clip", done: "Sliced to a new MIDI track", dialog: true },
  separate_stems: { titles: ["Separate Stems to New Audio Tracks", "Separate Stems"], target: "clip", done: "Separated stems" },
  export_audio: { titles: ["Export Audio/Video", "Export Audio"], target: "none", done: "Opened Export Audio/Video", dialog: true },
  export_midi_clip: { titles: ["Export MIDI Clip"], target: "clip", done: "Opened Export MIDI Clip", dialog: true },
};

export const LIVE_COMMAND_DESCRIPTION = [
  "Use Live's own commands, through its menus and keys, for what your other tools can't do:",
  "group or ungroup tracks, freeze, unfreeze or flatten a track, bounce a track or clip to audio without playing it (bounce_to_new_track, bounce_track_in_place),",
  "consolidate, convert an audio clip to MIDI (melody, harmony, drums), separate stems, slice to a MIDI track, save the Set (or collect all and save), export audio or a MIDI clip.",
  "Give the command and what it works on (track, tracks side by side, or clip): Kumi selects it in Live, presses the command, and says what changed.",
  "For anything else Live's menus or keys do, give menu (the item's titles, [\"Create\", \"Insert Silence\"]) or keys ([\"cmd+e\"]). When Live opens a dialog, its words and buttons come back: answer presses one.",
  "Live comes to the front for a moment. Prefer your other tools whenever one does the job.",
].join(" ");

const REF = { type: "string", minLength: 1, maxLength: 256 } as const;
export const LIVE_COMMAND_SCHEMA: JsonObject = { type: "object", additionalProperties: false, properties: {
  command: { type: "string", enum: Object.keys(COMMANDS), description: "One of Live's commands Kumi knows" },
  track: { ...REF, description: "The track it works on (its reference from this turn, or its name)" },
  tracks: { type: "array", minItems: 2, maxItems: 64, items: REF, description: "Tracks side by side (to group them), first to last" },
  clip: { ...REF, description: "The clip it works on: its clipRef from this turn (a Session clip), or \"selected\" for the one the producer selected in Live" },
  menu: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 80 }, description: "Any of Live's menu items by its titles, [\"Edit\", \"Freeze Track\"]" },
  keys: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 32 }, description: "Keys to press in Live, one combination each: \"cmd+shift+r\", \"down\"" },
  answer: { type: "string", minLength: 1, maxLength: 80, description: "Press this button of the dialog Live has open (OK, Export, Cancel…)" },
} };

/** A title as Live may say it: "Freeze Track" and "Freeze Tracks" (it changes with the selection) are one. */
const norm = (title: string) => title.replace(/…$|\.\.\.$/, "").trim().toLowerCase().replace(/\b(track|clip|scene)s\b/g, "$1");

/** The menu item a command presses: the first of its titles found anywhere in Live's menus (whole, then as a start). */
export function findItem(items: readonly MenuItem[], titles: readonly string[]): MenuItem | undefined {
  const name = (item: MenuItem) => norm(item.path.at(-1) ?? "");
  for (const title of titles) {
    const wanted = norm(title);
    const exact = items.find((item) => name(item) === wanted);
    if (exact) return exact;
  }
  for (const title of titles) {
    const wanted = norm(title);
    const start = items.find((item) => name(item).startsWith(wanted));
    if (start) return start;
  }
  return undefined;
}

/** Keys as macOS writes them in a menu ("⌘G"), for the producer: Live's own shortcut for next time. */
export function shortcut(item: MenuItem): string | undefined {
  if (!item.key) return undefined;
  const mods = item.modifiers ?? 0;
  // Accessibility's modifier bits: 1 shift, 2 option, 4 control, 8 no command.
  return `${mods & 4 ? "⌃" : ""}${mods & 2 ? "⌥" : ""}${mods & 1 ? "⇧" : ""}${mods & 8 ? "" : "⌘"}${item.key}`;
}
