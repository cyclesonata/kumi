import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AuthenticatedLoopback, LoopbackLiveAdapter, LOOPBACK_PROTOCOL_VERSION, type LoopbackResponse } from "../src/loopback.js";
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_UNAVAILABLE_CAPABILITIES, LiveViews, SIMULATOR_CAPABILITIES, WHOLE_SET_PAGE_TRACKS, trackIndexOfRef, type AsyncLiveAdapter, type LiveRef, type LiveSnapshotRequest } from "../src/live.js";

const secret = "0123456789abcdef0123456789abcdef";
const canonical = (value: unknown): string => value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const revision = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const mixerAuthority = (track: any) => ({ expectedObjectIdentity: track.objectIdentity, expectedVolumeIdentity: track.mixer.volumeIdentity, expectedPanIdentity: track.mixer.panIdentity, expectedCueIdentity: track.mixer.cueIdentity, expectedSendIdentities: track.mixer.sendIdentities, expectedStateRevision: revision(Object.fromEntries(["volume", "pan", "mute", "solo", "cueVolume", "sends"].map((field) => [field, track.mixer[field] ?? null]))) });
const clipAuthority = (snapshot: any, track: any, clip: any) => { const slot = track.clipSlots.find((item: any) => item.clipRef === clip.ref); const scene = snapshot.scenes.find((item: any) => item.index === slot.sceneIndex); return { expectedObjectIdentity: clip.objectIdentity, expectedTrackRef: track.ref, expectedTrackIdentity: track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity }; };
const parameterAuthority = (snapshot: any, track: any, device: any, parameter: any) => ({ expectedObjectIdentity: parameter.objectIdentity, expectedOwnerRef: device.ref, expectedOwnerIdentity: device.objectIdentity, expectedTrackRef: track.ref, expectedTrackIdentity: track.objectIdentity, expectedSiblings: device.parameters.map((item: any) => ({ ref: item.ref, objectIdentity: item.objectIdentity })) });

test("simulator covers stable references, bounded edits, subscriptions, and reconnect epochs", () => {
  const live = new DeterministicLiveSimulator();
  const snapshot = live.snapshot();
  const track = snapshot.tracks[0];
  assert.ok(track);
  assert.equal(live.status().protocol, LIVE_PROTOCOL_VERSION);
  assert.ok(LIVE_CAPABILITIES.includes("transport"));
  assert.ok(LIVE_UNAVAILABLE_CAPABILITIES.includes("plugins"));
  const events: unknown[] = [];
  const unsubscribe = live.subscribe((event) => events.push(event));
  assert.throws(() => live.invoke({ operation: "mixer.set", args: { ref: track.ref, volume: 2, ...mixerAuthority(track) } }), /volume is invalid/);
  live.invoke({ operation: "mixer.set", args: { ref: track.ref, volume: 1, ...mixerAuthority(track) } });
  assert.equal((live.get(track.ref) as typeof track).volume, 1);
  assert.deepEqual(events[0], { epoch: 1, sequence: 1, type: "object", ref: track.ref, payload: { operation: "mixer.set" } });
  live.addNote(track.clips[0]!.ref, { pitch: 40, start: 1, duration: 0.25, velocity: 90, channel: 1 });
  const epoch = live.reconnect().epoch;
  assert.equal(epoch, 2);
  assert.equal(events.length, 3);
  unsubscribe();
});

test("simulator clip launch and stop require exact hierarchy identities", () => {
  const argsFor = (snapshot: ReturnType<DeterministicLiveSimulator["snapshot"]>) => {
    const track = snapshot.tracks[0]!; const slot = track.clipSlots![0]!; const clip = track.clips.find((item) => item.ref === slot.clipRef)!; const scene = snapshot.scenes[0]!;
    return { slotRef: slot.ref, trackRef: track.ref, sceneRef: scene.ref, sceneIndex: scene.index, clipRef: clip.ref, trackIdentity: track.objectIdentity!, sceneIdentity: scene.objectIdentity!, slotIdentity: slot.objectIdentity!, clipIdentity: clip.objectIdentity!, playbackRevision: snapshot.playback.revision, outputSafety: { safe: true, provenance: "unit-test" } };
  };
  const stopArgsFor = (authority: ReturnType<typeof argsFor>) => ({ slotRef: authority.slotRef, trackRef: authority.trackRef, sceneRef: authority.sceneRef, sceneIndex: authority.sceneIndex, clipRef: authority.clipRef, trackIdentity: authority.trackIdentity, sceneIdentity: authority.sceneIdentity, slotIdentity: authority.slotIdentity, clipIdentity: authority.clipIdentity });
  const live = new DeterministicLiveSimulator(); const authority = argsFor(live.snapshot());
  assert.equal((live.invoke({ operation: "session.clip-launch", args: authority }) as { launched: string }).launched, authority.slotRef);
  assert.equal((live.invoke({ operation: "session.clip-stop", args: stopArgsFor(authority) }) as { stopped: boolean }).stopped, true);

  const replacedBeforeLaunch = new DeterministicLiveSimulator(); const staleLaunch = argsFor(replacedBeforeLaunch.snapshot());
  (replacedBeforeLaunch as any).state.tracks[0].clips[0].objectIdentity = "simulator:clip:replacement";
  assert.throws(() => replacedBeforeLaunch.invoke({ operation: "session.clip-launch", args: staleLaunch }), /object identity changed/);

  const replacedBeforeStop = new DeterministicLiveSimulator(); const staleStop = argsFor(replacedBeforeStop.snapshot());
  replacedBeforeStop.invoke({ operation: "session.clip-launch", args: staleStop });
  (replacedBeforeStop as any).state.tracks[0].clips[0].objectIdentity = "simulator:clip:replacement";
  assert.throws(() => replacedBeforeStop.invoke({ operation: "session.clip-stop", args: stopArgsFor(staleStop) }), /object identity changed/);
  assert.equal(replacedBeforeStop.snapshot().playback.playingTargets.length, 1);
});

test("simulator exposes domain objects and bounded editing operations", () => {
  const live = new DeterministicLiveSimulator();
  const snapshot = live.snapshot();
  const clip = snapshot.tracks[0]!.clips[0]!;
  const device = snapshot.tracks[0]!.devices[0]!;
  const parameter = device.parameters[0]!;

  assert.ok(LIVE_UNAVAILABLE_CAPABILITIES.includes("arrangement.read"));
  assert.ok(LIVE_CAPABILITIES.includes("parameters"));
  assert.equal(snapshot.arrangement.locators[0]!.name, "Intro");
  assert.equal((live.get(snapshot.scenes[0]!.ref) as typeof snapshot.scenes[0]).name, "Scene 1");
  assert.equal((live.get(parameter.ref) as typeof parameter).value, 0.5);
  const parameterFence = parameterAuthority(snapshot, snapshot.tracks[0]!, device, parameter);
  assert.throws(() => live.invoke({ operation: "device.parameter.set", args: { ref: parameter.ref, value: 9, expectedRevision: 1, ...parameterFence } }), /outside numeric bounds/);
  live.invoke({ operation: "device.parameter.set", args: { ref: parameter.ref, value: 1, expectedRevision: 1, ...parameterFence } });
  assert.equal((live.get(parameter.ref) as typeof parameter).value, 1);
  live.setAutomation(clip.ref, { time: 1, value: 0.75, curve: 0 });
  live.addTake(clip.ref, "take-2");
  const updated = live.get(clip.ref) as typeof clip;
  assert.equal(updated.automation.length, 1);
  assert.deepEqual(updated.takes, ["take-1", "take-2"]);
  assert.throws(() => live.setAutomation(clip.ref, { time: 99, value: 0.5 }), /outside the clip/);
  assert.throws(() => live.setAutomation(clip.ref, { time: Number.NaN, value: 0.5 }), /outside the clip/);
  assert.throws(() => live.addNote(clip.ref, { pitch: 40, start: Number.NaN, duration: 0.25, velocity: 90, channel: 1 }), /invalid MIDI note/);
  assert.throws(() => live.addNote(clip.ref, { pitch: 40, start: 1, duration: 0.25, velocity: 90, channel: 17 }), /invalid MIDI note/);
  let noteSnapshot = live.snapshot(); let noteTrack = noteSnapshot.tracks[0]!; let noteClip = noteTrack.clips.find((item) => item.ref === clip.ref)!;
  const batched = live.invoke({ operation: "note.add-batch", args: { ref: clip.ref, notes: [
    { pitch: 41, start: 1, duration: 0.25, velocity: 90, channel: 1 },
    { pitch: 42, start: 2, duration: 0.25, velocity: 80, channel: 1 },
  ], expectedClipAuthority: clipAuthority(noteSnapshot, noteTrack, noteClip), expectedNotesRevision: noteClip.notesRevision } }) as { added: number; noteIds: number[] };
  assert.equal(batched.added, 2); assert.equal(batched.noteIds.length, 2);
  const afterBatch = (live.get(clip.ref) as typeof clip).notes.length;
  noteSnapshot = live.snapshot(); noteTrack = noteSnapshot.tracks[0]!; noteClip = noteTrack.clips.find((item) => item.ref === clip.ref)!;
  assert.throws(() => live.invoke({ operation: "note.add-batch", args: { ref: clip.ref, notes: [
    { pitch: 43, start: 3, duration: 0.25, velocity: 70, channel: 1 },
    { pitch: 44, start: Number.NaN, duration: 0.25, velocity: 70, channel: 1 },
  ], expectedClipAuthority: clipAuthority(noteSnapshot, noteTrack, noteClip), expectedNotesRevision: noteClip.notesRevision } }), /invalid MIDI note/);
  assert.equal((live.get(clip.ref) as typeof clip).notes.length, afterBatch);
  assert.throws(() => live.addTake(clip.ref, 42 as unknown as string), /invalid or duplicate take/);
  assert.throws(() => live.setWarp(clip.ref, "yes" as unknown as boolean), /warp must be boolean/);
});

test("simulator executes session, media, routing, browser, and realtime operations", () => {
  const live = new DeterministicLiveSimulator();
  const initial = live.snapshot();
  const track = initial.tracks[0]!;
  (live as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  (live as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: track.ref, objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const targetSnapshot = live.snapshot(); const targetTrack = targetSnapshot.tracks[0]!; const targetSlot = targetTrack.clipSlots![1]!; const targetScene = targetSnapshot.scenes[1]!;
  const created = live.invoke({ operation: "clip.create", args: { trackRef: track.ref, kind: "audio", name: "Vocal", sceneIndex: 1, length: 8, expectedTrackIdentity: targetTrack.objectIdentity, expectedSlotRef: targetSlot.ref, expectedSlotIdentity: targetSlot.objectIdentity, expectedSceneRef: targetScene.ref, expectedSceneIdentity: targetScene.objectIdentity } }) as { ref: `${string}:${string}` };
  // These remain explicit simulator-domain helpers, not advertised canonical
  // operations or production capability evidence.
  live.setWarp(created.ref as LiveRef, true);
  live.addTake(created.ref as LiveRef, "comp-1");
  const routingTrack = live.snapshot().tracks[0]!;
  live.invoke({ operation: "routing.set", args: { ref: track.ref, inputType: "Ext. In 1", outputType: "Main", expectedObjectIdentity: routingTrack.objectIdentity, expectedStateRevision: revision({ inputType: routingTrack.routing!.inputType, inputSubRouting: routingTrack.routing!.inputSubRouting, outputType: routingTrack.routing!.outputType, outputSubRouting: routingTrack.routing!.outputSubRouting, arm: routingTrack.armed, monitoring: routingTrack.monitoringState }) } });
  const locatorSnapshot = live.snapshot(); const locator = live.invoke({ operation: "locator.add", args: { name: "Verse", position: 4, expectedCollectionRevision: locatorSnapshot.arrangement.locatorRevision } }) as { name: string };
  assert.equal(locator.name, "Verse");
  assert.equal((live.invoke({ operation: "browser.search", args: { query: "util" } }) as { items: unknown[] }).items.length, 1);
  const before = live.snapshot();
  live.invoke({ operation: "transport.set", args: { position: 4, expectedRevision: before.playback.revision, setRef: before.set.ref, expectedObjectIdentity: before.set.objectIdentity } });
  assert.equal(live.snapshot().playback.transport.position, 4);
  assert.throws(() => live.invoke({ operation: "transport.set", args: { position: 8, expectedRevision: "stale", setRef: before.set.ref, expectedObjectIdentity: before.set.objectIdentity } }), /changed since preview/);
  assert.throws(() => live.invoke({ operation: "max.message", args: { address: "", values: [] } } as any), /unknown operation/);
});

test("loopback authenticates, rejects replay/tampering, and forwards subscriptions", () => {
  const live = new DeterministicLiveSimulator();
  const events: unknown[] = [];
  const transport = new AuthenticatedLoopback(live, secret, (response) => events.push(response));
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "one", method: "status", nonce: "0000000000000001" });
  assert.equal(transport.handle(request).ok, true);
  assert.equal(transport.handle(request).ok, false);
  const tampered = { ...transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "two", method: "status", nonce: "0000000000000002" }), id: "changed" };
  assert.equal(transport.handle(tampered).ok, false);
  const subscription = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "sub", method: "subscribe", nonce: "0000000000000003" });
  assert.equal(transport.handle(subscription).ok, true);
  live.reconnect();
  assert.equal(events.length, 1);
  transport.close();
});

test("loopback accepts valid nonces out of order and rejects unknown fields", () => {
  const live = new DeterministicLiveSimulator();
  const transport = new AuthenticatedLoopback(live, secret);
  const first = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "first", method: "status", nonce: "zzzzzzzzzzzzzzzz1" });
  const second = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "second", method: "status", nonce: "aaaaaaaaaaaaaaaa2" });
  assert.equal(transport.handle(first).ok, true);
  assert.equal(transport.handle(second).ok, true);
  const extra = { ...transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "third", method: "status", nonce: "bbbbbbbbbbbbbbbb3" }), unexpected: true };
  assert.equal(transport.handle(extra).ok, false);
});

test("loopback authenticates bounded domain invocations", () => {
  const live = new DeterministicLiveSimulator();
  const transport = new AuthenticatedLoopback(live, secret);
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "invoke", method: "invoke", operation: "browser.search", args: { query: "kick" }, nonce: "invoke-nonce-0001" });
  const result = transport.handle(request);
  assert.equal(result.ok, true);
  assert.equal((result.result as { items: unknown[] }).items.length, 1);
});

test("loopback rejects oversized nonces before retaining them", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "large", method: "status", nonce: "x".repeat(257) });
  assert.equal(transport.handle(request).ok, false);
});

test("loopback signing rejects oversized, deeply nested, and non-finite wire values", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "large", method: "invoke", operation: "browser.search", args: { query: "x".repeat(1_048_577) }, nonce: "large-wire-value-0001" }), /wire string is too large/);
  let nested: unknown = "value";
  for (let index = 0; index < 257; index += 1) nested = { value: nested };
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "deep", method: "invoke", operation: "browser.search", args: nested as Record<string, unknown>, nonce: "deep-wire-value-0001" }), /too deeply nested/);
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "nan", method: "invoke", operation: "browser.search", args: { value: Number.NaN }, nonce: "nan-wire-value-0001" }), /not finite/);
  // A big clip's notes go in one request: 20000 notes sign as easily as 512 did.
  const notes = Array.from({ length: 20_000 }, (_, index) => ({ pitch: index % 128, start: index / 4, duration: 0.25, velocity: 100, channel: 1 }));
  assert.doesNotThrow(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "large-note-batch", method: "invoke", operation: "note.add-batch", args: { ref: "1:clip:0:0", notes }, nonce: "large-note-batch-0001" }));
});

test("loopback retains replay protection beyond the old eviction threshold", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  const first = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "first", method: "status", nonce: "persistent-nonce-0001" });
  assert.equal(transport.handle(first).ok, true);
  for (let index = 0; index < 4_096; index += 1) {
    const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: `request-${index}`, method: "status", nonce: `nonce-${index.toString().padStart(16, "0")}` });
    assert.equal(transport.handle(request).ok, true);
  }
  assert.equal(transport.handle(first).ok, false);
});

test("loopback adapter negotiates the domain contract and receives authenticated events", () => {
  const live = new DeterministicLiveSimulator();
  const events: LoopbackResponse[] = [];
  const server = new AuthenticatedLoopback(live, secret, (event) => events.push(event));
  const adapter = new LoopbackLiveAdapter(secret, (request) => server.handle(request));
  const initial = adapter.snapshot();
  assert.equal(initial.set.tempo, 120);
  assert.equal(adapter.status().adapter, "simulator");
  const seen: unknown[] = [];
  const unsubscribe = adapter.subscribe((event) => seen.push(event));
  assert.equal(typeof (adapter as unknown as { set?: unknown }).set, "undefined");
  adapter.invoke({ operation: "tempo.set", args: { ref: initial.set.ref, value: 123, expectedTempo: 120, expectedObjectIdentity: initial.set.objectIdentity } });
  assert.equal((adapter.get(initial.set.ref) as typeof initial.set).tempo, 123);
  assert.equal(events.length, 1);
  adapter.receive(events[0]!);
  assert.equal((seen[0] as { payload: { value: number } }).payload.value, 123);
  unsubscribe();
  assert.throws(() => adapter.receive({ ...events[0]!, mac: "tampered" }), /authentication/);
});

test("loopback adapter binds responses to request ids and rejects stale events", () => {
  const live = new DeterministicLiveSimulator();
  const server = new AuthenticatedLoopback(live, secret);
  const adapter = new LoopbackLiveAdapter(secret, (request) => server.handle(request));
  const first = adapter.snapshot();
  assert.equal(first.set.tempo, 120);
  assert.throws(() => adapter.receive({ version: LOOPBACK_PROTOCOL_VERSION, id: "client-999", ok: true, bridgeEpoch: "in-process", connectionChallenge: "in-process", result: { event: { sequence: 1, type: "state", payload: {} } }, mac: "bad" }), /authentication/);
  assert.equal(SIMULATOR_CAPABILITIES.includes("transport"), true);
});

/** A simulator whose Set holds `count` tracks: the first one as it comes, then plain MIDI tracks. */
function simulatorWithTracks(count: number): DeterministicLiveSimulator {
  const live = new DeterministicLiveSimulator(); const state = (live as any).state;
  for (let index = 1; index < count; index += 1) state.tracks.push({ ...structuredClone(state.tracks[0]), ref: `track:extra-${index}`, objectIdentity: `simulator:track:extra-${index}`, name: `Extra ${index}`, clips: [], clipSlots: [], devices: [], takeLanes: [] });
  return live;
}

/** An adapter over a simulator that records every snapshot request, optionally answering as a Remote Script
 * from before snapshot arguments (the whole Set, whatever is asked). */
function recordingAdapter(live: DeterministicLiveSimulator, options: { ignoreArguments?: boolean } = {}): AsyncLiveAdapter & { requests: Array<LiveSnapshotRequest | undefined> } {
  const requests: Array<LiveSnapshotRequest | undefined> = [];
  return Object.assign(Object.create(live), {
    requests,
    snapshotAsync: async (_context: unknown, request?: LiveSnapshotRequest) => { requests.push(request); return options.ignoreArguments ? live.snapshot() : live.snapshotView(request); },
    discoverAsync: live.discoverAsync.bind(live),
  }) as AsyncLiveAdapter & { requests: Array<LiveSnapshotRequest | undefined> };
}

test("a simulated snapshot read builds what it asks for: windows, a focus with light rows, parts, counts and the window it honoured", async () => {
  const live = simulatorWithTracks(4);
  const whole = await live.snapshotAsync();
  assert.equal(whole.trackCount, 4); assert.equal(whole.sceneCount, 1); assert.equal(whole.window, undefined); assert.equal(whole.tracks.length, 4);
  const focused = live.snapshotView({ focus: [0, 2] });
  assert.deepEqual(focused.window, { focus: [0, 2] });
  assert.deepEqual(focused.tracks.map((track) => track.light === true), [false, true, false, true]);
  const light = focused.tracks[1] as any;
  assert.deepEqual(Object.keys(light).sort(), ["armed", "clipSlots", "clips", "colorIndex", "devices", "groupTrackRef", "kind", "light", "mediaKind", "mixer", "name", "objectIdentity", "parentRef", "ref", "routing", "takeLanes"]);
  assert.equal(light.ref, "track:extra-1"); assert.equal(light.mixer, null); assert.deepEqual(light.devices, []);
  assert.deepEqual(focused.tracks[0], whole.tracks[0]);
  const windowed = live.snapshotView({ tracks: { from: 1, count: 2 }, scenes: { from: 0, count: 1 } });
  assert.deepEqual(windowed.tracks.map((track) => track.ref), ["track:extra-1", "track:extra-2"]);
  assert.deepEqual(windowed.window, { tracks: { from: 1, count: 2 }, scenes: { from: 0, count: 1 } }); assert.equal(windowed.trackCount, 4);
  const parts = live.snapshotView({ parts: ["set", "playback"] }) as any;
  assert.deepEqual(parts.window, { parts: ["set", "playback"] });
  assert.equal(parts.set.tempo, 120); assert.ok(parts.playback.transport);
  for (const absent of ["tracks", "scenes", "arrangement", "selection"]) assert.equal(absent in parts, false, absent);
  assert.equal("playback" in live.snapshotView({ parts: ["tracks"] }), false);
  // Arrangement clips come for the tracks read whole only.
  (live as any).state.arrangementClips.push({ clip: { ...structuredClone(whole.tracks[0]!.clips[0]), ref: "arrangement-clip:extra-2:0" }, trackRef: "track:extra-2" });
  assert.deepEqual((live.snapshotView({ focus: [2] }).arrangement.clips ?? []).map((clip) => clip.ref), ["arrangement-clip:extra-2:0"]);
  assert.deepEqual(live.snapshotView({ focus: [] }).arrangement.clips, []);
  for (const bad of [{ focus: [1, 1] }, { focus: [-1] }, { tracks: { from: 0, count: 0 } }, { parts: ["everything"] }, { unknown: true }]) assert.throws(() => live.snapshotView(bad as LiveSnapshotRequest), /snapshot/);
});

test("positional references place themselves on their track by the combined index", () => {
  const cases: Array<[string, number | undefined]> = [
    ["7:track:3", 3], ["7:clip:3:5", 3], ["7:clip_slot:3:5", 3], ["7:device:3:0:2", 3], ["7:chain:3:0", 3], ["7:drum_pad:3:0:36", 3],
    ["7:take_lane:3:1", 3], ["7:take_lane_clip:3:1:0", 3], ["7:arrangement_clip:3:7", 3], ["7:routing_choice:12:input-type:0", 12],
    ["7:parameter:7:device:3:0:2:5", 3], ["7:parameter:7:device:4:1:macro:0", 4], ["7:parameter:mixer:3:volume", 3], ["7:parameter:mixer:9:sends:1", 9],
    ["7:parameter:7:chain:3:0:1:volume", 3], ["7:chain:7:device:5:0:selected", 5],
    ["7:set:song", undefined], ["7:scene:2", undefined], ["7:locator:0", undefined], ["7:track:group:3", undefined], ["7:device:view:3", undefined],
    ["7:device:appointed", undefined], ["7:arrangement_clip:4", undefined], ["track:track-1", undefined], ["clip:clip-1", undefined], ["7:track:100001", undefined],
  ];
  for (const [ref, index] of cases) assert.equal(trackIndexOfRef(ref), index, ref);
});

test("views read the tracks an operation names whole, find where simulator references sit, and page the whole Set", async () => {
  const live = simulatorWithTracks(WHOLE_SET_PAGE_TRACKS + 4); const adapter = recordingAdapter(live); const views = new LiveViews(() => adapter);
  // The whole Set comes in pages and assembles to the whole snapshot.
  const whole = await views.wholeSet(undefined);
  assert.deepEqual(adapter.requests, [{ focus: Array.from({ length: WHOLE_SET_PAGE_TRACKS }, (_, index) => index) }, { tracks: { from: WHOLE_SET_PAGE_TRACKS, count: 4 }, parts: ["tracks", "arrangement"] }]);
  assert.deepEqual(whole.tracks, live.snapshot().tracks); assert.equal(whole.window, undefined); assert.equal(views.trackCount, WHOLE_SET_PAGE_TRACKS + 4);
  // A reference seen whole is read through its track alone; one never seen reads the whole Set.
  adapter.requests.length = 0;
  const parameter = await views.viewFor(undefined, ["parameter:gain-1", "scene:scene-1", undefined]);
  assert.deepEqual(adapter.requests, [{ focus: [0] }]); assert.equal(parameter.tracks.filter((track) => track.light !== true).length, 1);
  adapter.requests.length = 0;
  await views.viewFor(undefined, ["clip:nowhere"]);
  assert.deepEqual(adapter.requests[0], { focus: Array.from({ length: WHOLE_SET_PAGE_TRACKS }, (_, index) => index) });
  // A reference that moved since it was seen is looked for where it was, then in the whole Set.
  const state = (live as any).state; state.tracks.push(state.tracks.shift());
  adapter.requests.length = 0;
  const moved = await views.viewFor(undefined, ["parameter:gain-1"]);
  assert.deepEqual(adapter.requests[0], { focus: [0] }); assert.equal(adapter.requests.length, 3);
  assert.ok(moved.tracks.some((track) => track.devices.some((device) => device.parameters.some((row) => row.ref === "parameter:gain-1"))));
  adapter.requests.length = 0;
  await views.viewFor(undefined, ["parameter:gain-1"]);
  assert.deepEqual(adapter.requests, [{ focus: [WHOLE_SET_PAGE_TRACKS + 3] }]);
  // Index hints place what was never seen (a track just made) without reading the whole Set.
  adapter.requests.length = 0;
  await views.viewFor(undefined, ["track:made-just-now"], undefined, [2]);
  assert.deepEqual(adapter.requests.slice(0, 1), [{ focus: [2] }]);
  // Parts without tracks read no tracks at all, and playback comes from Session playback.
  adapter.requests.length = 0;
  const set = await views.view(undefined, [], ["set"]);
  assert.deepEqual(adapter.requests, [{ parts: ["set"] }]); assert.equal(set.set.tempo, 120);
  assert.equal((await views.playback()).revision, live.snapshot().playback.revision);
});

test("a whole-Set read answered by a Remote Script from before snapshot arguments takes the one whole answer, and a Set that moves between pages is read again", async () => {
  const live = simulatorWithTracks(WHOLE_SET_PAGE_TRACKS + 2);
  const old = recordingAdapter(live, { ignoreArguments: true });
  const whole = await new LiveViews(() => old).wholeSet(undefined);
  assert.equal(old.requests.length, 1); assert.equal(whole.tracks.length, WHOLE_SET_PAGE_TRACKS + 2);
  // The first page's tracks move before the second page is read: the read starts over.
  const adapter = recordingAdapter(live); let moved = false;
  const moving = Object.assign(Object.create(adapter), { snapshotAsync: async (context: unknown, request?: LiveSnapshotRequest) => { const answer = await adapter.snapshotAsync(context as never, request); if (!moved && request?.focus) { moved = true; const state = (live as any).state; state.tracks.splice(WHOLE_SET_PAGE_TRACKS, 0, state.tracks.pop()); } return answer; } }) as AsyncLiveAdapter;
  const reread = await new LiveViews(() => moving).wholeSet(undefined);
  assert.deepEqual(reread.tracks.map((track) => track.ref), live.snapshot().tracks.map((track) => track.ref));
  assert.equal(adapter.requests.filter((request) => request?.focus).length, 2);
  // A page answered without its window is the whole Set.
  const halfway = recordingAdapter(live); const wholePages = Object.assign(Object.create(halfway), { snapshotAsync: async (context: unknown, request?: LiveSnapshotRequest) => request?.tracks ? live.snapshot() : halfway.snapshotAsync(context as never, request) }) as AsyncLiveAdapter;
  assert.equal((await new LiveViews(() => wholePages).wholeSet(undefined)).tracks.every((track) => track.light !== true), true);
});
