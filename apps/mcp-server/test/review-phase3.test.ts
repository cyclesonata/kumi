import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LiveMutationNotDispatchedError, type AsyncLiveAdapter, type LiveDiscoveryRequest, type LiveInvocation, type LiveOperationContext, type LiveSnapshotRequest } from "../src/live.js";

// Review of the merged phase 3: undo's checks, fences and pages, on rows as the Remote Script has them.

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
  const undo = (transactionId: string, key = `review-undo-${++keys}`) => call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: key });
  return { host, call, apply, change, undo };
}
const state = (simulator: DeterministicLiveSimulator) => (simulator as unknown as { state: { tracks: Array<Record<string, any>>; arrangementClips: Array<{ clip: Record<string, any>; trackRef: string }> } }).state;

/** The simulator, with reads and changes that fail when a test says so: `invoke` loses a change's
 * answer after Live made it, `refuse` refuses one before it runs, as the Remote Script says it. */
function faulty(simulator: DeterministicLiveSimulator) {
  const faults: { read?: (request: LiveDiscoveryRequest | LiveSnapshotRequest | undefined) => boolean; invoke?: (invocation: LiveInvocation) => boolean; refuse?: (invocation: LiveInvocation) => boolean } = {};
  const adapter = Object.assign(Object.create(simulator), {
    discoverAsync: async (request: LiveDiscoveryRequest) => { if (faults.read?.(request)) { faults.read = undefined; throw new Error("request failed: invalid discovery cursor"); } return simulator.discoverAsync(request); },
    snapshotAsync: async (context?: LiveOperationContext, request?: LiveSnapshotRequest) => { if (faults.read?.(request)) { faults.read = undefined; throw new Error("remote adapter request timed out"); } return simulator.snapshotAsync(context, request); },
    invokeAsync: async (invocation: LiveInvocation) => {
      if (faults.refuse?.(invocation)) { faults.refuse = undefined; throw new LiveMutationNotDispatchedError("request failed: Live state changed since the preview; nothing changed"); }
      const result = await simulator.invokeAsync(invocation); if (faults.invoke?.(invocation)) { faults.invoke = undefined; throw new Error("remote adapter request timed out"); } return result;
    },
  }) as AsyncLiveAdapter;
  return { adapter, faults };
}

test("an undo whose checks can't read Live leaves its change applied, and undoing again checks afresh", async () => {
  const simulator = new DeterministicLiveSimulator(); simulator.discoveryBudgetItems = 1;
  const { adapter, faults } = faulty(simulator);
  const { change, undo } = hosted(adapter);
  const made = await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 0, length: 4, name: "Hook", notes: [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 }] });
  const clip = state(simulator).arrangementClips.find((item) => item.clip.name === "Hook")!.clip;
  clip.notes.push({ ...clip.notes[0], pitch: 67, id: 99 });
  // The clip's second page of notes can't be read: the check stops there, with nothing changed.
  faults.read = (request) => (request as LiveDiscoveryRequest | undefined)?.kind === "note" && (request as LiveDiscoveryRequest).cursor !== undefined;
  const stopped = await undo(made.previewed.transactionId, "same-key");
  assert.equal(stopped.isError, true); assert.match(stopped.reason, /^Undo stopped before it changed anything in Live/); assert.match(stopped.remediation, /Nothing changed in Live/);
  // Undoing again with the same key checks again: the producer's edit keeps the clip.
  const again = await undo(made.previewed.transactionId, "same-key");
  assert.equal(again.isError, true); assert.match(again.reason, /has been edited since/);
  assert.ok(state(simulator).arrangementClips.some((item) => item.clip.objectIdentity === clip.objectIdentity));
});

test("any undo that stops before its first change leaves the change applied; one stopped after a change stays uncertain", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { adapter, faults } = faulty(simulator);
  const { change, undo } = hosted(adapter);
  const mixed = await change("live_mixer_preview", { trackRef: "track:track-1", volume: 0.5 });
  faults.read = () => true;
  const stopped = await undo(mixed.previewed.transactionId);
  assert.equal(stopped.isError, true); assert.match(stopped.reason, /^Undo stopped before it changed anything in Live/);
  assert.equal(state(simulator).tracks[0]!.volume, 0.5);
  // Still applied: an undo with a new key runs.
  assert.equal((await undo(mixed.previewed.transactionId)).state, "undone"); assert.equal(state(simulator).tracks[0]!.volume, 0.85);
  // The change was sent and its answer lost: the undo is uncertain, and only its own key may finish it.
  const again = await change("live_mixer_preview", { trackRef: "track:track-1", volume: 0.4 });
  faults.invoke = (invocation) => invocation.operation === "mixer.set";
  const lost = await undo(again.previewed.transactionId, "lost-answer");
  assert.equal(lost.isError, true); assert.doesNotMatch(lost.reason, /stopped before/);
  assert.match((await undo(again.previewed.transactionId)).reason, /exact-key uncertain/);
});

test("undo of a clip Kumi copied into the Arrangement leaves it when its notes changed, even to as many notes", async () => {
  const simulator = new DeterministicLiveSimulator(); simulator.discoveryBudgetItems = 1;
  const source = state(simulator).tracks[0]!.clips[0]; source.notes.push({ ...source.notes[0], pitch: 38, start: 1, id: 2 });
  const { change, undo } = hosted(simulator);
  const copied = await change("live_clip_duplicate_preview", { clipRef: "clip:clip-1", arrangementPosition: 8 });
  const clip = state(simulator).arrangementClips[0]!.clip; const prior = structuredClone(clip.notes);
  // Re-voiced: as many notes, other pitches.
  clip.notes = clip.notes.map((note: Record<string, any>) => ({ ...note, pitch: note.pitch + 2 }));
  const refused = await undo(copied.previewed.transactionId);
  assert.equal(refused.isError, true); assert.match(refused.reason, /modified after creation/);
  assert.equal(state(simulator).arrangementClips.length, 1);
  clip.notes = prior;
  assert.equal((await undo(copied.previewed.transactionId)).state, "undone");
  assert.equal(state(simulator).arrangementClips.length, 0);
});

test("clearing a range is refused when a looped clip was extended into it after the preview", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, apply, change } = hosted(simulator);
  await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 0, length: 4, name: "Loop", notes: [] });
  await change("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 8, length: 2, name: "Fill", notes: [] });
  const previewed = await call("live_clip_clear_range_preview", { trackRef: "track:track-1", fromBeat: 6, toBeat: 12 });
  assert.deepEqual([previewed.removes.map((row: Body) => row.name), previewed.cuts], [["Fill"], []]);
  // The producer drags the loop out to beat 7: same start and loop length, a later end.
  const loop = state(simulator).arrangementClips.find((item) => item.clip.name === "Loop")!.clip; loop.endTime = 7;
  const refused = await apply("live_clip_clear_range_apply", previewed.transactionId);
  assert.equal(refused.isError, true); assert.match(refused.reason, /changed since the preview/);
  assert.equal(loop.endTime, 7); assert.equal(state(simulator).arrangementClips.length, 2);
});

test("a retry's refusal doesn't prove its first attempt never ran: the change stays uncertain", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { adapter, faults } = faulty(simulator);
  const { call, apply, change, undo } = hosted(adapter);
  // A transport change whose undo ran with its answer lost; the change's retry, under its own key, is refused.
  const transport = await call("live_transport_preview", { metronome: true });
  assert.equal((await apply("live_transport_apply", transport.transactionId, "transport-key")).state, "applied");
  faults.invoke = (invocation) => invocation.operation === "transport.set";
  assert.equal((await undo(transport.transactionId)).isError, true);
  faults.refuse = (invocation) => invocation.operation === "transport.set";
  const retried = await apply("live_transport_apply", transport.transactionId, "transport-key");
  assert.equal(retried.isError, true); assert.match(retried.remediation, /uncertain/);
  // A section whose first locator Live added, its answer lost; the retry's resend is refused.
  const section = await call("live_arrangement_section_preview", { start: 4, end: 8, startName: "Verse", endName: "Chorus" });
  faults.invoke = (invocation) => invocation.operation === "locator.add";
  assert.equal((await apply("live_arrangement_section_apply", section.transactionId, "section-key")).isError, true);
  faults.refuse = (invocation) => invocation.operation === "locator.add";
  const resent = await apply("live_arrangement_section_apply", section.transactionId, "section-key");
  assert.equal(resent.isError, true); assert.match(resent.remediation, /uncertain/);
  // An undo of two clips: the first deletion ran, its answer lost; the retry's next deletion is refused.
  const made = await change("live_arrangement_midi_clip_preview", { clips: [{ trackRef: "track:track-1", start: 0, length: 4, name: "A", notes: [] }, { trackRef: "track:track-1", start: 8, length: 4, name: "B", notes: [] }] });
  faults.invoke = (invocation) => invocation.operation === "arrangement.clip.delete";
  assert.equal((await undo(made.previewed.transactionId, "undo-key")).isError, true);
  assert.deepEqual(state(simulator).arrangementClips.map((item) => item.clip.name), ["A"]);
  faults.refuse = (invocation) => invocation.operation === "arrangement.clip.delete";
  const again = await undo(made.previewed.transactionId, "undo-key");
  assert.equal(again.isError, true); assert.doesNotMatch(again.reason, /before anything changed/);
  assert.match((await undo(made.previewed.transactionId)).reason, /exact-key uncertain/);
});
