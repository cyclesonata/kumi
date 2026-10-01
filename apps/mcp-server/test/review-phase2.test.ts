import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, SAMPLE_FIELDS, type AsyncLiveAdapter, type LiveInvocation } from "../src/live.js";

// Review of the phase-2 tools, on rows as the Remote Script has them: a track's kind is regular, group,
// return or main and its media audio or MIDI; Arrangement clips end at their endTime.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
type Body = Record<string, any>;

function hosted(adapter: ConstructorParameters<typeof McpHost>[0]) {
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const call = async (name: string, args: unknown): Promise<Body> => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any; assert.ok(answer.result, JSON.stringify(answer.error)); return { ...JSON.parse(answer.result.content[0].text), ...(answer.result.isError ? { isError: true } : {}) }; };
  let keys = 0;
  const apply = (tool: string, transactionId: string, key = `review-${++keys}`) => call(tool, { transactionId, confirmation: "apply", idempotencyKey: key });
  const change = async (preview: string, args: unknown): Promise<{ previewed: Body; applied: Body }> => { const previewed = await call(preview, args); assert.ok(previewed.transactionId, JSON.stringify(previewed)); const applied = await apply(preview.replace(/_preview$/, "_apply"), previewed.transactionId); assert.equal(applied.state, "applied", JSON.stringify(applied)); return { previewed, applied }; };
  const undo = (transactionId: string) => call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: `review-undo-${++keys}` });
  return { call, apply, change, undo };
}
const state = (simulator: DeterministicLiveSimulator) => (simulator as unknown as { state: { tracks: Array<Record<string, any>>; arrangementClips: Array<{ clip: Record<string, any>; trackRef: string }> } }).state;
function track(simulator: DeterministicLiveSimulator, ref: string, kind: string, mediaKind?: string, extra: Record<string, unknown> = {}) {
  const row = { ...structuredClone(state(simulator).tracks[0]), ref, objectIdentity: `simulator:${ref}`, name: ref.split(":")[1], kind, ...(mediaKind ? { mediaKind } : { mediaKind: undefined }), clips: [], clipSlots: [], devices: [], ...extra };
  state(simulator).tracks.push(row); return row;
}

test("the extension's tools take tracks as the Remote Script describes them: kind regular with an audio or MIDI media", async () => {
  const simulator = new DeterministicLiveSimulator();
  track(simulator, "track:vox", "regular", "audio"); track(simulator, "track:bus", "group"); track(simulator, "track:reverb", "return", "audio"); track(simulator, "track:main", "main", "audio");
  assert.equal(state(simulator).tracks[0]!.kind, "regular"); assert.equal(state(simulator).tracks[0]!.mediaKind, "midi");
  const { call, change } = hosted(simulator);
  const rendered = await call("live_render_offline", { trackRef: "track:vox", fromBeat: 0, toBeat: 4 });
  assert.equal(rendered.isError, undefined, JSON.stringify(rendered)); assert.equal(rendered.name, "vox");
  assert.match((await call("live_render_offline", { trackRef: "track:track-1", fromBeat: 0, toBeat: 4 })).reason, /isn't an audio track/);
  assert.match((await call("live_render_offline", { trackRef: "track:bus", fromBeat: 0, toBeat: 4 })).reason, /is a group/);
  for (const ref of ["track:reverb", "track:main"]) {
    assert.match((await call("live_render_offline", { trackRef: ref, fromBeat: 0, toBeat: 4 })).reason, /isn't an audio track/, ref);
    assert.match((await call("live_arrangement_midi_clip_preview", { trackRef: ref, start: 0, length: 4, notes: [] })).reason, /isn't a MIDI track/, ref);
    assert.match((await call("live_clip_clear_range_preview", { trackRef: ref, fromBeat: 0, toBeat: 4 })).reason, /no Arrangement clips of its own/, ref);
  }
  await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 0, length: 4, name: "Hook", notes: [{ pitch: 60, start: 0, duration: 1 }] });
  assert.equal((await call("live_clip_clear_range_preview", { trackRef: "track:track-1", fromBeat: 0, toBeat: 4 })).removes.length, 1);
});

