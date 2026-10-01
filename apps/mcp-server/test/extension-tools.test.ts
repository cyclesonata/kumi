import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExtensionChannel, readExtensionEndpoint } from "../src/bridge/extension-channel.js";
import { routedAdapter } from "../src/bridge/router.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, EXTENSION_OPERATIONS, type AsyncLiveAdapter } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const KEPT = "Kumi can't bring this back; Live's undo can.";

function hosted(adapter: ConstructorParameters<typeof McpHost>[0], options: ConstructorParameters<typeof McpHost>[1] = {}) {
  const host = new McpHost(adapter, options); host.handle(initialize); host.handle(initialized);
  let id = 100;
  const call = async (name: string, args: unknown) => { const answer = await host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: unknown }; assert.ok(answer.result, JSON.stringify(answer.error)); return { isError: answer.result.isError, body: JSON.parse(answer.result.content[0]!.text) as Record<string, any> }; };
  const change = async (tool: string, args: unknown, key: string) => { const preview = await call(`${tool}_preview`, args); assert.equal(preview.isError, false, JSON.stringify(preview.body)); const applied = await call(`${tool}_apply`, { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: key }); return { preview: preview.body, applied }; };
  const undo = (transactionId: string, key: string) => call("live_undo", { transactionId, confirmation: "undo", idempotencyKey: key });
  const tools = () => ((host.handle({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
  const raw = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) as Promise<{ error?: { code: number } }>;
  return { host, call, change, undo, tools, raw };
}

type State = { tracks: Array<Record<string, any>>; arrangementClips: Array<{ clip: Record<string, any>; trackRef: string }> };
const stateOf = (simulator: DeterministicLiveSimulator) => (simulator as unknown as { state: State }).state;
const structure = (simulator: DeterministicLiveSimulator) => { const snapshot = simulator.snapshot(); return createHash("sha256").update(JSON.stringify({ tracks: snapshot.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: snapshot.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) })).digest("hex"); };

test("an audio track renders offline to a file; a MIDI track or a group is refused, and nothing changes", async () => {
  const simulator = new DeterministicLiveSimulator();
  simulator.invoke({ operation: "track.create", args: { name: "Vox", kind: "audio", expectedStructureRevision: structure(simulator) } });
  const vox = simulator.snapshot().tracks.find((track) => track.name === "Vox")!;
  const { call } = hosted(simulator);
  const rendered = await call("live_render_offline", { trackRef: vox.ref, fromBeat: 0, toBeat: 8, expectedName: "Vox" });
  assert.equal(rendered.isError, false, JSON.stringify(rendered.body));
  assert.deepEqual([rendered.body.format, rendered.body.seconds, rendered.body.name], ["wav", 4, "Vox"]);
  assert.equal(statSync(rendered.body.path).size, rendered.body.bytes); rmSync(rendered.body.path);
  assert.match((await call("live_render_offline", { trackRef: "track:track-1", fromBeat: 0, toBeat: 4 })).body.reason, /isn't an audio track/);
  assert.match((await call("live_render_offline", { trackRef: vox.ref, fromBeat: 0, toBeat: 4, expectedName: "Lead" })).body.reason, /"Vox" now, not "Lead"/);
  stateOf(simulator).tracks[1]!.kind = "group";
  assert.match((await call("live_render_offline", { trackRef: vox.ref, fromBeat: 0, toBeat: 4 })).body.reason, /is a group/);
});

test("MIDI clips with their notes go into the Arrangement, found again through the LOM, and undo deletes exactly them", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, raw, change, undo } = hosted(simulator);
  const notes = [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1, velocity: 90 }];
  const one = await change("live_arrangement_midi_clip", { trackRef: "track:track-1", start: 16, length: 4, name: "Hook", notes }, "arranged-hook");
  assert.equal(one.applied.body.state, "applied", JSON.stringify(one.applied.body));
  const made = stateOf(simulator).arrangementClips.find((item) => item.clip.name === "Hook")!;
  assert.deepEqual([made.clip.start, made.clip.length, made.clip.notes.length], [16, 4, 2]);
  assert.equal(one.applied.body.clips[0].objectIdentity, made.clip.objectIdentity);
  // Where the Arrangement already holds a clip, a new one is refused rather than laid over it.
  assert.match((await call("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 18, length: 4, notes })).body.reason, /already has "Hook"/);
  // Several clips are one change: one Live group, one undo.
  const several = await change("live_arrangement_midi_clip", { clips: [{ trackRef: "track:track-1", start: 0, length: 4, name: "A", notes }, { trackRef: "track:track-1", start: 4, length: 4, name: "B", notes: [] }] }, "arranged-pair");
  assert.equal(several.applied.body.clips.length, 2);
  assert.equal((await undo(several.preview.transactionId, "arranged-pair-undo")).body.state, "undone");
  assert.deepEqual(stateOf(simulator).arrangementClips.map((item) => item.clip.name), ["Hook"]);
  assert.equal((await undo(one.preview.transactionId, "arranged-hook-undo")).body.state, "undone");
  assert.equal(stateOf(simulator).arrangementClips.length, 0);
  assert.equal((await raw("live_arrangement_midi_clip_preview", { trackRef: "track:track-1", start: 0, length: 4, notes: [{ pitch: 60, start: 5, duration: 1 }] })).error?.code, -32602, "a note starts inside its clip");
});

test("a group of clips that stops partway records the ones it made (HISTORY undoes them) and says which weren't", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { change, undo } = hosted(simulator);
  // Live refuses the second clip of three.
  const operation = (simulator as unknown as { extensionOperation(name: string, args: Record<string, unknown>): Record<string, unknown> });
  const original = operation.extensionOperation.bind(simulator); let calls = 0;
  operation.extensionOperation = (name, args) => { if (name === "arrangement.midi-clip.create" && ++calls === 2) throw new Error("Live refused it"); return original(name, args); };
  const notes = [{ pitch: 60, start: 0, duration: 1 }];
  const group = await change("live_arrangement_midi_clip", { clips: [0, 4, 8].map((start, index) => ({ trackRef: "track:track-1", start, length: 4, name: `Part ${index + 1}`, notes })) }, "partial-group");
  assert.equal(group.applied.body.state, "applied", JSON.stringify(group.applied.body));
  assert.deepEqual(group.applied.body.clips.map((clip: { name: string }) => clip.name), ["Part 1"]);
  assert.deepEqual([group.applied.body.partial.made, group.applied.body.partial.of], [1, 3]);
  assert.deepEqual(group.applied.body.partial.notMade.map((clip: { name: string }) => clip.name), ["Part 2", "Part 3"]);
  assert.match(group.applied.body.partial.reason, /step 2 failed \(Live refused it\)/);
  assert.deepEqual(stateOf(simulator).arrangementClips.map((item) => item.clip.name), ["Part 1"]);
  assert.equal((await undo(group.preview.transactionId, "partial-group-undo")).body.state, "undone");
  assert.equal(stateOf(simulator).arrangementClips.length, 0, "the clip it made is gone with the undo");
});

test("a group of clips that timed out partway stays uncertain, and the same-key retry records the clips Live made", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call } = hosted(simulator);
  // Live makes the first clip, then the answer never comes.
  const adapter = simulator as unknown as { invokeAsync(invocation: { operation: string; args: Record<string, any> }, context: unknown): Promise<unknown> };
  const original = adapter.invokeAsync.bind(simulator);
  adapter.invokeAsync = async (invocation, context) => {
    if (invocation.operation !== "transaction.group") return original(invocation, context);
    await original({ operation: invocation.args.ops[0].operation, args: invocation.args.ops[0].args }, context);
    throw new Error("Kumi's Live extension didn't answer transaction.group in time");
  };
  const notes = [{ pitch: 60, start: 0, duration: 1 }];
  const preview = await call("live_arrangement_midi_clip_preview", { clips: [0, 4].map((start, index) => ({ trackRef: "track:track-1", start, length: 4, name: `Part ${index + 1}`, notes })) });
  const apply = () => call("live_arrangement_midi_clip_apply", { transactionId: preview.body.transactionId, confirmation: "apply", idempotencyKey: "timed-out-group" });
  const first = await apply();
  assert.equal(first.isError, true); assert.match(JSON.stringify(first.body), /uncertain/i);
  const retried = await apply();
  assert.equal(retried.body.state, "applied", JSON.stringify(retried.body));
  assert.deepEqual(retried.body.clips.map((clip: { name: string }) => clip.name), ["Part 1"]);
  assert.deepEqual(retried.body.partial.notMade.map((clip: { name: string }) => clip.name), ["Part 2"]);
  assert.deepEqual(stateOf(simulator).arrangementClips.map((item) => item.clip.name), ["Part 1"], "the retry made nothing more");
});

test("a cleared range loses the clips inside and cuts the ones crossing it, and the clearing is kept", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call, change, undo } = hosted(simulator);
  await change("live_arrangement_midi_clip", { clips: [{ trackRef: "track:track-1", start: 0, length: 4, name: "Across", notes: [] }, { trackRef: "track:track-1", start: 6, length: 2, name: "Inside", notes: [] }] }, "seed-range");
  const cleared = await change("live_clip_clear_range", { trackRef: "track:track-1", fromBeat: 2, toBeat: 8 }, "clear-range");
  assert.deepEqual(cleared.preview.removes.map((clip: { name: string }) => clip.name), ["Inside"]); assert.deepEqual(cleared.preview.cuts.map((clip: { name: string }) => clip.name), ["Across"]);
  assert.equal(cleared.applied.body.state, "applied", JSON.stringify(cleared.applied.body)); assert.equal(cleared.applied.body.kept, KEPT);
  assert.deepEqual(stateOf(simulator).arrangementClips.map((item) => [item.clip.name, item.clip.start, item.clip.length]), [["Across", 0, 2]]);
  assert.equal((await undo(cleared.preview.transactionId, "clear-range-undo")).body.reason, KEPT);
  assert.match((await call("live_clip_clear_range_preview", { trackRef: "track:track-1", fromBeat: 10, toBeat: 12 })).body.reason, /no Arrangement clips between/);
});

test("a device is copied straight after itself, and undo deletes the copy", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { change, undo } = hosted(simulator);
  const copied = await change("live_device_duplicate", { deviceRef: "device:utility-1" }, "copy-utility");
  assert.equal(copied.applied.body.state, "applied", JSON.stringify(copied.applied.body));
  const devices = () => stateOf(simulator).tracks[0]!.devices as Array<{ ref: string; name: string }>;
  assert.deepEqual(devices().map((device) => device.name), ["Utility", "Utility"]); assert.equal(devices()[1]!.ref, copied.applied.body.created.ref);
  assert.equal((await undo(copied.preview.transactionId, "copy-utility-undo")).body.state, "undone");
  assert.deepEqual(devices().map((device) => device.ref), ["device:utility-1"]);
});

test("an instrument isn't copied beside itself: a chain holds one, so the preview says to duplicate its track", async () => {
  const simulator = new DeterministicLiveSimulator();
  const { call } = hosted(simulator);
  Object.assign(stateOf(simulator).tracks[0]!.devices[0]!, { name: "Drift", deviceType: "instrument" });
  const refused = await call("live_device_duplicate_preview", { deviceRef: "device:utility-1" });
  assert.equal(refused.body.reason, "a chain holds one instrument, so Live can't copy \"Drift\" beside itself", JSON.stringify(refused.body));
  assert.equal(refused.body.remediation, "No device was copied: duplicate its track instead.");
  assert.equal((stateOf(simulator).tracks[0]!.devices as unknown[]).length, 1);
});

test("a sample goes onto an empty pad without the Browser, through a new chain, and undo clears the pad", async () => {
  const simulator = new DeterministicLiveSimulator();
  const managed = mkdtempSync(join(tmpdir(), "chain-staging-"));
  const { raw, change, undo } = hosted(simulator, { importStagingDir: managed });
  const dir = mkdtempSync(join(tmpdir(), "chain-samples-"));
  const samplePath = join(dir, "Clap 909.wav");
  writeFileSync(samplePath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fake-audio-bytes")]));
  const rack = (await change("live_device", { action: "insert", trackRef: "track:track-1", deviceName: "Drum Rack" }, "chain-rack")).applied.body.result;
  const loaded = await change("live_drum_pad", { action: "sample-chain", deviceRef: rack.ref, note: 39, filePath: samplePath, allowedRoot: dir }, "chain-clap");
  assert.equal(loaded.applied.body.state, "applied", JSON.stringify(loaded.applied.body));
  const pad = () => (stateOf(simulator).tracks[0]!.devices.find((device: { ref: string }) => device.ref === rack.ref).drumPads as Array<{ note: number; chains: unknown[] }>).find((item) => item.note === 39)!;
  assert.equal(pad().chains.length, 1);
  assert.equal((await raw("live_drum_pad_preview", { action: "sample-chain", deviceRef: rack.ref, note: 39, filePath: samplePath, allowedRoot: dir, instrument: "Drum Sampler" })).error?.code, -32602, "the chain gets a Simpler");
  assert.equal((await undo(loaded.preview.transactionId, "chain-clap-undo")).body.state, "undone");
  assert.equal(pad().chains.length, 0);
});

test("an audio file from the allowed folder is copied into the project; anything else is refused before Live hears of it", async () => {
  const managed = mkdtempSync(join(tmpdir(), "import-staging-"));
  const { call, raw } = hosted(new DeterministicLiveSimulator(), { importStagingDir: managed });
  const dir = mkdtempSync(join(tmpdir(), "import-sources-")); const file = join(dir, "Loop.wav");
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fake-audio-bytes")]); writeFileSync(file, wav);
  const imported = await call("live_project_import", { filePath: file, allowedRoot: dir });
  assert.equal(imported.isError, false, JSON.stringify(imported.body)); assert.match(imported.body.path, /Samples[\\/]Imported[\\/]Loop\.wav$/);
  assert.equal(imported.body.bytes, wav.length);
  // The verified copy Live copied from goes once the project has its own.
  assert.deepEqual(readdirSync(managed), []);
  assert.match((await call("live_project_import", { filePath: join(dir, "Gone.wav"), allowedRoot: dir })).body.reason, /no file at that path/);
  // Outside the allowed folder, a link, a file that isn't audio, a network share: none reaches Live.
  const elsewhere = mkdtempSync(join(tmpdir(), "import-elsewhere-")); const secret = join(elsewhere, "auth.json"); writeFileSync(secret, "{\"token\":\"x\"}");
  assert.match((await call("live_project_import", { filePath: secret, allowedRoot: dir })).body.reason, /escapes the allowed root/);
  const linked = join(dir, "Linked.wav"); symlinkSync(secret, linked);
  assert.match((await call("live_project_import", { filePath: linked, allowedRoot: dir })).body.reason, /is a link/);
  const json = join(dir, "auth.json"); writeFileSync(json, "{}");
  assert.match((await call("live_project_import", { filePath: json, allowedRoot: dir })).body.reason, /not an importable audio file/);
  const disguised = join(dir, "Disguised.wav"); writeFileSync(disguised, "not audio at all, just text");
  assert.match((await call("live_project_import", { filePath: disguised, allowedRoot: dir })).body.reason, /does not match the declared audio format/);
  assert.equal((await raw("live_project_import", { filePath: "\\\\server\\share\\Loop.wav", allowedRoot: "\\\\server\\share" })).error?.code, -32602);
  assert.equal((await raw("live_project_import", { filePath: file })).error?.code, -32602, "the allowed folder is required");
});

// Kumi's Live extension as committed, in this process, against the extension's own fake Live, and a
// Remote Script stand-in without the extension's operations: the router sends them to the extension.
const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const extensionDir = join(repository, "apps", "live-extension");
let root: string; let storage: string; let extension: { activate(activation: unknown): void; deactivate(): Promise<void> };

before(async () => {
  root = mkdtempSync(join(tmpdir(), "extension-tools-")); storage = join(root, "storage");
  const { fakeLive } = await import(pathToFileURL(join(extensionDir, "test", "fake-live.mjs")).href) as { fakeLive(options: Record<string, string>): { activation: unknown } };
  extension = createRequire(import.meta.url)(join(extensionDir, "dist", "extension.js")) as typeof extension;
  extension.activate(fakeLive({ storage, temp: join(root, "temp"), liveTemp: join(root, "live-temp") }).activation);
  for (let tries = 0; !readExtensionEndpoint(storage) && tries < 500; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
});
after(async () => { await extension.deactivate(); rmSync(root, { recursive: true, force: true }); });

test("the extension's tools appear while it's connected, and a render goes to it through the router", async () => {
  // The LOM side: the fake extension's Set (Keys, Drums, Vox), with positional references.
  const simulator = new DeterministicLiveSimulator();
  const state = stateOf(simulator); const base = state.tracks[0]!;
  state.tracks = [["Keys", "midi"], ["Drums", "midi"], ["Vox", "audio"]].map(([name, kind], index) => ({ ...structuredClone(base), ref: `3:track:${index}`, objectIdentity: `live:track:${index}`, name, kind: "regular", mediaKind: kind, clips: [], clipSlots: [], devices: [] }));
  const lom = Object.create(simulator) as DeterministicLiveSimulator;
  lom.status = () => { const status = simulator.status(); return { ...status, operations: (status.operations ?? []).filter((operation) => !(EXTENSION_OPERATIONS as readonly string[]).includes(operation)) }; };
  const channel = new ExtensionChannel({ storageDirectory: storage });
  const adapter = routedAdapter(lom as unknown as AsyncLiveAdapter, channel);
  const { call, tools } = hosted(adapter);
  assert.equal(tools().includes("live_render_offline"), false, "no extension, no render tool");
  assert.equal(await channel.connect(), true);
  assert.equal(tools().includes("live_render_offline"), true);
  assert.equal(tools().includes("live_arrangement_midi_clip_preview"), true);
  const rendered = await call("live_render_offline", { trackRef: "3:track:2", fromBeat: 0, toBeat: 4 });
  assert.equal(rendered.isError, false, JSON.stringify(rendered.body));
  assert.deepEqual([rendered.body.format, rendered.body.seconds, rendered.body.name], ["wav", 2, "Vox"]);
  assert.equal(existsSync(rendered.body.path), true);
  await channel.close();
  assert.equal(tools().includes("live_render_offline"), false, "the tools go with the extension");
});
