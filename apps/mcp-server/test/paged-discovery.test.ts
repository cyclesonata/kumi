import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LiveViews, type AsyncLiveAdapter, type LiveDiscoveryRequest } from "../src/live.js";

// A discovery page ends at its limit or where the Remote Script's read budget ran out, with nextCursor to
// go on. What the host reads for its own logic follows the cursor to the end (or to what it asked for).

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function simulatorWithTracks(count: number): DeterministicLiveSimulator {
  const live = new DeterministicLiveSimulator(); const state = (live as any).state;
  for (let index = 1; index < count; index += 1) state.tracks.push({ ...structuredClone(state.tracks[0]), ref: `track:extra-${index}`, objectIdentity: `simulator:track:extra-${index}`, name: `Extra ${index}`, clips: [], clipSlots: [], devices: [] });
  return live;
}

function pagesOf(live: DeterministicLiveSimulator): AsyncLiveAdapter & { pages: LiveDiscoveryRequest[] } {
  const pages: LiveDiscoveryRequest[] = [];
  return Object.assign(Object.create(live), { pages, discoverAsync: async (request: LiveDiscoveryRequest) => { pages.push(request); return live.discoverAsync(request); } }) as AsyncLiveAdapter & { pages: LiveDiscoveryRequest[] };
}

test("the simulator pages a discovery as the Remote Script does: a budget cuts a page short, a cursor goes on from there", async () => {
  const live = simulatorWithTracks(5); live.discoveryBudgetItems = 2;
  const first = await live.discoverAsync({ kind: "track", limit: 100 });
  assert.deepEqual([first.items.length, first.truncated, typeof first.nextCursor], [2, true, "string"]);
  const second = await live.discoverAsync({ kind: "track", limit: 100, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.ref), ["track:extra-2", "track:extra-3"]);
  // A cursor names a place in the list as it was: another list refuses it.
  (live as any).state.tracks.pop();
  await assert.rejects(live.discoverAsync({ kind: "track", limit: 100, cursor: second.nextCursor }), /stale discovery cursor/);
});

test("discoverAll follows the cursor to the end, or to as many as asked, and refuses a list that changes between pages", async () => {
  const live = simulatorWithTracks(7); live.discoveryBudgetItems = 2;
  const adapter = pagesOf(live); const views = new LiveViews(() => adapter);
  assert.deepEqual((await views.discoverAll({ kind: "track", limit: 100 })).map((item) => item.ref), live.snapshot().tracks.map((track) => track.ref));
  assert.equal(adapter.pages.length, 4); assert.equal(adapter.pages[0]!.cursor, undefined); assert.ok(adapter.pages.slice(1).every((page) => typeof page.cursor === "string"));
  adapter.pages.length = 0;
  assert.equal((await views.discoverAll({ kind: "track", limit: 100 }, undefined, 3)).length, 3); assert.equal(adapter.pages.length, 2);
  // A track added between pages: the list changed under the cursor.
  let added = false;
  const changing = Object.assign(Object.create(live), { discoverAsync: async (request: LiveDiscoveryRequest) => { const page = await live.discoverAsync(request); if (!added) { added = true; (live as any).state.tracks.push({ ...structuredClone((live as any).state.tracks[0]), ref: "track:late", objectIdentity: "simulator:track:late", name: "Late" }); } return page; } }) as AsyncLiveAdapter;
  await assert.rejects(new LiveViews(() => changing).discoverAll({ kind: "track", limit: 100 }), /stale discovery cursor|changed while it was read/);
  // A cursor that doesn't move on is refused rather than followed forever.
  const stuck = Object.assign(Object.create(live), { discoverAsync: async () => ({ epoch: 1, items: [{ ref: "x" }], truncated: true, revision: "r", kind: "track", nextCursor: "same" }) }) as AsyncLiveAdapter;
  await assert.rejects(new LiveViews(() => stuck).discoverAll({ kind: "track" }), /didn't move on/);
});

test("Arrangement MIDI clips are found again on a track whose clips come one per page", async () => {
  const live = new DeterministicLiveSimulator(); live.discoveryBudgetItems = 1;
  const host = new McpHost(live); host.handle(initialize); host.handle(initialized);
  let id = 10;
  const call = async (name: string, args: unknown): Promise<Record<string, any>> => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any; assert.equal(answer.result?.isError, false, `${name}: ${JSON.stringify(answer.result ?? answer.error)}`); return JSON.parse(answer.result.content[0].text); };
  const notes = [{ pitch: 60, start: 0, duration: 1 }];
  for (const [index, name] of ["A", "B", "C"].entries()) {
    const previewed = await call("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: index * 4, length: 4, name, notes });
    const applied = await call("live_arrangement_midi_clip_apply", { transactionId: previewed.transactionId, confirmation: "apply", idempotencyKey: `paged-clip-${name}` });
    assert.deepEqual(applied.clips.map((clip: { name: string }) => clip.name), [name]);
  }
});
