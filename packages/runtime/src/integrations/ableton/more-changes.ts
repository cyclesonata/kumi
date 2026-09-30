/**
 * The rest of what Live lets Kumi change: the transport, routing, clips and their notes, MIDI
 * transforms, clip automation, return tracks and duplicates, scenes, the song's settings, devices'
 * on/off, order and removal, chains and rack variations. Each is one tool, run as a preview and an
 * apply, recorded in HISTORY with its undo, or kept there with why when Live gives no way back.
 */
import type { JsonObject } from "../../core/contracts.js";
import type { ChangeKind, ChangeSummary, KnownTrack } from "./changes.js";
import { FIXED_BRIDGE } from "./bridge-version.js";

const record = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const label = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined);
const quoted = (value: unknown, fallback: string) => { const text = label(value); return text ? `“${text}”` : fallback; };
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const trim = (value: number) => String(Number(value.toFixed(2)));

/** Beats in a bar, from the Set's time signature (the integration keeps it current). */
let beatsPerBar = 4;
export function setMeter(numerator: number, denominator: number): void {
  if (numerator > 0 && denominator > 0) beatsPerBar = numerator * 4 / denominator;
}
/** A position in beats as Live shows it: "bar 17", or "bar 17 beat 3". */
export function bars(beats: number): string {
  const bar = Math.floor(beats / beatsPerBar) + 1; const beat = beats - (bar - 1) * beatsPerBar;
  return beat < 0.001 ? `bar ${bar}` : `bar ${bar} beat ${trim(beat + 1)}`;
}
/** A length in beats: "2 bars", "3 beats". */
export function span(beats: number): string {
  const count = beats / beatsPerBar;
  return Number.isInteger(count) ? plural(count, "bar") : plural(Number(trim(beats)), "beat");
}

/** The track a clip, device, chain or slot belongs to ("5:clip:2:1" → track 2), for HISTORY's chip. */
function ownerTrack(ref: unknown, track: (ref: unknown) => KnownTrack | undefined): KnownTrack | undefined {
  if (typeof ref !== "string") return undefined;
  const direct = track(ref);
  if (direct && /:track:/.test(ref)) return direct;
  const match = /^(\d+):(?:clip|device|chain|clip_slot|slot|drum_pad):(\d+)(?::|$)/.exec(ref);
  return match ? track(`${match[1]}:track:${match[2]}`) : undefined;
}
const withTrack = (summary: ChangeSummary, known: KnownTrack | undefined): ChangeSummary => (known ? { ...summary, track: known } : summary);
const REF = { type: "string", minLength: 1, maxLength: 256 } as const;
const LAUNCH_MODES = ["trigger", "gate", "toggle", "repeat"];

export const MORE_CHANGES: readonly ChangeKind[] = [
  {
    tool: "set_transport", since: FIXED_BRIDGE, preview: "live_transport_preview", apply: "live_transport_apply", family: "tempo",
    description: "Change the transport: the loop (loopEnabled, loopStart and loopLength in beats; a 4/4 bar is 4 beats), the metronome, punch in and out, and the playhead position (beats). Playing and stopping are the play tool's.",
    summarize(preview) {
      const prior = record(preview.prior); const proposed = record(preview.proposed); const loop = record(prior.loop);
      const parts: string[] = [];
      const start = number(proposed.loopStart) ?? number(loop.start); const length = number(proposed.loopLength) ?? number(loop.length);
      if (typeof proposed.loopEnabled === "boolean" || proposed.loopStart !== undefined || proposed.loopLength !== undefined) {
        const on = typeof proposed.loopEnabled === "boolean" ? proposed.loopEnabled : loop.enabled === true;
        parts.push(on && start !== undefined && length !== undefined ? `loop ${bars(start)} for ${span(length)}` : on ? "loop on" : "loop off");
      }
      if (typeof proposed.metronome === "boolean") parts.push(proposed.metronome ? "metronome on" : "metronome off");
      if (typeof proposed.punchIn === "boolean") parts.push(proposed.punchIn ? "punch in on" : "punch in off");
      if (typeof proposed.punchOut === "boolean") parts.push(proposed.punchOut ? "punch out on" : "punch out off");
      const position = number(proposed.position);
      if (position !== undefined) parts.push(`playhead to ${bars(position)}`);
      const text = parts.join(", ") || "transport";
      return { title: text[0]!.toUpperCase() + text.slice(1) };
    },
  },
  {
    tool: "set_routing", since: FIXED_BRIDGE, preview: "live_routing_preview", apply: "live_routing_apply", family: "mixer",
    description: "Route a track and get it ready to record: its input (inputType and inputSubRouting, such as another track and \"Post FX\", or \"Resampling\" for the main output) and output (outputType, outputSubRouting), exactly as Live names them (live_discover kind routing-choice with the track as parent lists them), arm on or off, and monitoring in, auto or off. A new audio track fed by another track and armed is how audio gets bounced (resampling).",
    summarize(preview, input, track) {
      const proposed = record(preview.proposed); const known = track(preview.trackRef ?? input.trackRef);
      const parts: string[] = [];
      if (label(proposed.inputType) ?? label(input.inputType)) parts.push(`input from ${label(proposed.inputType) ?? label(input.inputType)}${label(proposed.inputSubRouting ?? input.inputSubRouting) ? ` (${label(proposed.inputSubRouting ?? input.inputSubRouting)})` : ""}`);
      if (label(proposed.outputType) ?? label(input.outputType)) parts.push(`output to ${label(proposed.outputType) ?? label(input.outputType)}${label(proposed.outputSubRouting ?? input.outputSubRouting) ? ` (${label(proposed.outputSubRouting ?? input.outputSubRouting)})` : ""}`);
      const arm = proposed.arm ?? input.arm;
      if (typeof arm === "boolean") parts.push(arm ? "armed" : "disarmed");
      const monitoring = label(proposed.monitoring ?? input.monitoring);
      if (monitoring) parts.push(`monitoring ${monitoring}`);
      return withTrack({ title: `${known?.name ?? "Track"}: ${parts.join(", ") || "routing"}` }, known);
    },
  },
  {
    tool: "set_mixer_options", since: FIXED_BRIDGE, preview: "live_mixer_extended_preview", apply: "live_mixer_extended_apply", family: "mixer",
    description: "A track's other mixer settings: trackActivator (the track on or off), crossfadeAssign (0 none, 1 A, 2 B), panningMode (0 stereo, 1 split) with panningLeft and panningRight (-1 to 1), and the main track's crossfader (-1 A to 1 B).",
    summarize(preview, input, track) {
      const proposed = record(preview.proposed ?? input); const known = track(preview.trackRef ?? input.trackRef);
      const parts: string[] = [];
      const activator = proposed.trackActivator ?? input.trackActivator;
      if (typeof activator === "boolean") parts.push(activator ? "switched on" : "switched off");
      const assign = number(proposed.crossfadeAssign ?? input.crossfadeAssign);
      if (assign !== undefined) parts.push(`crossfade ${["none", "A", "B"][assign] ?? assign}`);
      const mode = number(proposed.panningMode ?? input.panningMode);
      if (mode !== undefined) parts.push(mode === 1 ? "split stereo pan" : "stereo pan");
      if (number(proposed.crossfader ?? input.crossfader) !== undefined) parts.push("crossfader moved");
      return withTrack({ title: `${known?.name ?? "Track"}: ${parts.join(", ") || "mixer options"}` }, known);
    },
  },
  {
    tool: "edit_rack_mapping", preview: "live_willington_device_preview", apply: "live_willington_device_apply", family: "device",
    description: "Experimental Willington rack edits: kind macro-name renames macroIndex 0–15; variation-name renames the selected variation; macro-mapping assigns targetRef to mappingIndex 0–15 with minimum, maximum and mappingKind continuous, enum or boolean. Null mappingIndex unmaps. Boolean endpoints are macro thresholds 0–127; others use target parameter units. Requires stopped playback.",
    summarize(_preview, input, track) {
      const macro = typeof input.macroIndex === "number" ? `Macro ${input.macroIndex + 1}` : "macro";
      const title = input.kind === "macro-name" ? `Renamed ${macro} to “${String(input.name ?? "")}”`
        : input.kind === "variation-name" ? `Renamed variation to “${String(input.name ?? "")}”`
        : input.mappingIndex === null ? "Removed macro mapping"
        : typeof input.mappingIndex === "number" ? `Mapped parameter to Macro ${input.mappingIndex + 1}` : "Changed macro mapping";
      return withTrack({ title }, ownerTrack(input.ref, track));
    },
  },
  {
    tool: "set_clip_follow_actions", preview: "live_follow_actions_preview", apply: "live_follow_actions_apply", family: "clip",
    description: "Set Session clip Follow Actions with experimental Willington support. Requires stopped playback. Actions: 0 none, 1 stop, 2 again, 3 previous, 4 next, 5 first, 6 last, 7 any, 8 other, 9 jump. Chances are percentages; supplying one sets the complementary chance. Linked timing uses loop count; unlinked time uses beats. Jump targets are 1-based scene numbers. For launch Legato, use set_clip with legato: true after creating the clip. Does not change scene Follow Actions or the global switch.",
    summarize(_preview, input, track) {
      return withTrack({ title: "Changed clip Follow Actions" }, ownerTrack(input.clipRef, track));
    },
  },
  {
    tool: "set_clip", preview: "live_clip_properties_preview", apply: "live_clip_properties_apply", family: "clip",
    inputSchema: { type: "object", required: ["clipRef"], additionalProperties: false, properties: {
      clipRef: REF, muted: { type: "boolean" }, colorIndex: { type: "integer", minimum: 0, maximum: 69 },
      looping: { type: "boolean" }, loopStart: { type: "number", minimum: 0 }, loopEnd: { type: "number", minimum: 0 },
      launchMode: { type: "integer", minimum: 0, maximum: 3 }, launchQuantization: { type: "integer", minimum: 0, maximum: 14 },
      legato: { type: "boolean" }, ramMode: { type: "boolean" }, velocityAmount: { type: "number", minimum: 0, maximum: 1 },
    } },
    always: true,
    unavailable: "Create a clip first with write_midi_clip, then discover its clipRef and use set_clip for launch Legato and other clip settings. The current bridge does not yet advertise clip editing.",
    description: "Change a clip's settings: muted, colorIndex (0–69), looping with loopStart and loopEnd (beats from the clip's start), launchMode (0 trigger, 1 gate, 2 toggle, 3 repeat), launchQuantization (0 global, then none, 8 bars, 4, 2, 1 bar, 1/2, 1/2T, 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32), legato, ramMode and velocityAmount (0–1). clipRef comes from discovery (a clip-slot's clipRef).",
    summarize(preview, input, track) {
      const prior = record(preview.prior); const proposed = record(preview.proposed);
      const parts: string[] = [];
      if (typeof proposed.muted === "boolean") parts.push(proposed.muted ? "muted" : "unmuted");
      if (number(proposed.loopEnd) !== undefined || number(proposed.loopStart) !== undefined) {
        const start = number(proposed.loopStart) ?? number(prior.loopStart) ?? 0; const end = number(proposed.loopEnd) ?? number(prior.loopEnd);
        if (end !== undefined) parts.push(`loop ${span(end - start)}${number(prior.loopEnd) !== undefined ? ` (was ${span((number(prior.loopEnd) ?? 0) - (number(prior.loopStart) ?? 0))})` : ""}`);
      }
      if (typeof proposed.looping === "boolean" && proposed.looping !== prior.looping) parts.push(proposed.looping ? "looping" : "not looping");
      const mode = number(proposed.launchMode);
      if (mode !== undefined) parts.push(`${LAUNCH_MODES[mode] ?? "launch"} mode`);
      if (number(proposed.launchQuantization) !== undefined) parts.push("launch quantization");
      if (number(proposed.colorIndex) !== undefined) parts.push("colour");
      if (typeof proposed.legato === "boolean") parts.push(proposed.legato ? "legato on" : "legato off");
      if (number(proposed.velocityAmount) !== undefined) parts.push(`velocity ${Math.round((number(proposed.velocityAmount) ?? 0) * 100)}%`);
      if (typeof proposed.ramMode === "boolean") parts.push(proposed.ramMode ? "RAM mode on" : "RAM mode off");
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${parts.join(", ") || "settings"}` }, known);
    },
  },
  {
    tool: "set_audio_clip", since: FIXED_BRIDGE, preview: "live_audio_clip_preview", apply: "live_audio_clip_apply", family: "clip",
    description: "Change an audio clip: gain (Live's clip gain control, 0–1; discover the clip first and move from its current value), pitchCoarse (semitones, ±48) and pitchFine (cents, ±50), loopStart and loopEnd, warping on or off and warpMode (0 Beats, 1 Tones, 2 Texture, 3 Re-Pitch, 4 Complex, 6 Complex Pro), fadeInLength and fadeOutLength. clipRef comes from discovery.",
    summarize(preview, input, track) {
      const proposed = record(preview.proposed ?? input);
      const parts: string[] = [];
      const coarse = number(proposed.pitchCoarse ?? input.pitchCoarse);
      if (coarse !== undefined) parts.push(`pitch ${coarse > 0 ? "+" : ""}${coarse} st`);
      if (number(proposed.pitchFine ?? input.pitchFine) !== undefined) parts.push("fine pitch");
      if (number(proposed.gain ?? input.gain) !== undefined) parts.push("gain");
      if (typeof (proposed.warping ?? input.warping) === "boolean") parts.push((proposed.warping ?? input.warping) ? "warped" : "unwarped");
      if (number(proposed.warpMode ?? input.warpMode) !== undefined) parts.push(`${["Beats", "Tones", "Texture", "Re-Pitch", "Complex", "REX", "Complex Pro"][number(proposed.warpMode ?? input.warpMode)!] ?? "warp"} mode`);
      if (number(proposed.fadeInLength ?? input.fadeInLength) !== undefined || number(proposed.fadeOutLength ?? input.fadeOutLength) !== undefined) parts.push("fades");
      if (number(proposed.loopStart ?? input.loopStart) !== undefined || number(proposed.loopEnd ?? input.loopEnd) !== undefined) parts.push("loop");
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      return withTrack({ title: `${known ? `${known.name} audio clip` : "Audio clip"}: ${parts.join(", ") || "settings"}` }, known);
    },
  },
  {
    tool: "edit_clip", preview: "live_clip_action_preview", apply: "live_clip_action_apply", family: "clip",
    description: "Edit a clip's content: crop (to its loop), duplicate-loop (doubles the loop, content and all), duplicate-region (copies regionStart–regionEnd to destination, in beats), or move-playing-position (by offset beats). Live gives Kumi no undo for these; say so before a crop.",
    permanent: () => "Live gives Kumi no way to take this back; use Live's own undo if you need to.",
    summarize(preview, input, track) {
      const action = label(preview.action ?? input.action) ?? "edit"; const prior = record(preview.prior);
      const length = number(prior.length) ?? number(prior.loopEnd);
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      const what = known ? `${known.name} clip` : "clip";
      const title = action === "duplicate-loop" ? `Doubled the loop of the ${what}${length !== undefined ? ` (${span(length)} → ${span(length * 2)})` : ""}`
        : action === "crop" ? `Cropped the ${what} to its loop` : action === "duplicate-region" ? `Copied part of the ${what} within it` : `Moved the ${what}'s play position`;
      return withTrack({ title }, known);
    },
  },
  {
    tool: "duplicate_clip", preview: "live_clip_duplicate_preview", apply: "live_clip_duplicate_apply", family: "clip",
    description: "Copy a clip: into a Session slot (targetTrackRef and targetSceneIndex, 0 is the first scene; the same track when targetTrackRef is left out) or into the Arrangement at arrangementPosition (beats; a 4/4 bar is 4 beats). This is also how MIDI reaches the Arrangement: write the clip in Session view, then duplicate it there.",
    summarize(preview, input, track) {
      const destination = record(preview.destination);
      const at = number(destination.arrangementPosition ?? input.arrangementPosition);
      const scene = number(destination.targetSceneIndex ?? input.targetSceneIndex);
      const target = track(destination.targetTrackRef ?? input.targetTrackRef);
      const known = ownerTrack(preview.source ?? input.clipRef, track);
      return withTrack({ title: at !== undefined ? `Copied ${known ? `the ${known.name} clip` : "a clip"} to the Arrangement at ${bars(at)}`
        : `Copied ${known ? `the ${known.name} clip` : "a clip"} to ${target ? target.name : "its track"}${scene !== undefined ? `, scene ${scene + 1}` : ""}` }, target ?? known);
    },
  },
  {
    tool: "move_clip", since: FIXED_BRIDGE, preview: "live_clip_move_preview", apply: "live_clip_move_apply", family: "clip",
    description: "Move a clip: an Arrangement clip to a new position (beats), or a Session clip to another slot (targetTrackRef and targetSceneIndex, both needed; the clip's own track to keep it on its track).",
    summarize(_preview, input, track) {
      const at = number(input.position); const scene = number(input.targetSceneIndex); const target = track(input.targetTrackRef);
      const known = ownerTrack(input.clipRef, track);
      return withTrack({ title: at !== undefined ? `Moved ${known ? `the ${known.name} clip` : "a clip"} to ${bars(at)}` : `Moved ${known ? `the ${known.name} clip` : "a clip"} to ${target?.name ?? "another slot"}${scene !== undefined ? `, scene ${scene + 1}` : ""}` }, target ?? known);
    },
  },
  {
    tool: "add_arrangement_clip", preview: "live_arrangement_clip_preview", apply: "live_arrangement_clip_apply", family: "clip",
    description: "Put an empty MIDI clip in the Arrangement: trackRef (a MIDI track), position and length in beats, and a name. Live can't write notes into it afterwards; for a clip with notes, write it in Session view and duplicate_clip it to the Arrangement.",
    inputSchema: { type: "object", additionalProperties: false, required: ["trackRef", "position", "length"], properties: {
      trackRef: REF, position: { type: "number", minimum: 0 }, length: { type: "number", exclusiveMinimum: 0, maximum: 4096 }, name: { type: "string", maxLength: 256 } } },
    prepare(input) { return { action: "create", kind: "midi", trackRef: input.trackRef ?? null, position: input.position ?? null, length: input.length ?? null, ...(typeof input.name === "string" ? { name: input.name } : {}) }; },
    summarize(preview, input, track) {
      const payload = record(preview.payload); const known = track(payload.trackRef ?? input.trackRef);
      const position = number(payload.position ?? input.position); const length = number(payload.length ?? input.length);
      return withTrack({ title: `New Arrangement clip ${quoted(payload.name ?? input.name, "")}${known ? ` on ${known.name}` : ""}${position !== undefined ? ` at ${bars(position)}` : ""}${length !== undefined ? ` (${span(length)})` : ""}`.replace("  ", " ") }, known);
    },
  },
  {
    tool: "change_notes", since: FIXED_BRIDGE, preview: "live_note_update_preview", apply: "live_note_update_apply", family: "clip",
    description: "Change notes already in a Session clip, by id: pitch, start, duration (beats), velocity, mute, probability, velocityDeviation, releaseVelocity. Get their ids first: live_discover kind note with the clip's clipRef as parent lists its notes, and live_note_read with selected: true gives the ones selected in Live.",
    summarize(preview, input, track) {
      const count = Array.isArray(input.notes) ? input.notes.length : 0;
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${plural(count, "note")} changed` }, known);
    },
  },
  {
    tool: "delete_notes", preview: "live_note_delete_preview", apply: "live_note_delete_apply", family: "clip",
    description: "Delete notes from a Session clip, by id (live_discover kind note with the clip's clipRef as parent lists them with their ids).",
    summarize(preview, input, track) {
      const count = Array.isArray(input.noteIds) ? input.noteIds.length : 0;
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${plural(count, "note")} deleted` }, known);
    },
  },
  {
    tool: "edit_notes", since: FIXED_BRIDGE, preview: "live_note_edit_preview", apply: "live_note_edit_apply", family: "clip",
    description: "Quantize a Session clip's notes (action quantize: grid in beats, 0.25 is 1/16; amount 0–1), move them to one pitch (quantize-pitch with pitch), or duplicate them (duplicate). noteIds limits it to some notes; left out, all.",
    summarize(preview, input, track) {
      const action = label(preview.action ?? input.action) ?? "edit"; const grid = number(input.grid);
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      const what = action === "quantize" ? `notes quantized${grid ? ` to 1/${Math.round(4 / grid)}` : ""}` : action === "quantize-pitch" ? "notes moved to one pitch" : "notes duplicated";
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${what}` }, known);
    },
  },
  {
    tool: "transform_midi", since: FIXED_BRIDGE, preview: "live_midi_transform_preview", apply: "live_midi_transform_apply", family: "clip",
    description: [
      "Transform or generate a Session clip's notes. transform and its params:",
      "transpose {semitones}; scale-constrain {root 0–11 (0 is C), scale}; quantize {grid beats, amount, target start|end|both}; swing {grid, amount};",
      "velocity-curve {curve linear-up|linear-down|arch|exp-up|exp-down, amount}; humanize-velocity {maxDelta}; humanize-timing {maxOffset beats}; legato {gap}; staccato {factor 0.05–1};",
      "rotate {steps} (rotates pitches, keeps rhythm); repeat {times 2–8, decay}; ratchet {subdivisions 2–16, probability}; chord-voicing {strategy close|open|drop2};",
      "arpeggiate {pattern up|down|updown|downup|random, rate beats}; seeded-variation {velocityMax, timingMax, probabilityDepth, seed};",
      "euclidean {pulses, steps, rotation, pitch, velocity, stepLength, noteLength, bars}; chord-progression {chords [\"Cm\",\"Ab\",\"Eb\",\"Bb\"] or roman numerals with root and scale, voicing close|drop2|spread, chordDuration beats, octave, velocity};",
      "drum-pattern {style four-on-the-floor|backbeat|breakbeat|trap-hats, bars, density 0–1, mapping {kick: 36, snare: 38, closedHat: 42, …}}; bassline {pattern octave|walking|arpeggiated, chords, root, scale, stepBeats, octave};",
      "motif-invert {axis pitch}; motif-retrograde {}; motif-augment and motif-diminish {numerator, denominator}.",
      "Scales: major, minor, harmonic-minor, melodic-minor, dorian, phrygian, lydian, mixolydian, locrian, major-pentatonic, minor-pentatonic, blues, chromatic.",
      "scope duplicate writes the result to a copy (target {trackRef, sceneIndex}) and leaves the original; generative ones (repeat, ratchet, arpeggiate, euclidean, chord-progression, drum-pattern, bassline) do by default.",
    ].join(" "),
    summarize(preview, input, track) {
      const diff = record(preview.diff); const transform = label(preview.transform ?? input.transform) ?? "transform";
      const changed = (number(diff.add) ?? 0) + (number(diff.update) ?? 0) + (number(diff.delete) ?? 0);
      const known = ownerTrack(preview.clipRef ?? input.clipRef, track);
      const params = record(input.params); const semitones = number(params.semitones);
      const name = transform === "transpose" && semitones !== undefined ? `transposed ${semitones > 0 ? "+" : ""}${semitones}` : transform.replace(/-/g, " ");
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${name}${changed ? ` (${plural(changed, "note")})` : ""}` }, known);
    },
  },
  {
    tool: "set_automation", preview: "live_automation_preview", apply: "live_automation_apply", family: "clip",
    description: "Draw automation inside a Session clip for one device parameter: create-envelope, then insert points ({time in beats from the clip start, value in the parameter's own range}), delete-range (from, to), or delete-envelope. clipRef from discovery; parameterRef from discovering the device's parameters. The Arrangement's automation lanes aren't reachable.",
    summarize(preview, input, track) {
      const action = label(preview.action ?? input.action) ?? "automation";
      const points = Array.isArray(input.points) ? input.points.length : 0;
      const known = ownerTrack(input.clipRef, track);
      const what = action === "insert" ? `automation drawn (${plural(points, "point")})` : action === "create-envelope" ? "automation lane added" : action === "delete-range" ? "automation erased in a range" : "automation lane removed";
      return withTrack({ title: `${known ? `${known.name} clip` : "Clip"}: ${what}` }, known);
    },
  },
  {
    tool: "change_structure", preview: "live_track_structure_preview", apply: "live_track_structure_apply", family: "structure", restructures: true,
    description: "Add a return track (create-return, with a name), delete one (delete-return, ref; Live gives Kumi no undo for this), or duplicate a track or scene (duplicate-track, duplicate-scene, ref). Track and scene references are out of date afterwards; discover again.",
    permanent: (input) => (input.action === "delete-return" ? "Live gives Kumi no way to bring a deleted return track back; use Live's own undo if you need to." : undefined),
    summarize(_preview, input, track) {
      const action = label(input.action) ?? "";
      const known = track(input.ref);
      if (action === "create-return") return { title: `Added return track ${quoted(input.name, "")}`.trim() };
      if (action === "delete-return") return { title: `Deleted return track ${known ? quoted(known.name, "") : ""}`.trim() };
      if (action === "duplicate-track") return withTrack({ title: `Duplicated track ${known ? quoted(known.name, "") : ""}`.trim() }, known);
      return { title: "Duplicated a scene" };
    },
  },
  {
    tool: "set_scene", preview: "live_scene_preview", apply: "live_scene_apply", family: "structure",
    description: "Change a scene: colorIndex (0–69), its own tempo (tempo with tempoEnabled) and time signature (signatureNumerator, signatureDenominator with timeSignatureEnabled), which Live switches to when the scene launches. ref is the scene from discovery.",
    summarize(preview) {
      const proposed = record(preview.proposed);
      const parts: string[] = [];
      const tempo = number(proposed.tempo);
      if (tempo !== undefined && proposed.tempoEnabled !== false) parts.push(`tempo ${trim(tempo)} BPM`);
      else if (proposed.tempoEnabled === false) parts.push("tempo off");
      const numerator = number(proposed.signatureNumerator); const denominator = number(proposed.signatureDenominator);
      if (numerator !== undefined && denominator !== undefined) parts.push(`${numerator}/${denominator}`);
      if (number(proposed.colorIndex) !== undefined) parts.push("colour");
      return { title: `Scene: ${parts.join(", ") || "settings"}` };
    },
  },
  {
    tool: "capture_scene", since: FIXED_BRIDGE, preview: "live_scene_capture_preview", apply: "live_scene_capture_apply", family: "structure", restructures: true,
    description: "Capture the clips playing now into a new scene (Live's Capture and Insert Scene).",
    summarize() { return { title: "Captured the playing clips into a new scene" }; },
  },
  {
    tool: "switch_device", preview: "live_device_preview", apply: "live_device_apply", family: "device",
    description: "Switch a device on or off (its Device On button): deviceRef from discovery, enabled true or false.",
    inputSchema: { type: "object", additionalProperties: false, required: ["deviceRef", "enabled"], properties: { deviceRef: REF, enabled: { type: "boolean" } } },
    prepare(input) { return { action: "enable", deviceRef: input.deviceRef ?? null, enabled: input.enabled === true }; },
    summarize(_preview, input, track) {
      const known = ownerTrack(input.deviceRef, track);
      return withTrack({ title: `${input.enabled === true ? "Switched on" : "Switched off"} a device${known ? ` on ${known.name}` : ""}` }, known);
    },
  },
  {
    tool: "move_device", since: FIXED_BRIDGE, preview: "live_device_preview", apply: "live_device_apply", family: "device",
    description: "Move a device along its own track's chain: deviceRef, and index (0 is first; -1 is last). To another track or into a rack's chain, use move_device_to.",
    inputSchema: { type: "object", additionalProperties: false, required: ["deviceRef", "index"], properties: { deviceRef: REF, index: { type: "integer", minimum: -1, maximum: 256 } } },
    prepare(input) { return { action: "move", deviceRef: input.deviceRef ?? null, index: input.index ?? null }; },
    summarize(_preview, input, track) {
      const known = ownerTrack(input.deviceRef, track); const index = number(input.index);
      return withTrack({ title: `Moved a device ${index === 0 ? "to the start" : index === -1 ? "to the end" : `to position ${(index ?? 0) + 1}`}${known ? ` on ${known.name}` : ""}` }, known);
    },
  },
  {
    tool: "move_device_to", preview: "live_device_advanced_preview", apply: "live_device_advanced_apply", family: "device",
    description: "Move a device to another track (targetTrackRef) or into a rack's chain (targetChainRef), at index (0 is first).",
    inputSchema: { type: "object", additionalProperties: false, required: ["deviceRef"], properties: {
      deviceRef: REF, targetTrackRef: REF, targetChainRef: REF, index: { type: "integer", minimum: 0, maximum: 256 } } },
    prepare(input) {
      if (!input.targetTrackRef && !input.targetChainRef) return "Say where: targetTrackRef or targetChainRef.";
      return { action: "move-cross", ref: input.deviceRef ?? null, ...(input.targetTrackRef ? { targetTrackRef: input.targetTrackRef } : {}), ...(input.targetChainRef ? { targetChainRef: input.targetChainRef } : {}), ...(typeof input.index === "number" ? { index: input.index } : {}) };
    },
    summarize(_preview, input, track) {
      const target = track(input.targetTrackRef);
      return withTrack({ title: `Moved a device to ${target ? target.name : "a rack's chain"}` }, target);
    },
  },
  {
    tool: "delete_device", since: FIXED_BRIDGE, preview: "live_device_delete_preview", apply: "live_device_delete_apply", family: "device",
    description: "Delete a device (ref from discovery). Live gives Kumi no undo for this, so do it only when the producer asks to remove it, and say it's gone for good (Live's own undo can still bring it back).",
    permanent: () => "Live gives Kumi no way to bring a deleted device back; use Live's own undo if you need to.",
    summarize(preview, input, track) {
      const device = record(preview.device); const known = ownerTrack(preview.ref ?? input.ref, track);
      return withTrack({ title: `Deleted ${label(device.name) ?? "a device"}${known ? ` from ${known.name}` : ""}` }, known);
    },
  },
  {
    tool: "set_chain", preview: "live_chain_preview", apply: "live_chain_apply", family: "device",
    description: "Change a rack chain: mute, solo, colorIndex (0–69) or autoColor. chainRef from discovery.",
    summarize(preview, input) {
      const proposed = record(preview.proposed ?? input);
      const parts: string[] = [];
      if (typeof (proposed.mute ?? input.mute) === "boolean") parts.push((proposed.mute ?? input.mute) ? "muted" : "unmuted");
      if (typeof (proposed.solo ?? input.solo) === "boolean") parts.push((proposed.solo ?? input.solo) ? "soloed" : "unsoloed");
      if (number(proposed.colorIndex ?? input.colorIndex) !== undefined || typeof (proposed.autoColor ?? input.autoColor) === "boolean") parts.push("colour");
      return { title: `${label(preview.rackName) ? `${label(preview.rackName)} · ` : ""}chain ${quoted(preview.chainName, "")} ${parts.join(", ") || "changed"}`.replace("  ", " ") };
    },
  },
  {
    tool: "set_song", since: FIXED_BRIDGE, preview: "live_song_settings_preview", apply: "live_song_settings_apply", family: "tempo",
    description: "Change the song's settings: time signature (signatureNumerator, signatureDenominator), swingAmount (0–1, used by the groove and Record Quantization), clipTriggerQuantization (0 none, 1 8 bars, 2 4 bars, 3 2 bars, 4 1 bar, 5 1/2, 6 1/2T, 7 1/4, 8 1/4T, 9 1/8, 10 1/8T, 11 1/16, 12 1/16T, 13 1/32) and midiRecordingQuantization (0 none, 1 1/4, 2 1/8, 3 1/8T, 4 1/8+1/8T, 5 1/16, 6 1/16T, 7 1/16+1/16T, 8 1/32).",
    summarize(preview) {
      const prior = record(preview.prior); const proposed = record(preview.proposed);
      const parts: string[] = [];
      const numerator = number(proposed.signatureNumerator); const denominator = number(proposed.signatureDenominator);
      if (numerator !== undefined || denominator !== undefined) parts.push(`time signature ${number(prior.signatureNumerator) ?? "?"}/${number(prior.signatureDenominator) ?? "?"} → ${numerator ?? prior.signatureNumerator}/${denominator ?? prior.signatureDenominator}`);
      const swing = number(proposed.swingAmount);
      if (swing !== undefined) parts.push(`swing ${Math.round((number(prior.swingAmount) ?? 0) * 100)}% → ${Math.round(swing * 100)}%`);
      if (number(proposed.clipTriggerQuantization) !== undefined) parts.push("launch quantization");
      if (number(proposed.midiRecordingQuantization) !== undefined) parts.push("record quantization");
      const text = parts.join(", ") || "song settings";
      return { title: text[0]!.toUpperCase() + text.slice(1) };
    },
  },
  {
    tool: "set_scale", since: FIXED_BRIDGE, preview: "live_tuning_preview", apply: "live_tuning_apply", family: "tempo",
    description: "Set the Set's scale (Live 12's Scale Mode, which Live's MIDI tools and devices follow): rootNote (0 C … 11 B) and scaleName as Live names it (Major, Minor, Dorian, …), or the tuning system.",
    summarize(_preview, input) {
      const root = number(input.rootNote);
      return { title: `Scale ${root !== undefined ? ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][root] ?? "" : ""} ${label(input.scaleName) ?? ""}`.replace(/\s+/g, " ").trim() };
    },
  },
  {
    tool: "set_groove", since: FIXED_BRIDGE, preview: "live_groove_preview", apply: "live_groove_apply", family: "tempo",
    description: "Groove: the global groove amount (action set-amount, grooveAmount 0–1.3), or one groove in the pool (action edit, grooveRef, with base, quantizationAmount, timingAmount, randomAmount, velocityAmount 0–1).",
    summarize(_preview, input) {
      return { title: input.action === "set-amount" && number(input.grooveAmount) !== undefined ? `Groove amount ${Math.round(number(input.grooveAmount)! * 100)}%` : "Groove edited" };
    },
  },
  {
    tool: "replace_sample", since: FIXED_BRIDGE, preview: "live_simpler_preview", apply: "live_simpler_apply", family: "device",
    description: "Swap the sample in a Simpler for another: deviceRef (the Simpler), and sample, a path find_samples returned.",
    inputSchema: { type: "object", additionalProperties: false, required: ["deviceRef", "sample"], properties: { deviceRef: REF, sample: { type: "string", minLength: 1, maxLength: 1024 } } },
    prepare(input, context) {
      const found = typeof input.sample === "string" ? context.sample(input.sample) : undefined;
      if (!found) return "Use a sample find_samples returned in this conversation.";
      return { deviceRef: input.deviceRef ?? null, filePath: found.path, allowedRoot: found.folder };
    },
    summarize(_preview, input, track) {
      const known = ownerTrack(input.deviceRef, track);
      const file = typeof input.filePath === "string" ? input.filePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : undefined;
      return withTrack({ title: `Simpler${known ? ` on ${known.name}` : ""} now plays ${quoted(file, "another sample")}` }, known);
    },
  },
  {
    tool: "import_audio", preview: "live_audio_import_preview", apply: "live_audio_import_apply", family: "clip",
    description: "Put an audio file into the Set as a clip: into an empty Session slot (trackRef, an audio track, and sceneIndex) or into an Arrangement take lane (takeLaneRef, position in beats). sample is a path find_samples returned.",
    inputSchema: { type: "object", additionalProperties: false, required: ["sample"], properties: {
      sample: { type: "string", minLength: 1, maxLength: 1024 }, trackRef: REF, sceneIndex: { type: "integer", minimum: 0, maximum: 10000 },
      takeLaneRef: REF, position: { type: "number", minimum: 0 }, name: { type: "string", maxLength: 256 } } },
    prepare(input, context) {
      const found = typeof input.sample === "string" ? context.sample(input.sample) : undefined;
      if (!found) return "Use an audio file find_samples returned in this conversation.";
      const { sample: _sample, ...rest } = input;
      return { ...rest, filePath: found.path, allowedRoot: found.folder };
    },
    summarize(_preview, input, track) {
      const known = track(input.trackRef);
      const file = typeof input.filePath === "string" ? input.filePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : undefined;
      const scene = number(input.sceneIndex); const position = number(input.position);
      return withTrack({ title: `Imported ${quoted(file, "audio")}${known ? ` on ${known.name}` : ""}${scene !== undefined ? `, scene ${scene + 1}` : position !== undefined ? ` at ${bars(position)}` : ""}` }, known);
    },
  },
  {
    tool: "set_warp_markers", since: FIXED_BRIDGE, preview: "live_warp_marker_preview", apply: "live_warp_marker_apply", family: "clip",
    description: "Add, move or delete a warp marker in an audio clip, by its beat time (move takes distance in beats). Read them first with live_warp_marker_read.",
    summarize(_preview, input, track) {
      const known = ownerTrack(input.clipRef, track);
      return withTrack({ title: `${known ? `${known.name} audio clip` : "Audio clip"}: warp marker ${label(input.action) === "add" ? "added" : label(input.action) === "delete" ? "removed" : "moved"}` }, known);
    },
  },
  {
    tool: "capture_midi", since: FIXED_BRIDGE, preview: "live_capture_midi_preview", apply: "live_capture_midi_apply", family: "clip",
    description: "Capture MIDI: turn what was just played on armed MIDI tracks into a clip (Live's Capture MIDI).",
    summarize() { return { title: "Captured MIDI into a clip" }; },
  },
  {
    tool: "set_device_details", since: FIXED_BRIDGE, preview: "live_device_specialized_preview", apply: "live_device_specialized_apply", family: "device",
    description: "Settings a device has beyond its parameters (EQ Eight's oversampling and band editing, Drift, Drum Cell, Hybrid Reverb, Meld and plug-in specifics), as the bridge describes them for the device.",
    summarize(_preview, input, track) {
      const known = ownerTrack(input.deviceRef ?? input.ref, track);
      return withTrack({ title: `Device settings changed${known ? ` on ${known.name}` : ""}` }, known);
    },
  },
  {
    tool: "use_looper", since: FIXED_BRIDGE, preview: "live_looper_preview", apply: "live_looper_apply", family: "device",
    description: "Operate or set a Looper device: record, overdub, play, stop, clear, undo, double or halve speed and length, as the bridge offers them.",
    summarize(_preview, input) { return { title: `Looper: ${label(input.action) ?? "settings"}` }; },
  },
];

/** Fields in the new tools that name Live objects; they must come from discovery in this turn. */
export const MORE_REFERENCE_FIELDS = ["targetRef", "targetTrackRef", "targetChainRef", "slotRef", "sceneRef", "takeLaneRef", "destinationTrackRef"] as const;
