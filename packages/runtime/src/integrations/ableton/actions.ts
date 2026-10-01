/**
 * What Kumi does in Live that isn't a change to the Set: playing and stopping, launching clips
 * and scenes, recording, jumping to a locator, and showing the producer something (selecting a
 * track, switching views). They run as the bridge's preview and apply, like changes, but leave
 * no HISTORY entry: there's nothing in the Set to undo. NOW shows each as it happens.
 */
import type { JsonObject } from "../../core/contracts.js";
import type { KnownTrack } from "./changes.js";
import { ARRANGEMENT_BRIDGE, FIXED_BRIDGE } from "./bridge-version.js";
import { bars } from "./more-changes.js";

export interface ActionKind {
  tool: string;
  preview: string;
  apply: string;
  description: string;
  /** The model's input, when it differs from the bridge preview's. */
  inputSchema?: JsonObject;
  /** The first bridge version this works with in real Live; older bridges don't get the tool. */
  since?: string;
  /** Actions (by their `action` value) that need a later bridge than the tool does. */
  newer?: Record<string, string>;
  prepare?(input: JsonObject): JsonObject | string;
  /** What happened, for NOW and the answer; `playing` when the transport is now running, false when stopped. */
  summarize(preview: JsonObject, input: JsonObject, track: (ref: unknown) => KnownTrack | undefined): { title: string; playing?: boolean; recording?: boolean };
}

const record = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const REF = { type: "string", minLength: 1, maxLength: 256 } as const;
/** The bridge wants a word that the output is safe to play; Kumi gives it only because the producer asked to hear it. */
const SAFETY = { safe: true, provenance: "The producer asked Kumi to play this in their own Set.", scope: "open Set" };

const TRANSPORT = ["start", "continue", "stop", "play-selection", "stop-all-clips", "back-to-arrangement", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record"] as const;
const WORDS: Record<string, { title: string; playing?: boolean; recording?: boolean }> = {
  start: { title: "Playing from the start marker", playing: true }, continue: { title: "Playing on from where it stopped", playing: true },
  stop: { title: "Stopped", playing: false }, "play-selection": { title: "Playing the selection", playing: true },
  "stop-all-clips": { title: "Stopped all clips" }, "tap-tempo": { title: "Tapped the tempo" }, "nudge-up": { title: "Nudged ahead" }, "nudge-down": { title: "Nudged back" },
  "re-enable-automation": { title: "Automation back on" }, "trigger-session-record": { title: "Session recording", recording: true },
  "back-to-arrangement": { title: "Back to the Arrangement" },
};

export const ACTIONS: readonly ActionKind[] = [
  {
    tool: "play", since: FIXED_BRIDGE, preview: "live_transport_action_preview", apply: "live_transport_action_apply",
    description: "Play, stop and the like: start (from the start marker; set it first with set_transport's position), continue (from where it stopped), stop, play-selection, stop-all-clips, back-to-arrangement (Live's Back to Arrangement button: tracks that followed their Session clips play the Arrangement again), tap-tempo, nudge-up and nudge-down, re-enable-automation, trigger-session-record. Use it whenever hearing or stopping helps: to check or show what you built, or to record.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: [...TRANSPORT] } } },
    newer: { "back-to-arrangement": ARRANGEMENT_BRIDGE },
    summarize(_preview, input) { return WORDS[String(input.action)] ?? { title: "Transport" }; },
  },
  {
    tool: "fire_scene", since: FIXED_BRIDGE, preview: "live_scene_fire_preview", apply: "live_scene_fire_apply",
    description: "Launch a scene (every clip in its row), as clicking its launch button does. ref is the scene from discovery.",
    summarize(preview) { return { title: "Launched a scene", playing: true, ...(record(preview.fireState).playing ? {} : {}) }; },
  },
  {
    tool: "launch_clip", preview: "live_clip_launch_preview", apply: "live_clip_launch_apply",
    description: "Launch one Session clip to hear it: slotRef is its clip slot, from discovery.",
    inputSchema: { type: "object", additionalProperties: false, required: ["slotRef"], properties: { slotRef: REF } },
    prepare(input) { return { slotRef: input.slotRef ?? null, outputSafety: SAFETY }; },
    summarize(_preview, input, track) {
      const match = typeof input.slotRef === "string" ? /^(\d+):(?:clip_slot|slot):(\d+):(\d+)/.exec(input.slotRef) : null;
      const known = match ? track(`${match[1]}:track:${match[2]}`) : undefined;
      return { title: `Playing the clip in ${known ? known.name : "its slot"}${match ? `, scene ${Number(match[3]) + 1}` : ""}`, playing: true };
    },
  },
  {
    tool: "record", since: FIXED_BRIDGE, preview: "live_recording_preview", apply: "live_recording_apply",
    description: "Start or stop recording: action start or stop, lane session or arrangement, and destinationTrackRef, the armed track (arm it with set_routing first). Live records onto one armed track only, so Kumi disarms any other first and says which. Recording keeps what it records in the Set; stop it with action stop.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action", "lane"], properties: {
      action: { type: "string", enum: ["start", "stop"] }, lane: { type: "string", enum: ["session", "arrangement"] }, destinationTrackRef: REF,
      alsoTrackRefs: { type: "array", maxItems: 7, items: REF, description: "More armed tracks recorded at the same time (bridge 1.0.47): several sources rendered in one pass" } } },
    prepare(input) {
      return { action: input.action, lane: input.lane, intent: input.action === "start" ? "The producer asked Kumi to record." : "The producer asked Kumi to stop recording.",
        ...(input.destinationTrackRef ? { destinationTrackRef: input.destinationTrackRef } : {}),
        ...(input.action === "start" && Array.isArray(input.alsoTrackRefs) && input.alsoTrackRefs.length ? { alsoTrackRefs: input.alsoTrackRefs } : {}), outputSafety: SAFETY };
    },
    summarize(_preview, input, track) {
      const known = track(input.destinationTrackRef);
      return input.action === "start" ? { title: `Recording${input.lane === "arrangement" ? " in the Arrangement" : ""}${known ? ` on ${known.name}` : ""}`, recording: true }
        : { title: "Recording stopped", recording: false };
    },
  },
  {
    tool: "jump_to_locator", preview: "live_locator_jump_preview", apply: "live_locator_jump_apply",
    description: "Move the playhead to a locator: direction next or previous, or ref for a particular one.",
    summarize(preview) {
      const target = typeof preview.target === "number" ? preview.target : undefined;
      return { title: target !== undefined ? `Playhead to ${bars(target)}` : "Playhead to the next locator" };
    },
  },
  {
    tool: "select", since: FIXED_BRIDGE, preview: "live_selection_preview", apply: "live_selection_apply",
    description: "Show the producer something by selecting it in Live: trackRef, sceneRef, slotRef, detailClipRef (opens it in the Clip view) or chainRef. Use it whenever showing something helps: where a thing is, or what you just built. (Live's scripting can't select a device or a parameter reliably: select its track, or its chain, instead.)",
    // What Live's scripting really selects. Song.View.select_device was tried (bridge 1.0.42–1.0.44): on real
    // Live the selection lagged or landed elsewhere, so devices and parameters aren't offered.
    inputSchema: { type: "object", additionalProperties: false, properties: { trackRef: REF, sceneRef: REF, slotRef: REF, detailClipRef: REF, chainRef: REF } },
    summarize(_preview, input, track) {
      const known = track(input.trackRef);
      return { title: known ? `Selected ${known.name}` : input.detailClipRef ? "Showing the clip" : input.chainRef ? "Showing the chain" : "Selected it in Live" };
    },
  },
  {
    tool: "show", preview: "live_view_preview", apply: "live_view_apply",
    description: "Change what Live shows: focus-view with view Session, Arranger, Detail, Detail/Clip, Detail/DeviceChain or Browser; hide-view; zoom-in, zoom-out, scroll-left, scroll-right; follow-on, follow-off; collapse-track or expand-track (trackRef); browser-toggle.",
    summarize(_preview, input) {
      const view = typeof input.view === "string" ? input.view.replace("Arranger", "Arrangement").replace("Detail/", "") : undefined;
      return { title: input.action === "focus-view" && view ? `Showing the ${view}` : `View: ${String(input.action ?? "changed").replace(/-/g, " ")}` };
    },
  },
];
