import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveRegistryHash, loadLiveRegistry, validateLiveOperationRequest, validateLiveOperationResult } from "../src/registry.js";

// The Remote Script hashes the registry with Python's json.dumps and the host with JSON.stringify:
// a number the two spell differently (1e-06 against 0.000001) would keep Live from ever connecting.
test("the Remote Script and the host compute the same registry hash", { skip: spawnSync("python3", ["--version"]).status !== 0 ? "python3 is unavailable" : false }, () => {
  const remoteScript = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "remote-script");
  const python = spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from ableton_mcp_remote_script import operation_registry; print(operation_registry()[1])", remoteScript], { encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), liveRegistryHash());
});

// A bridge started from a folder that holds another registry (a checkout of another version) keeps its own.
test("the bridge's registry is its own, whatever folder it's started from", () => {
  const folder = mkdtempSync(join(tmpdir(), "registry-cwd-"));
  try {
    mkdirSync(join(folder, "protocol"), { recursive: true });
    writeFileSync(join(folder, "protocol", "ableton-live-v1.operations.json"), JSON.stringify({ version: 1, protocol: "ableton-live/v1", operations: [] }));
    // Started two folders down, the other registry is both in the folder above that and two above.
    mkdirSync(join(folder, "a", "b", "protocol"), { recursive: true });
    writeFileSync(join(folder, "a", "b", "protocol", "ableton-live-v1.operations.json"), JSON.stringify({ version: 1, protocol: "ableton-live/v1", operations: [] }));
    const module = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "registry.js")).href;
    const started = spawnSync(process.execPath, ["--input-type=module", "-e", `const { liveRegistryHash } = await import(${JSON.stringify(module)}); process.stdout.write(liveRegistryHash());`], { cwd: join(folder, "a", "b"), encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, liveRegistryHash());
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

const outputSafety = { safe: true, provenance: "test-operator" };

const playback = {
  ref: "1:session_playback:playback",
  epoch: 1,
  revision: "1:playback:abc",
  transport: {
    playing: false,
    arrangementRecord: null,
    sessionRecord: false,
    position: 0,
    launchQuantization: { raw: "1_bar", normalized: "1-bar" },
    loop: { enabled: false, start: 0, length: 4 },
    punchIn: false,
    punchOut: false,
    metronome: null,
    countIn: 1,
  },
  firedTargets: [],
  playingTargets: [{ trackRef: "1:track:0", clipSlotRef: "1:clip_slot:0:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0" }],
};

test("canonical registry includes strict snapshot and playback contracts", () => {
  const registry = loadLiveRegistry();
  assert.equal(registry.operations.find((item) => item.id === "snapshot")?.method, "snapshot");
  assert.equal(registry.operations.find((item) => item.id === "session.playback")?.method, "discover");
  validateLiveOperationRequest("session.playback", {});
  validateLiveOperationResult("session.playback", playback);
  const note = { pitch: 36, start: 0, duration: 0.25, velocity: 100, channel: 1 }; const noteAuthority = { expectedObjectIdentity: "live:clip:0", expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track:0", expectedSlotRef: "1:clip_slot:0:0", expectedSlotIdentity: "live:slot:0", expectedSceneRef: "1:scene:0", expectedSceneIdentity: "live:scene:0" };
  validateLiveOperationRequest("note.add-batch", { ref: "1:clip:0:0", notes: [note, { ...note, pitch: 38, start: 1 }], expectedClipAuthority: noteAuthority, expectedNotesRevision: "a".repeat(64) });
  validateLiveOperationResult("note.add-batch", { added: 2, noteIds: [1, null], notesRevision: "b".repeat(64) });
  assert.throws(() => validateLiveOperationRequest("note.add-batch", { ref: "1:clip:0:0", notes: [], expectedClipAuthority: noteAuthority, expectedNotesRevision: "a".repeat(64) }), /below registry item bound/);
  assert.throws(() => validateLiveOperationRequest("browser.load", { itemId: "instruments/Synth", expectedName: "Synth" }), /required/);
  validateLiveOperationRequest("device.delete", { ref: "1:device:0:0", expectedObjectIdentity: "live:device-1", expectedOwnerRef: "1:track:0", expectedOwnerIdentity: "live:track-1", expectedSiblings: [{ ref: "1:device:0:0", objectIdentity: "live:device-1" }], expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track-1" });
  assert.throws(() => validateLiveOperationRequest("device.delete", { ref: "1:device:0:0" }), /required/);
  validateLiveOperationRequest("authority.retire", { transactionId: "transaction-123", terminal: true });
  validateLiveOperationResult("authority.retire", { retired: 3 });
  assert.throws(() => validateLiveOperationRequest("authority.retire", { transactionId: "short" }), /shorter/);
  assert.throws(() => validateLiveOperationResult("authority.retire", { retired: 10_000_001 }), /numeric bounds/);
  assert.throws(() => validateLiveOperationResult("clip.move", { ref: "1:clip:0:1", objectIdentity: "live:clip:1", name: "Moved", createdFingerprint: "a".repeat(64), ownershipToken: "x".repeat(32) }), /not allowed/);
});

test("transport actions fence on the playback revision and explicit deletions carry their own authority", () => {
  // Real Live's playback revision is "<epoch>:playback:<n>:<digest>", as transport.set carries it.
  const setAuthority = { setRef: "4695124654589702:set:song", expectedObjectIdentity: "live:4695124654589702" };
  validateLiveOperationRequest("transport.action", { ...setAuthority, action: "stop", expectedRevision: "4695124654589702:playback:1:d9860b45721dd3cf" });
  validateLiveOperationRequest("transport.set", { ...setAuthority, metronome: true, expectedRevision: "4695124654589702:playback:1:d9860b45721dd3cf" });
  assert.throws(() => validateLiveOperationRequest("transport.action", { ...setAuthority, action: "stop", expectedRevision: "" }), /shorter/);
  const device = { ref: "1:device:0:1", expectedObjectIdentity: "live:device-2", expectedOwnerRef: "1:track:0", expectedOwnerIdentity: "live:track-1", expectedSiblings: [{ ref: "1:device:0:1", objectIdentity: "live:device-2" }], expectedTrackRef: "1:track:0", expectedTrackIdentity: "live:track-1" };
  validateLiveOperationRequest("device.delete", { ...device, explicitDeletion: true });
  assert.throws(() => validateLiveOperationRequest("device.delete", { ...device, explicitDeletion: false }), /constant/);
  validateLiveOperationRequest("track.delete-return", { ref: "1:track:3", expectedObjectIdentity: "live:return-1", expectedStructureRevision: "a".repeat(64), explicitDeletion: true });
  // Clips, scenes, tracks and locators the producer asks to delete are explicit deletions too.
  validateLiveOperationRequest("track.delete", { ref: "1:track:3", expectedObjectIdentity: "live:track-3", expectedStructureRevision: "a".repeat(64), explicitDeletion: true });
  validateLiveOperationRequest("scene.delete", { ref: "1:scene:2", expectedObjectIdentity: "live:scene-2", expectedStructureRevision: "a".repeat(64), explicitDeletion: true });
  assert.throws(() => validateLiveOperationRequest("track.delete", { ref: "1:track:3", expectedObjectIdentity: "live:track-3", expectedStructureRevision: "a".repeat(64), explicitDeletion: false }), /constant/);
});

test("runtime registry validation rejects missing, unknown, and weak playback fields", () => {
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, revision: undefined }), /type/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, extra: true }), /not allowed/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, transport: { ...playback.transport, playing: "false" } }), /type/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, playingTargets: [{ ...playback.playingTargets[0], clipSlotRef: "" }] }), /shorter/);
});

test("runtime registry validation rejects noncanonical discovery requests and results", () => {
  validateLiveOperationRequest("discover", { kind: "return_track", parent: "1:set:song", filters: { name: "Return" }, requestedFields: ["name"], traversalBudget: 10, limit: 4 });
  validateLiveOperationResult("discover", { epoch: 1, items: [], truncated: false, revision: "1:return_track:0", kind: "return_track" });
  assert.throws(() => validateLiveOperationRequest("discover", { kind: "track", unknown: true }), /not allowed/);
  assert.throws(() => validateLiveOperationRequest("discover", { kind: "track", filters: { nested: {} } }), /registry type/);
  assert.throws(() => validateLiveOperationRequest("discover", { kind: "track", filters: { name: "x".repeat(257) } }), /registry maximum/);
  assert.throws(() => validateLiveOperationResult("discover", { epoch: 1, items: [], truncated: false, revision: "", kind: "track" }), /shorter/);
});

test("realtime registry enforces explicit unique channels and measured bounded results", () => {
  const targetAuthorities = [{ ref: "1:parameter:device:0", parameterIdentity: "live:parameter:0", ownerRef: "1:device:0", ownerIdentity: "live:device:0", trackRef: "1:track:0", trackIdentity: "live:track:0", siblings: [{ ref: "1:parameter:device:0", objectIdentity: "live:parameter:0" }] }];
  validateLiveOperationRequest("realtime.arm", { ttlMs: 5000, channels: ["udp-json", "osc", "xy", "max"], parameterRefs: ["1:parameter:device:0"], targetAuthorities, sourcePorts: [41000], outputSafety });
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: [], parameterRefs: [], targetAuthorities: [], outputSafety }), /below registry item bound/);
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: ["xy", "xy"], parameterRefs: [], targetAuthorities: [], outputSafety }), /duplicate registry items/);
  validateLiveOperationResult("realtime.arm", { host: "127.0.0.1", port: 9766, token: "t".repeat(32), expiresAt: Date.now() + 5000, channels: ["xy"], parameterRefs: ["1:parameter:device:0"], packetLimitBytes: 512, ratePerSecond: 64, burst: 16 });
  validateLiveOperationResult("realtime.stats", { armed: true, accepted: 2, applied: 2, applyFailures: 0, pending: 0, droppedUnarmed: 0, droppedEndpoint: 0, droppedTarget: 0, droppedInvalid: 0, droppedReplay: 0, droppedRateLimited: 0, droppedQueueFull: 0, droppedBeforeDispatch: 0, revokedBeforeApply: 0, sequenceGaps: 0, lastSequence: 2, jitterMs: 0.2, maxJitterMs: 0.4 });
});

test("capture registry requires exact bounded authority and cleanup identity", () => {
  const base = { captureId: "capture_1234567890", setName: "Disposable", sourceSlotRef: "1:clip_slot:0:0", destinationSlotRef: "1:clip_slot:1:0", fence: "a".repeat(64), maxDurationMs: 5000, outputSafety };
  validateLiveOperationRequest("audio.capture.start", base);
  assert.throws(() => validateLiveOperationRequest("audio.capture.start", { ...base, maxDurationMs: 10001 }), /outside registry numeric bounds/);
  assert.throws(() => validateLiveOperationRequest("audio.capture.start", { ...base, extra: true }), /not allowed/);
  validateLiveOperationResult("audio.capture.start", { captureId: base.captureId, token: "t".repeat(32), expiresAt: Date.now() + 5000, state: "active", sourceSlotRef: base.sourceSlotRef });
  validateLiveOperationRequest("audio.capture.cleanup", { captureId: base.captureId, token: "t".repeat(32), expectedClipRef: "1:clip:1:0" });
  assert.throws(() => validateLiveOperationRequest("audio.capture.cleanup", { captureId: base.captureId, token: "t".repeat(32) }), /required/);
  validateLiveOperationResult("audio.capture.cleanup", { cleaned: true, filePath: "/project/Samples/Recorded/capture.wav", residual: [] });
  validateLiveOperationResult("audio.capture.status", { active: false, state: "captured", captureId: base.captureId, clip: { ref: "1:clip:1:0", filePath: "/project/capture.wav" } });
});

test("guarded audition and emergency operations replace generic audible invocation", () => {
  const registry = loadLiveRegistry();
  const ids = registry.operations.map((item) => item.id);
  for (const operation of ["clip.duplicate", "clip.move", "arrangement.clip.move"]) assert.ok((registry.operations.find((item) => item.id === operation)?.request.required as string[]).includes("expectedContentFingerprint"), operation);
  for (const extension of ["project.new", "project.open", "project.save", "project.save-as", "project.collect", "project.export", "project.bounce", "arrangement.automation.read", "arrangement.automation.create", "audio.warp-marker.read", "audio.warp-marker.add", "audio.take-lane.read", "audio.comp.read", "browser.preview.start", "browser.preview.stop"]) assert.ok(ids.includes(extension));
  for (const forbidden of ["set", "clip.launch", "track.stop", "playback.stop-all-clips", "scene.launch", "stop-all-clips", "transport.stop"]) assert.equal(ids.includes(forbidden), false);
  const launch = { ref: "1:scene:0", setName: "Disposable Set", sceneName: "Scene 1", sceneIndex: 0, playbackRevision: "1:playback:abc", eligibleTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"], expectedSetIdentity: "live:set:1", expectedAuthorityRevision: "a".repeat(64), outputSafety };
  validateLiveOperationRequest("session.audition-launch", launch);
  validateLiveOperationResult("session.audition-launch", { launched: "1:scene:0", targets: [{ trackRef: "1:track:0", clipSlotRef: "1:clip_slot:0:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0" }] });
  assert.throws(() => validateLiveOperationRequest("session.audition-launch", { ...launch, eligibleTargets: [42] }), /type/);
  const clipAuthority = { slotRef: "1:clip_slot:0:0", trackRef: "1:track:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0", trackIdentity: "live:track:0", sceneIdentity: "live:scene:0", slotIdentity: "live:slot:0:0", clipIdentity: "live:clip:0:0", playbackRevision: "1:playback:abc", outputSafety };
  validateLiveOperationRequest("session.clip-launch", clipAuthority);
  validateLiveOperationRequest("session.clip-stop", { slotRef: clipAuthority.slotRef, trackRef: clipAuthority.trackRef, sceneRef: clipAuthority.sceneRef, sceneIndex: 0, clipRef: clipAuthority.clipRef, trackIdentity: clipAuthority.trackIdentity, sceneIdentity: clipAuthority.sceneIdentity, slotIdentity: clipAuthority.slotIdentity, clipIdentity: clipAuthority.clipIdentity });
  assert.throws(() => validateLiveOperationRequest("session.clip-launch", { ...clipAuthority, trackRef: undefined }), /type|required/);
  validateLiveOperationResult("track.create", { ref: "1:track:0", objectIdentity: "live:track:100", name: "Created", kind: "midi", index: 0, createdFingerprint: "f".repeat(64) });
  validateLiveOperationRequest("track.delete", { ref: "1:track:0", expectedStructureRevision: "a".repeat(64), expectedObjectIdentity: "live:track:100" });
  assert.throws(() => validateLiveOperationRequest("track.delete", { ref: "1:track:0", expectedStructureRevision: "a".repeat(64) }), /required/);
  validateLiveOperationResult("scene.create", { ref: "1:scene:0", objectIdentity: "live:scene:100", name: "Created", index: 0, createdFingerprint: "f".repeat(64) });
  validateLiveOperationRequest("scene.delete", { ref: "1:scene:0", expectedStructureRevision: "a".repeat(64), expectedObjectIdentity: "live:scene:100" });
  validateLiveOperationRequest("session.audition-stop", { ref: "1:scene:0", setName: "Disposable Set", eligibleTargets: [], expectedSetIdentity: "live:set:1", expectedAuthorityRevision: "a".repeat(64) });
  validateLiveOperationResult("session.audition-stop", { stopped: true });
  assert.throws(() => validateLiveOperationResult("session.audition-stop", { stopped: false }), /constant/);
  validateLiveOperationRequest("session.emergency-stop", { expectedTargets: [], expectedRecording: "stopped" });
  validateLiveOperationResult("session.emergency-stop", { stopped: true, stoppedTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"], recordingStopped: true });
  assert.throws(() => validateLiveOperationRequest("session.emergency-stop", {}), /required/);
  const recordingAuthority = { action: "start", expectedSessionRecord: false, expectedArrangementRecord: false, destinationTrackRef: "1:track:0", destinationTrackIdentity: "live:track:0", outputSafety: { safe: true, provenance: "operator-observed" } };
  validateLiveOperationRequest("recording.session", recordingAuthority);
  assert.throws(() => validateLiveOperationRequest("recording.session", { action: "start" }), /required/);
});
