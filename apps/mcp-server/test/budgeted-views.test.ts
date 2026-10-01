import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LiveViews, WHOLE_SET_PAGE_TRACKS, type AsyncLiveAdapter, type LiveSnapshotRequest } from "../src/live.js";

// The Remote Script builds whole rows only while its read budget lasts (one at least): a track window ends
// at the last whole row (window.tracks.count says how many came), and focused tracks past it come light
// (window.focus lists those that came whole). Views still deliver what they were asked for.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function simulatorWithTracks(count: number): DeterministicLiveSimulator {
  const live = new DeterministicLiveSimulator(); const state = (live as any).state;
  for (let index = 1; index < count; index += 1) state.tracks.push({ ...structuredClone(state.tracks[0]), ref: `track:extra-${index}`, objectIdentity: `simulator:track:extra-${index}`, name: `Extra ${index}`, clips: [], clipSlots: [{ ref: `clip-slot:extra-${index}:0`, parentRef: `track:extra-${index}`, objectIdentity: `simulator:clip-slot:extra-${index}:0`, sceneIndex: 0, clipRef: null, empty: true }], devices: [] });
  return live;
}

function recordingAdapter(live: DeterministicLiveSimulator): AsyncLiveAdapter & { requests: Array<LiveSnapshotRequest | undefined> } {
  const requests: Array<LiveSnapshotRequest | undefined> = [];
  return Object.assign(Object.create(live), { requests, snapshotAsync: async (_context: unknown, request?: LiveSnapshotRequest) => { requests.push(request); return live.snapshotView(request); }, discoverAsync: live.discoverAsync.bind(live) }) as AsyncLiveAdapter & { requests: Array<LiveSnapshotRequest | undefined> };
}

test("the simulator cuts a budgeted read as the Remote Script does: a window short, a focus light past the budget", () => {
  const live = simulatorWithTracks(6); live.readBudgetRows = 2;
  const window = live.snapshotView({ tracks: { from: 1, count: 4 } });
  assert.deepEqual([window.tracks.length, window.window?.tracks], [2, { from: 1, count: 2 }]);
  const focused = live.snapshotView({ focus: [0, 3, 5] });
  assert.deepEqual(focused.window?.focus, [0, 3]); assert.equal(focused.tracks.length, 6);
  assert.deepEqual(focused.tracks.map((track) => track.light === true), [false, true, true, false, true, true]);
  // A snapshot without arguments is the whole Set, unbudgeted.
  assert.ok(live.snapshotView().tracks.every((track) => track.light !== true));
});

test("a whole-Set read advances by the rows each window held, and assembles every row whole", async () => {
  const live = simulatorWithTracks(40); live.readBudgetRows = 3;
  const adapter = recordingAdapter(live); const views = new LiveViews(() => adapter);
  const whole = await views.wholeSet(undefined);
  assert.deepEqual(whole.tracks, live.snapshot().tracks); assert.equal(whole.window, undefined);
  // The first read lists every track (three whole); then each window starts where the last one's whole rows ended.
  assert.deepEqual(adapter.requests.map((request) => request?.tracks?.from ?? "focus"), ["focus", ...Array.from({ length: 13 }, (_, index) => 3 + index * 3)]);
  assert.ok(adapter.requests.slice(1).every((request) => request!.tracks!.count === Math.min(WHOLE_SET_PAGE_TRACKS, 40 - request!.tracks!.from)));
});

test("a focused view reads whole, through windows, the focused tracks the budget left light", async () => {
  const live = simulatorWithTracks(20); live.readBudgetRows = 1;
  const adapter = recordingAdapter(live); const views = new LiveViews(() => adapter);
  const view = await views.view(undefined, [15, 0, 3, 2]);
  const whole = live.snapshot().tracks;
  for (const index of [0, 2, 3, 15]) assert.deepEqual(view.tracks[index], whole[index], `track ${index}`);
  assert.equal(view.tracks.filter((track) => track.light !== true).length, 4); assert.deepEqual(view.window?.focus, [0, 2, 3, 15]);
  // 2 and 3 in one window (one row each time), 15 in its own.
  assert.deepEqual(adapter.requests.slice(1), [{ tracks: { from: 2, count: 2 }, parts: ["tracks", "arrangement"] }, { tracks: { from: 3, count: 1 }, parts: ["tracks", "arrangement"] }, { tracks: { from: 15, count: 1 }, parts: ["tracks", "arrangement"] }]);
  // Without a budget, one read.
  live.readBudgetRows = undefined; adapter.requests.length = 0;
  await views.view(undefined, [0, 2]); assert.equal(adapter.requests.length, 1);
});

test("a focused view whose tracks moved between its reads reads again", async () => {
  const live = simulatorWithTracks(6); live.readBudgetRows = 1;
  const adapter = recordingAdapter(live); let moved = false;
  const moving = Object.assign(Object.create(adapter), { snapshotAsync: async (context: unknown, request?: LiveSnapshotRequest) => { const answer = await adapter.snapshotAsync(context as never, request); if (!moved && request?.focus) { moved = true; const state = (live as any).state; state.tracks.splice(4, 0, state.tracks.splice(2, 1)[0]); } return answer; } }) as AsyncLiveAdapter;
  const view = await new LiveViews(() => moving).view(undefined, [0, 2]);
  assert.deepEqual(view.tracks.map((track) => track.ref), live.snapshot().tracks.map((track) => track.ref));
  assert.equal(adapter.requests.filter((request) => request?.focus).length, 2);
  assert.deepEqual(view.tracks[2], live.snapshot().tracks[2]);
});

test("a clip duplicated from one track onto another works however few whole rows a read holds", async () => {
  const live = simulatorWithTracks(3); live.readBudgetRows = 1;
  const host = new McpHost(live); host.handle(initialize); host.handle(initialized);
  let id = 10;
  const call = async (name: string, args: unknown): Promise<Record<string, any>> => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as any; assert.equal(answer.result?.isError, false, `${name}: ${JSON.stringify(answer.result ?? answer.error)}`); return JSON.parse(answer.result.content[0].text); };
  await call("live_snapshot", {});
  const previewed = await call("live_clip_duplicate_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:extra-2", targetSceneIndex: 0 });
  const applied = await call("live_clip_duplicate_apply", { transactionId: previewed.transactionId, confirmation: "apply", idempotencyKey: "budget-duplicate-key" });
  assert.equal(applied.state, "applied");
  assert.equal((live as any).state.tracks[2].clips.length, 1);
});
