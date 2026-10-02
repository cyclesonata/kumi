/**
 * A bridge in memory with a Session of clips and an Arrangement, for arranging's tests: shaped like the
 * real one's answers (previews with a transaction, applies with what they made, a guarded undo), and
 * behaving as Live does where arranging depends on it: a copy goes on its clip's own track, a copy over
 * another clip is refused, locators can't share a name or a place and wait for Live to stop.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ChangeRecord, JsonObject, KernelTool } from "../../src/core/contracts.js";
import type { McpEndpoint } from "../../src/mcp/client.js";
import { createAbletonIntegration } from "../../src/integrations/ableton/index.js";

export interface FixtureClip { name: string; beats: number; audio?: boolean; warped?: boolean; loopStart?: number }
export interface FixtureTrack { name: string; audio?: boolean; group?: boolean; clips?: Record<number, FixtureClip>; arrangement?: { start: number; end: number }[] }
interface Options {
  tracks: FixtureTrack[]; scenes: number;
  locators?: { name: string; position: number }[]; playing?: boolean; tempo?: number;
  /** Bridge tools this one doesn't have. */
  without?: string[];
  /** Refuse a preview (by tool, and its arguments): the refusal's words. */
  refuse?: (name: string, args: JsonObject) => string | undefined;
}

interface Clip { id: number; name: string; beats: number; audio: boolean; warped: boolean; loopStart: number; loopEnd: number }
interface Placed { id: number; start: number; end: number; name: string; from: string }
const EPOCH = 7;

export function arrangementBridge(options: Options) {
  const requests: { name: string; args: JsonObject }[] = [];
  const records: ChangeRecord[] = [];
  const actions: string[] = [];
  let ids = 0;
  const tracks = options.tracks.map((track) => ({
    name: track.name, audio: track.audio === true, group: track.group === true,
    slots: Array.from({ length: options.scenes }, (_, scene) => { const clip = track.clips?.[scene]; return clip ? { id: ++ids, name: clip.name, beats: clip.beats, audio: clip.audio ?? track.audio === true, warped: clip.warped ?? true, loopStart: clip.loopStart ?? 0, loopEnd: (clip.loopStart ?? 0) + clip.beats } as Clip | undefined : undefined; }),
    arrangement: (track.arrangement ?? []).map((item): Placed => ({ id: ++ids, start: item.start, end: item.end, name: "Earlier", from: "" })),
  }));
  let scenes = Array.from({ length: options.scenes }, (_, index) => `Scene ${index + 1}`);
  let locators = (options.locators ?? []).map((locator) => ({ id: ++ids, ...locator }));
  const state = { playing: options.playing === true, playhead: 0, steps: { open: 0, closed: 0 } };
  const names = ["live_status", "live_discover", "live_undo", "live_song_state", "live_undo_step_begin", "live_undo_step_end",
    "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_clip_properties_preview", "live_clip_properties_apply", "live_audio_clip_preview", "live_audio_clip_apply",
    "live_session_structure_preview", "live_session_structure_apply", "live_arrangement_section_preview", "live_arrangement_section_apply",
    "live_transport_preview", "live_transport_apply", "live_mixer_preview", "live_mixer_apply"].filter((name) => !(options.without ?? []).includes(name));
  const catalog: Tool[] = names.map((name) => ({ name, description: `bridge ${name}`, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));
  const wrap = (value: JsonObject): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const refusal = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }], structuredContent: { message: text } });
  const pending = new Map<string, { name: string; args: JsonObject; made?: JsonObject; prior?: JsonObject }>();
  let transactions = 0;
  const path = (ref: unknown, kind: string) => { const match = new RegExp(`^${EPOCH}:${kind}:(\\d+)(?::(\\d+))?$`).exec(String(ref)); return match ? [Number(match[1]), Number(match[2] ?? -1)] as const : undefined; };
  /** A track's Arrangement clips in time order, as Live lists them (their refs are positions in this). */
  const timeline = (index: number) => [...tracks[index]!.arrangement].sort((a, b) => a.start - b.start);
  const arrangementRef = (index: number, placed: Placed) => `${EPOCH}:arrangement_clip:${index}:${timeline(index).indexOf(placed)}`;
  const findPlaced = (id: number) => { for (const [index, track] of tracks.entries()) { const placed = track.arrangement.find((item) => item.id === id); if (placed) return { index, placed }; } return undefined; };
  const clipAt = (ref: unknown) => { const at = path(ref, "clip"); const clip = at ? tracks[at[0]]?.slots[at[1]] : undefined; return at && clip ? { track: at[0], scene: at[1], clip } : undefined; };
  const rows = (kind: string, parent: unknown): JsonObject[] => {
    const set = { ref: `${EPOCH}:set:song`, objectIdentity: "song", name: "Arrangement Fixture", tempo: options.tempo ?? 124, playing: state.playing, position: state.playhead };
    if (kind === "set") return [set];
    if (kind === "track") return tracks.map((track, index) => ({ ref: `${EPOCH}:track:${index}`, parentRef: set.ref, name: track.name, color: 0x808080, kind: track.group ? "group" : "regular", mediaKind: track.audio ? "audio" : "midi",
      playingSlotIndex: null }));
    if (kind === "selection") return [{ ref: `${EPOCH}:selection:0`, selectedTrackRef: `${EPOCH}:track:0` }];
    if (kind === "scene") return scenes.map((name, index) => ({ ref: `${EPOCH}:scene:${index}`, parentRef: set.ref, name, index }));
    if (kind === "locator") return [...locators].sort((a, b) => a.position - b.position).map((locator, index) => ({ ref: `${EPOCH}:locator:${index}`, name: locator.name, position: locator.position }));
    const track = path(parent, "track");
    if (kind === "clip-slot" && track) return (tracks[track[0]]?.slots ?? []).map((clip, scene) => ({ ref: `${EPOCH}:clip_slot:${track[0]}:${scene}`, parentRef: parent, sceneIndex: scene, clipRef: clip ? `${EPOCH}:clip:${track[0]}:${scene}` : null, empty: !clip }));
    if (kind === "arrangement-clip" && track) return timeline(track[0]).map((placed) => ({ ref: arrangementRef(track[0], placed), parentRef: parent, name: placed.name, start: placed.start, endTime: placed.end, length: placed.end - placed.start }));
    const slot = path(parent, "clip_slot");
    const clip = slot ? tracks[slot[0]]?.slots[slot[1]] : undefined;
    if (kind === "session-clip" && slot && clip) return [{ ref: `${EPOCH}:clip:${slot[0]}:${slot[1]}`, parentRef: parent, name: clip.name, length: clip.loopEnd - clip.loopStart, looping: true,
      loopStart: clip.loopStart, isAudio: clip.audio, warping: clip.audio ? clip.warped : null }];
    return [];
  };
  const endpoint: McpEndpoint = {
    pid: null, serverInfo: { name: "kumi-arrangement-bridge", version: "1.0.70" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
    async list() { return { tools: catalog }; },
    async call(name, args, signal) {
      signal.throwIfAborted(); requests.push({ name, args: structuredClone(args) });
      if (name === "live_status") return wrap({ connected: true, adapter: "remote-script", provenance: "fake-live", epoch: EPOCH });
      if (name === "live_song_state") return wrap({ songLength: 64, signatureNumerator: 4, signatureDenominator: 4 });
      if (name === "live_discover") return wrap({ epoch: EPOCH, kind: args.kind, items: rows(String(args.kind), args.parent), revision: "r1", truncated: false });
      if (name === "live_undo_step_begin") { state.steps.open++; return wrap({ open: true, stepId: `undo-step-${state.steps.open}` }); }
      if (name === "live_undo_step_end") { state.steps.closed++; return wrap({ closed: true, stepId: args.stepId ?? null }); }
      if (name.endsWith("_preview")) {
        const refused = options.refuse?.(name, args);
        if (refused) return refusal(refused);
        const id = `tx${++transactions}`; const base = { transactionId: id, epoch: EPOCH, confirmation: "apply" };
        pending.set(id, { name, args });
        if (name === "live_clip_duplicate_preview") {
          if (!clipAt(args.clipRef)) return refusal("clip duplication requires an authoritative Session source clip");
          return wrap({ ...base, source: args.clipRef, destination: args.arrangementPosition !== undefined ? { arrangementPosition: args.arrangementPosition } : { trackRef: args.targetTrackRef, sceneIndex: args.targetSceneIndex } });
        }
        if (name === "live_clip_properties_preview" || name === "live_audio_clip_preview") {
          const found = clipAt(args.clipRef);
          if (!found) return refusal("clip reference is stale or invalid");
          if (name === "live_clip_properties_preview" && found.clip.audio && args.loopEnd !== undefined) return refusal("audio clip loop editing uses live_audio_clip_preview");
          return wrap({ ...base, clipRef: args.clipRef, prior: { loopEnd: found.clip.loopEnd }, proposed: { loopEnd: args.loopEnd } });
        }
        if (name === "live_session_structure_preview") return wrap({ ...base, prior: { tracks: tracks.map((track, index) => ({ ref: `${EPOCH}:track:${index}`, name: track.name, index })), scenes: scenes.map((scene, index) => ({ ref: `${EPOCH}:scene:${index}`, name: scene, index })) },
          proposed: (Array.isArray(args.scenes) ? args.scenes as JsonObject[] : []).map((scene) => ({ kind: "scene", name: scene.name, index: scene.index })) });
        if (name === "live_arrangement_section_preview") {
          if (locators.some((locator) => locator.name === args.startName || locator.name === args.endName || locator.position === args.start || locator.position === args.end)) return refusal("Arrangement locator target collides with existing state");
          return wrap({ ...base, prior: locators, proposed: [{ name: args.startName, position: args.start }, { name: args.endName, position: args.end }] });
        }
        if (name === "live_transport_preview") return wrap({ ...base, prior: { position: state.playhead }, proposed: { position: args.position } });
        if (name === "live_mixer_preview") return wrap({ ...base, trackRef: args.trackRef, prior: { volume: 0.85 }, proposed: { volume: args.volume } });
        return wrap(base);
      }
      if (name.endsWith("_apply")) {
        const transaction = pending.get(String(args.transactionId));
        assert(transaction, "apply names a previewed transaction");
        const given = transaction.args;
        if (transaction.name === "live_clip_duplicate_preview") {
          const found = clipAt(given.clipRef)!;
          if (typeof given.arrangementPosition === "number") {
            const start = given.arrangementPosition; const end = start + found.clip.loopEnd - found.clip.loopStart;
            // Like Live: a copy over another clip cuts or replaces it, which the bridge refuses (and takes back).
            if (tracks[found.track]!.arrangement.some((item) => start < item.end - 1e-9 && item.start < end - 1e-9)) return refusal("arrangement duplication did not produce one identity-distinct clip");
            const placed: Placed = { id: ++ids, start, end, name: found.clip.name, from: String(given.clipRef) };
            tracks[found.track]!.arrangement.push(placed);
            transaction.made = { placed: placed.id };
            return wrap({ transactionId: args.transactionId, state: "applied", created: { ref: arrangementRef(found.track, placed), objectIdentity: `clip-${placed.id}`, name: placed.name, fingerprint: "f" } });
          }
          const target = path(given.targetTrackRef, "track")!; const scene = Number(given.targetSceneIndex);
          if (target[0] !== found.track) return refusal("the fixture copies within a track");
          if (tracks[target[0]]!.slots[scene]) return refusal("target Session slot is occupied");
          tracks[target[0]]!.slots[scene] = { ...found.clip, id: ++ids };
          transaction.made = { slot: [target[0], scene], copy: ids, loopEnd: found.clip.loopEnd };
          return wrap({ transactionId: args.transactionId, state: "applied", created: { ref: `${EPOCH}:clip:${target[0]}:${scene}`, objectIdentity: `clip-${ids}`, name: found.clip.name, fingerprint: "f" } });
        }
        if (transaction.name === "live_clip_properties_preview" || transaction.name === "live_audio_clip_preview") {
          const found = clipAt(given.clipRef)!;
          transaction.prior = { loopEnd: found.clip.loopEnd };
          if (typeof given.loopEnd === "number") found.clip.loopEnd = given.loopEnd;
          return wrap({ transactionId: args.transactionId, state: "applied" });
        }
        if (transaction.name === "live_session_structure_preview") {
          const created: JsonObject[] = [];
          for (const scene of Array.isArray(given.scenes) ? given.scenes as JsonObject[] : []) {
            const at = typeof scene.index === "number" ? Math.min(scene.index, scenes.length) : scenes.length;
            scenes = [...scenes.slice(0, at), String(scene.name), ...scenes.slice(at)];
            for (const track of tracks) track.slots.splice(at, 0, undefined);
            created.push({ kind: "scene", ref: `${EPOCH}:scene:${at}`, name: scene.name });
          }
          transaction.made = { scenes: created.map((item) => Number(String(item.ref).split(":").at(-1))) };
          return wrap({ transactionId: args.transactionId, state: "applied", created });
        }
        if (transaction.name === "live_arrangement_section_preview") {
          // Like Live: a locator moves the playhead, which it won't while playing.
          if (state.playing) return refusal("stop playback before adding or removing a locator");
          const made = [{ id: ++ids, name: String(given.startName), position: Number(given.start) }, { id: ++ids, name: String(given.endName), position: Number(given.end) }];
          locators.push(...made); state.playhead = Number(given.end);
          transaction.made = { locators: made.map((item) => item.id) };
          return wrap({ transactionId: args.transactionId, state: "applied", locators: made });
        }
        if (transaction.name === "live_transport_preview") { transaction.prior = { position: state.playhead }; state.playhead = Number(given.position); }
        return wrap({ transactionId: args.transactionId, state: "applied" });
      }
      if (name === "live_undo") {
        const transaction = pending.get(String(args.transactionId));
        if (!transaction) return refusal("Unknown or expired transaction");
        const made = transaction.made ?? {};
        if (typeof made.placed === "number") { const found = findPlaced(made.placed); if (found) tracks[found.index]!.arrangement = tracks[found.index]!.arrangement.filter((item) => item !== found.placed); }
        if (Array.isArray(made.slot)) {
          const [track, scene] = made.slot as number[]; const copy = tracks[track!]!.slots[scene!];
          // Like the bridge: a copy that changed since (its loop still shortened) isn't deleted.
          if (copy && copy.id === made.copy && copy.loopEnd !== made.loopEnd) return refusal("Session clip identity or content changed after apply; undo refused");
          if (copy && copy.id === made.copy) tracks[track!]!.slots[scene!] = undefined;
        }
        if (transaction.prior && typeof transaction.prior.loopEnd === "number") { const found = clipAt(transaction.args.clipRef); if (found) found.clip.loopEnd = transaction.prior.loopEnd; }
        if (transaction.prior && typeof transaction.prior.position === "number") state.playhead = transaction.prior.position;
        if (Array.isArray(made.scenes)) {
          for (const at of [...made.scenes as number[]].sort((a, b) => b - a)) {
            if (tracks.some((track) => track.slots[at])) return refusal("created Session structure was modified after apply; undo refused");
            scenes = scenes.filter((_, index) => index !== at); for (const track of tracks) track.slots.splice(at, 1);
          }
        }
        if (Array.isArray(made.locators)) locators = locators.filter((locator) => !(made.locators as number[]).includes(locator.id));
        (transaction as { undone?: boolean }).undone = true;
        return wrap({ transactionId: args.transactionId, state: "undone" });
      }
      return wrap({});
    },
    onCatalogChanged() { return () => {}; },
    onDisconnect() { return () => {}; },
    onLiveEvent() { return () => {}; },
    async close() {},
  };
  const integration = createAbletonIntegration({ connect: async () => endpoint, onConnection: () => {}, onChange: (change) => records.push(change), onAction: (action) => actions.push(action.title),
    changeTimeoutMs: 2_000, reconnectIntervalMs: 10, restoreFile: join(mkdtempSync(join(tmpdir(), "kumi-restore-")), "audition-restore.json") });
  return {
    integration, requests, records, actions, state,
    /** Each track's Arrangement: its clips' names and where they start and end, in bars from 1. */
    arrangement: () => Object.fromEntries(tracks.map((track, index) => [track.name, timeline(index).map((item) => `${item.name} ${item.start / 4 + 1}–${item.end / 4 + 1}`)])),
    session: () => tracks.map((track) => track.slots.map((clip) => clip ? `${clip.name}:${clip.loopEnd - clip.loopStart}` : "")),
    scenes: () => [...scenes], locators: () => [...locators].sort((a, b) => a.position - b.position).map((locator) => `${locator.name}@${locator.position / 4 + 1}`),
    play: (playing: boolean) => { state.playing = playing; },
  };
}

export const signal = () => new AbortController().signal;
export function tool(tools: readonly KernelTool[], name: string) { const found = tools.find((item) => item.name === name); assert(found, `${name} is offered`); return found; }
export async function arranged(options: Options) {
  const b = arrangementBridge(options);
  await b.integration.start(signal());
  const observation = await b.integration.observe(signal());
  return Object.assign(b, { tools: observation.tools, observation });
}
