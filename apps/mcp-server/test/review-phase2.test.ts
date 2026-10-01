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

test("undo of an Arrangement clip Kumi made leaves it, with the producer's edits, when its notes, name or extent changed", async () => {
  const simulator = new DeterministicLiveSimulator(); simulator.discoveryBudgetItems = 1;
  const { change, undo } = hosted(simulator);
  const notes = [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 }];
  for (const [index, edit] of (["notes", "name", "extent"] as const).entries()) {
    const made = await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: index * 8, length: 4, name: `Hook ${index}`, notes });
    const clip = state(simulator).arrangementClips.find((item) => item.clip.name === `Hook ${index}`)!.clip;
    const prior = structuredClone(clip);
    if (edit === "notes") clip.notes.push({ ...clip.notes[0], pitch: 67, id: 99 });
    else if (edit === "name") clip.name = "Hook (producer's)";
    else clip.length = 6;
    const refused = await undo(made.previewed.transactionId);
    assert.equal(refused.isError, true); assert.match(refused.reason, /has been edited since .*it stays, with those edits/, edit);
    assert.ok(state(simulator).arrangementClips.some((item) => item.clip.objectIdentity === clip.objectIdentity), edit);
    Object.assign(clip, prior); clip.notes = prior.notes;
    assert.equal((await undo(made.previewed.transactionId)).state, "undone", edit);
  }
});

test("a retry of an Arrangement clip change that Live made finds the clip on a later page instead of making it again", async () => {
  const simulator = new DeterministicLiveSimulator(); simulator.discoveryBudgetItems = 1;
  let fail = false;
  const adapter = Object.assign(Object.create(simulator), { invokeAsync: async (invocation: LiveInvocation) => { const result = await simulator.invokeAsync(invocation); if (fail && invocation.operation === "arrangement.midi-clip.create") { fail = false; throw new Error("the answer was lost on the way"); } return result; } }) as AsyncLiveAdapter;
  const { call, apply, change } = hosted(adapter);
  for (const [index, name] of ["A", "B"].entries()) await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: index * 4, length: 4, name, notes: [] });
  const previewed = await call("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 8, length: 4, name: "C", notes: [] });
  fail = true;
  assert.equal((await apply("live_arrangement_midi_clip_apply", previewed.transactionId, "lost-answer-key")).isError, true);
  const retried = await apply("live_arrangement_midi_clip_apply", previewed.transactionId, "lost-answer-key");
  assert.deepEqual([retried.state, retried.reconciled], ["applied", true]);
  assert.deepEqual(state(simulator).arrangementClips.map((item) => item.clip.name), ["A", "B", "C"]);
  // A retry that finds nothing makes the clips only while the Arrangement is as previewed.
  const next = await call("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 12, length: 4, name: "D", notes: [] });
  const failing = Object.assign(Object.create(simulator), { invokeAsync: async (invocation: LiveInvocation) => { if (invocation.operation === "arrangement.midi-clip.create") throw new Error("Live was busy"); return simulator.invokeAsync(invocation); } }) as AsyncLiveAdapter;
  void failing;
  fail = false;
  state(simulator).arrangementClips.push({ clip: { ...structuredClone(state(simulator).arrangementClips[0]!.clip), ref: "arrangement-clip:producer", objectIdentity: "simulator:arrangement-clip:producer", name: "Producer's", start: 20 }, trackRef: "track:track-1" });
  assert.match((await apply("live_arrangement_midi_clip_apply", next.transactionId, "next-key")).reason, /changed since the preview/);
});

test("an Arrangement clip's extent is its endTime: a looped clip past its loop length is cut by a range it reaches", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { change } = hosted(simulator);
  await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 0, length: 4, name: "Loop", notes: [] });
  // Looped on in Live, the clip plays to beat 16 though its loop is 4 beats long.
  state(simulator).arrangementClips[0]!.clip.endTime = 16;
  const cleared = await change("live_clip_clear_range_preview", { trackRef: "track:track-1", fromBeat: 8, toBeat: 12 });
  assert.deepEqual(cleared.previewed.cuts.map((clip: { name: string; end: number }) => [clip.name, clip.end]), [["Loop", 16]]);
});

