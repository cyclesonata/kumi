import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CatchUp, JsonObject } from "../src/core/contracts.js";
import type { McpEndpoint } from "../src/mcp/client.js";
import { createAbletonIntegration } from "../src/integrations/ableton/index.js";
import { createConversationStore, createProjectStore, describeDiff, describeWatch, projectIdOf, since, type Baseline } from "../src/integrations/ableton/project.js";

// Generated from the bridge's own semantic snapshot code by fixtures/make-catch-up.mjs: a Set with
// Drums and Bass, then tempo 120 → 124, Drums renamed Beats and its device removed, a Pad track
// added and a note added to Bassline.
type Scenario = { before: JsonObject[]; after: JsonObject[]; diff: JsonObject };
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/fixtures/catch-up.json", import.meta.url)), "utf8")) as Scenario & { ambiguous: Scenario };
const artifactOf = (pages: JsonObject[]) => String((pages[0]!.artifact as JsonObject).id);

test("the bridge's semantic diff reads as a producer would say it, without knock-on noise", () => {
  const { lines, more } = describeDiff(fixture.diff, fixture.before, fixture.after);
  assert.deepEqual(lines, [
    "Tempo 120 → 124 BPM",
    "“Drums” → “Beats” (renamed and changed)",
    "Added track “Pad”",
    "Changed clip “Bassline” (notes)",
    "Removed device “Utility”",
  ]);
  assert.equal(more, 0);
  assert(!lines.some((line) => line.includes("Kick Pattern")), "a clip whose track was renamed didn't itself change");
  const short = describeDiff(fixture.diff, fixture.before, fixture.after, 2);
  assert.equal(short.lines.length, 2); assert.equal(short.more, 3);
});

test("what changed while Kumi watched reads exactly, in the order a recipe would make it, each with its track", () => {
  const { changes, more } = describeWatch(fixture.diff, fixture.before, fixture.after);
  assert.equal(more, 0);
  assert.deepEqual(changes.map((change) => [change.added ?? change.removed ?? change.changed, change.added ? "added" : change.removed ? "removed" : "changed", change.name]),
    [["set", "changed", "Simulator Set"], ["track", "added", "Pad"], ["track", "changed", "Beats"], ["device", "removed", "Utility"], ["clip", "changed", "Bassline"]]);
  assert.deepEqual(changes[0]!.what, [{ what: "tempo", from: 120, to: 124 }]);
  const pad = changes[1]!;
  assert.deepEqual(pad.routing, { inputType: "Ext. In", inputSubRouting: "1", outputType: "Main", outputSubRouting: "1/2" }, "how the new track is set up");
  assert.deepEqual(Object.keys(pad.mixer as JsonObject), ["volume", "pan", "sends", "mute", "solo"], "the mixer without Live's rarely used settings");
  assert.equal(changes[2]!.renamedFrom, "Drums", "a track removed and one added in its place is a rename");
  assert.equal(changes[3]!.on, "Drums", "devices and clips say which track they're on");
  assert.equal(changes[4]!.on, "Bass");
  assert(!JSON.stringify(changes).match(/Hash|Fingerprint|parentSnapshotId|order/), "no bookkeeping");
  assert.deepEqual(describeWatch(fixture.ambiguous.diff, fixture.ambiguous.before, fixture.ambiguous.after).changes, [{ unclear: "track", before: ["Vox"], after: ["Lead Vox", "Bells"] }]);
});

test("look-alike tracks the bridge can't tell apart still read as a rename and an addition", () => {
  const { ambiguous } = fixture;
  assert(Array.isArray(ambiguous.diff.items) && (ambiguous.diff.items as JsonObject[]).some((item) => item.type === "ambiguity"), "the bridge reports a group, as on real Live");
  assert.deepEqual(describeDiff(ambiguous.diff, ambiguous.before, ambiguous.after).lines, ["Renamed track “Vox” → “Lead Vox”", "Added track “Bells”"]);
});

test("each saved Set's conversation is kept privately, trimmed from the front when long", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-conversations-"));
  try {
    const store = createConversationStore(directory);
    const id = projectIdOf("/Music/Night Drive.als");
    assert.equal(await store.load(id), undefined);
    await store.save(id, { savedAt: 5, checkpoint: { version: 1, messages: [{ role: "user", content: "hi" }], origin: "openai-codex" } });
    assert.deepEqual(await store.load(id), { savedAt: 5, checkpoint: { version: 1, messages: [{ role: "user", content: "hi" }], origin: "openai-codex" } });
    if (process.platform !== "win32") assert.equal(statSync(join(directory, id, "conversation.json")).mode & 0o777, 0o600);
    const long = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `${index}:${"x".repeat(10_000)}` }));
    await store.save(id, { savedAt: 6, checkpoint: { version: 1, messages: long } });
    const kept = (await store.load(id))!.checkpoint.messages as { role: string; content: string }[];
    assert(kept.length < long.length && Buffer.byteLength(JSON.stringify(kept)) <= 256 * 1024);
    assert.equal(kept[0]!.role, "user", "it starts where the producer spoke"); assert.equal(kept.at(-1)!.content, long.at(-1)!.content, "the newest part is kept");
    const shaped = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }] }));
    await store.save(id, { savedAt: 7, checkpoint: { version: 1, messages: shaped } });
    const noted = (await store.load(id))!.checkpoint.messages as { content: { text: string }[] }[];
    assert.match(noted[0]!.content[0]!.text, /^\[Kumi removed the earlier part of this conversation to save room\.\]\n\n\d+:x/, "the model is told the start is gone, as in the kernel");
    await store.clear(id);
    assert.equal(await store.load(id), undefined);
    assert.equal(await store.load("../escape"), undefined, "an invalid id reads as nothing");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("time since reads in plain words", () => {
  const now = Date.UTC(2026, 8, 28);
  assert.equal(since(now - 30_000, now), "just now");
  assert.equal(since(now - 25 * 60_000, now), "25 minutes ago");
  assert.equal(since(now - 60 * 60_000, now), "1 hour ago");
  assert.equal(since(now - 3 * 24 * 60 * 60_000, now), "3 days ago");
});

test("each saved Set's last state is kept privately, one folder per Set", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-projects-"));
  try {
    const store = createProjectStore(directory);
    const baseline: Baseline = { version: 1, path: "/Music/Night Drive.als", name: "Night Drive", savedAt: 1, artifactId: artifactOf(fixture.before), pages: fixture.before };
    await store.save(baseline);
    assert.deepEqual(await store.load("/Music/Night Drive.als"), baseline);
    assert.equal(await store.load("/Music/Other.als"), undefined);
    const [folder] = readdirSync(directory);
    assert.match(folder!, /^[0-9a-f]{32}$/, "the folder name doesn't reveal the Set's path");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(directory, folder!)).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, folder!, "last-seen.json")).mode & 0o777, 0o600);
    }
    writeFileSync(join(directory, folder!, "last-seen.json"), "{broken");
    assert.equal(await store.load("/Music/Night Drive.als"), undefined, "a damaged record is ignored, not fatal");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function bridge(options: { path?: string; pages: JsonObject[] }) {
  const calls: string[] = [];
  let pages = options.pages;
  // Devices in the Set, for watch_me: the Utility on Drums, then a Saturator the producer adds to Pad.
  let devices: JsonObject[] = [{ ref: "3:device:0:0", parentRef: "3:track:0", objectIdentity: "live:1", name: "Utility", className: "StereoGain" }];
  let path = options.path; let setName = "Night Drive";
  const names = ["server_status", "live_status", "live_discover", "live_snapshot", "live_undo", "live_tempo_preview", "live_tempo_apply",
    "live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff"];
  const catalog: Tool[] = names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));
  const wrap = (value: JsonObject): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const endpoint: McpEndpoint = {
    pid: null, serverInfo: { name: "kumi-synthetic-bridge", version: "1" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
    async list() { return { tools: catalog }; },
    async call(name, args) {
      calls.push(name);
      if (name === "live_status") return wrap({ connected: true, adapter: "remote-script", provenance: "fake-live", epoch: 3 });
      if (name === "live_discover") {
        const items = args.kind === "set" ? [{ ref: "3:set:song", objectIdentity: "song", name: setName, tempo: 124 }]
          : args.kind === "device" ? devices
          : args.kind === "track" && args.fields ? [{ ref: "3:track:0", name: "Beats", mediaKind: "midi" }, { ref: "3:track:1", name: "Bass", mediaKind: "midi" }, { ref: "3:track:2", name: "Pad", mediaKind: "audio" }]
          : args.kind === "parameter" && args.parent === "3:device:2:0" ? [
            { name: "Device On", value: 1, defaultValue: null, displayValue: "On" }, { name: "Drive", value: 18, defaultValue: 0, displayValue: "18.0 dB" },
            { name: "Dry/Wet", value: 1, defaultValue: 1, displayValue: "100 %" }, { name: "Type", value: 3, defaultValue: null, displayValue: "Digital Clip" }]
          : [];
        return wrap({ epoch: 3, kind: args.kind, items, revision: "r", truncated: false });
      }
      if (name === "live_project_info") return wrap(path ? { path, exists: true, tracks: 3 } : { path: null, exists: false });
      if (name === "live_project_snapshot_export") return wrap(pages[0]!);
      if (name === "live_project_snapshot_diff") return wrap(fixture.diff);
      if (name === "live_tempo_preview") return wrap({ transactionId: "t1", epoch: 3, priorTempo: 124, proposedTempo: 126, confirmation: "apply" });
      if (name === "live_tempo_apply") return wrap({ transactionId: "t1", state: "applied" });
      return wrap({});
    },
    onCatalogChanged() { return () => {}; },
    onDisconnect() { return () => {}; },
    async close() {},
  };
  return { endpoint, calls, setPages: (next: JsonObject[]) => { pages = next; }, saveAs: (next: string, name: string) => { path = next; setName = name; },
    addDevice: (device: JsonObject) => { devices = [...devices, device]; } };
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 2_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("timed out waiting");
}

test("seeing a saved Set again catches up on what changed, tells the model, and remembers the Set as it is now", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-projects-"));
  const store = createProjectStore(directory);
  const threeDays = 3 * 24 * 60 * 60_000;
  const now = Date.UTC(2026, 8, 28, 12);
  await store.save({ version: 1, path: "/Music/Night Drive.als", name: "Night Drive", savedAt: now - threeDays, artifactId: artifactOf(fixture.before), pages: fixture.before });
  const b = bridge({ path: "/Music/Night Drive.als", pages: fixture.after });
  const caught: CatchUp[] = [];
  const integration = createAbletonIntegration({ connect: async () => b.endpoint, onConnection: () => {}, now: () => new Date(now), projectStore: store, onCatchUp: (value) => caught.push(value) });
  try {
    await integration.start(AbortSignal.timeout(5_000));
    const first = await integration.observe(AbortSignal.timeout(5_000));
    assert.deepEqual(first.project, { id: projectIdOf("/Music/Night Drive.als"), name: "Night Drive" }, "the observation names the saved Set");
    const catchUp = await waitFor(() => caught[0]);
    assert.equal(catchUp.set, "Night Drive"); assert.equal(catchUp.lastSeenAt, now - threeDays);
    assert.deepEqual(catchUp.lines.slice(0, 3), ["Tempo 120 → 124 BPM", "“Drums” → “Beats” (renamed and changed)", "Added track “Pad”"]);
    assert(!first.tools.some((tool) => tool.name.startsWith("live_project")), "catching up is Kumi's own work, not a model tool");
    const next = await integration.observe(AbortSignal.timeout(5_000));
    const context = JSON.parse(next.context) as { sinceLastTime?: { lastSeen: string; changes: string[] } };
    assert.equal(context.sinceLastTime?.lastSeen, "3 days ago");
    assert.equal(context.sinceLastTime?.changes[0], "Tempo 120 → 124 BPM");
    const remembered = await waitFor(async () => { const value = await store.load("/Music/Night Drive.als"); return value?.artifactId === artifactOf(fixture.after) ? value : undefined; });
    assert.equal(remembered.name, "Night Drive", "next time starts from the Set as Kumi saw it now");
    assert.equal(caught.length, 1, "one catch-up per Set per session");
  } finally { await integration.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an unchanged Set says nothing changed; an unsaved Set isn't remembered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-projects-"));
  const store = createProjectStore(directory);
  try {
    await store.save({ version: 1, path: "/Music/Same.als", name: "Same", savedAt: 1, artifactId: artifactOf(fixture.after), pages: fixture.after });
    const same = bridge({ path: "/Music/Same.als", pages: fixture.after });
    const caught: CatchUp[] = [];
    const integration = createAbletonIntegration({ connect: async () => same.endpoint, onConnection: () => {}, projectStore: store, onCatchUp: (value) => caught.push(value) });
    await integration.start(AbortSignal.timeout(5_000)); await integration.observe(AbortSignal.timeout(5_000));
    const catchUp = await waitFor(() => caught[0]);
    assert.deepEqual(catchUp.lines, []);
    assert(!same.calls.includes("live_project_snapshot_diff"), "identical states need no comparison");
    await integration.close();

    const unsaved = bridge({ pages: fixture.after });
    const none: CatchUp[] = [];
    const other = createAbletonIntegration({ connect: async () => unsaved.endpoint, onConnection: () => {}, projectStore: createProjectStore(join(directory, "unsaved")), onCatchUp: (value) => none.push(value) });
    await other.start(AbortSignal.timeout(5_000)); await other.observe(AbortSignal.timeout(5_000));
    await waitFor(() => (unsaved.calls.includes("live_project_info") ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(none.length, 0); assert(!unsaved.calls.includes("live_project_snapshot_export"), "nothing to remember without a file");
    await other.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Save As moves the Set's conversation to the new file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-projects-"));
  try {
    const b = bridge({ path: "/Music/Night Drive.als", pages: fixture.after });
    const integration = createAbletonIntegration({ connect: async () => b.endpoint, onConnection: () => {}, projectStore: createProjectStore(directory) });
    await integration.start(AbortSignal.timeout(5_000));
    const first = await integration.observe(AbortSignal.timeout(5_000));
    b.saveAs("/Music/Night Drive v2.als", "Night Drive v2");
    const second = await integration.observe(AbortSignal.timeout(5_000));
    assert.equal(second.key, first.key, "the same conversation continues");
    assert.deepEqual(second.project, { id: projectIdOf("/Music/Night Drive v2.als"), name: "Night Drive v2" }, "and is kept with the new file");
    await integration.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("closing remembers the Set as Kumi leaves it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-projects-"));
  const store = createProjectStore(directory);
  try {
    const b = bridge({ path: "/Music/Night Drive.als", pages: fixture.before });
    const integration = createAbletonIntegration({ connect: async () => b.endpoint, onConnection: () => {}, projectStore: store });
    await integration.start(AbortSignal.timeout(5_000)); await integration.observe(AbortSignal.timeout(5_000));
    await waitFor(() => (b.calls.filter((call) => call === "live_project_snapshot_export").length >= 1 ? true : undefined));
    b.setPages(fixture.after);
    await integration.close();
    assert.equal((await store.load("/Music/Night Drive.als"))?.artifactId, artifactOf(fixture.after));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("watch_me learns a routine: the Set before, the Set after, and the knobs the producer turned on what they added", async () => {
  const b = bridge({ pages: fixture.before });
  const integration = createAbletonIntegration({ connect: async () => b.endpoint, onConnection: () => {}, now: () => new Date(Date.UTC(2026, 8, 28, 12)) });
  try {
    await integration.start(AbortSignal.timeout(5_000));
    let observation = await integration.observe(AbortSignal.timeout(5_000));
    const watch = () => observation.tools.find((tool) => tool.name === "watch_me")!;
    assert(watch(), "offered when the bridge can compare the Set's states");
    const early = await watch().execute({ action: "stop" }, AbortSignal.timeout(5_000));
    assert.equal(early.isError, true); assert.match(early.text, /start first/);
    const started = await watch().execute({ action: "start" }, AbortSignal.timeout(5_000));
    assert.equal(started.isError, false, started.text);
    assert.match(started.text, /go ahead in Live/);
    // The producer works in Live.
    b.setPages(fixture.after);
    b.addDevice({ ref: "3:device:2:0", parentRef: "3:track:2", objectIdentity: "live:2", name: "Saturator", className: "Saturator" });
    observation = await integration.observe(AbortSignal.timeout(5_000));
    const stopped = await watch().execute({ action: "stop" }, AbortSignal.timeout(5_000));
    assert.equal(stopped.isError, false, stopped.text);
    const seen = JSON.parse(stopped.text) as { changes: JsonObject[]; devicesAdded: JsonObject[] };
    assert.equal(seen.changes.find((change) => change.added === "track")!.media, "audio", "an added track says whether it's audio or MIDI");
    assert.deepEqual(seen.devicesAdded, [{ device: "Saturator", className: "Saturator", on: "Pad", knobs: [{ name: "Drive", value: 18, shows: "18.0 dB" }] }],
      "only what moved from Live's defaults; switches and modes can't be compared");
    const again = await watch().execute({ action: "stop" }, AbortSignal.timeout(5_000));
    assert.equal(again.isError, true, "one watch, one answer");
  } finally { await integration.close(); }
});
