import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { estimateKey } from "../src/key-estimation.js";
import { DeterministicLiveSimulator, type AsyncLiveAdapter, type LiveDiscoveryRequest } from "../src/live.js";

// An Arrangement clip's row says how many notes it holds (noteCount), not which: what reads them goes
// through `discover note`, page after page.

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);

test("a key estimate of an Arrangement clip reads all its notes, page by page", async () => {
  const simulator = new DeterministicLiveSimulator(); simulator.discoveryBudgetItems = 3;
  // A minor-key phrase: A, C, E, G, D, F and A again, long enough to need three pages.
  const notes = [57, 60, 64, 67, 62, 65, 69].map((pitch, index) => ({ pitch, start: index, duration: 1, velocity: 100, channel: 1, id: index + 1, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 }));
  const clip = { ref: "arrangement-clip:track-1:0", objectIdentity: "simulator:arrangement-clip:phrase", name: "Phrase", kind: "midi", start: 0, length: 8, notes, warp: false, takes: [], automation: [] };
  (simulator as any).state.arrangementClips.push({ clip, trackRef: "track:track-1" });
  const pages: LiveDiscoveryRequest[] = [];
  const adapter = Object.assign(Object.create(simulator), { discoverAsync: async (request: LiveDiscoveryRequest) => { pages.push(request); return simulator.discoverAsync(request); } }) as AsyncLiveAdapter;
  const host = new McpHost(adapter); host.handle(initialize); host.handle(initialized);
  const answer = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_key_estimate", arguments: { clipRef: clip.ref } } }) as any;
  assert.equal(answer.result.isError, false, answer.result.content[0].text);
  const estimate = JSON.parse(answer.result.content[0].text);
  const expected = estimateKey(notes);
  assert.equal(estimate.evidence.noteCount, notes.length); assert.ok(expected.candidates.length > 0); assert.deepEqual(estimate.candidates, JSON.parse(JSON.stringify(expected.candidates)));
  assert.equal(estimate.evidence.notesRevision, createHash("sha256").update(canonical(notes)).digest("hex"));
  assert.deepEqual(pages.map((page) => [page.kind, page.parent, page.cursor === undefined]), [["note", clip.ref, true], ["note", clip.ref, false], ["note", clip.ref, false]]);
  // A Session clip's notes are on its row: no discovery.
  pages.length = 0;
  assert.equal((await host.handleAsync({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_key_estimate", arguments: { clipRef: "clip:clip-1" } } }) as any).result.isError, false);
  assert.equal(pages.length, 0);
});
