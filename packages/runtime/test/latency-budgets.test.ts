/**
 * Latency budgets, counted rather than timed (CI machines are too noisy for milliseconds): the
 * things Kumi's speed is made of. On real Live every Live round trip waits for a display tick,
 * about 100 ms, and every model reply costs seconds, so one more of either is a regression a
 * producer feels. Raising a budget should be a decision, not a side effect.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { KernelTool } from "../src/core/contracts.js";
import { createAgentKernel } from "../src/kernel/agent.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

const TICK = "round trips to Live, each a display tick (about 100 ms) on real Live";

test("budget: reading the Set before an answer is one round trip to Live", async () => {
  const b = await opened();
  try {
    const { trips, calls } = await b.roundTrips(() => b.integration.observe(signal()));
    assert.equal(calls, 4, "status, the Set, its tracks and their devices");
    assert.equal(trips, 1, `the observation's reads go together: ${trips} ${TICK}`);
  } finally { await b.integration.close(); }
});

test("budget: a change is three round trips, and each later step of a plan two", async () => {
  const b = await opened();
  try {
    const single = await b.roundTrips(() => tool(b.tools, "set_tempo").execute({ tempo: 124 }, signal()));
    assert.equal(single.value.isError, false, single.value.text);
    assert.equal(single.trips, 3, `checking Live, the preview and the apply: ${single.trips} ${TICK}`);
    const { tools } = await b.integration.observe(signal());
    const plan = await b.roundTrips(() => tool(tools, "make_changes").execute({ steps: [
      { tool: "set_tempo", input: { tempo: 126 } },
      { tool: "set_mixer", input: { trackRef: "track:1", volume: 0.6 } },
      { tool: "rename", input: { kind: "track", ref: "track:2", name: "Drums" } },
    ] }, signal()));
    assert.equal(plan.value.isError, false, plan.value.text);
    assert.equal(plan.trips, 3 + 2 + 2, `later steps skip the check the first just made: ${plan.trips} ${TICK}`);
  } finally { await b.integration.close(); }
});

test("budget: a rack's pads, or a device's parameters, go as one change whatever their number", async () => {
  const b = await opened({ padBatches: true, parameters: true });
  const folder = mkdtempSync(join(tmpdir(), "kumi-budget-"));
  try {
    for (const name of ["Kick.wav", "Snare.wav", "Hat.wav", "Clap.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const kit = await b.roundTrips(() => tool(b.tools, "make_changes").execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Kit", kind: "midi" }], scenes: [] }, as: "track" },
      { tool: "load_device", input: { trackRef: "@track", itemId: "instruments/Drum Rack" }, as: "rack" },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", sample: { random: true, folders: [folder] } }, each: { note: [36, 37, 38, 39] } },
    ] }, signal()));
    assert.equal(kit.value.isError, false, kit.value.text);
    assert.equal(b.requests.filter((request) => request.name === "live_drum_pad_preview").length, 1, "four pads, one change");
    assert.equal(kit.trips, 8, `a track, a rack and its four pads: ${kit.trips} ${TICK}`);
    const { tools } = await b.integration.observe(signal());
    await tool(tools, "live_discover").execute({ kind: "parameter", parent: "device:1" }, signal());
    const knobs = await b.roundTrips(() => tool(tools, "make_changes").execute({ steps: [
      { tool: "set_device_parameter", input: { deviceRef: "device:1" }, each: { parameterRef: ["parameter:1", "parameter:2", "parameter:3"], value: [0.5, 0.4, 0.3] } },
    ] }, signal()));
    assert.equal(knobs.value.isError, false, knobs.value.text);
    assert.equal(knobs.trips, 3, `three parameters as one change: ${knobs.trips} ${TICK}`);
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("budget: a plan that finishes the request is one model reply, with no reply written after it", async () => {
  let replies = 0;
  const parts: LanguageModelV4StreamPart[] = [
    { type: "tool-call", toolCallId: "c1", toolName: "make_changes", input: JSON.stringify({ steps: [{ tool: "set_tempo", input: { tempo: 124 } }], final: true }) },
    { type: "finish", usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
  const model: LanguageModelV4 = {
    specificationVersion: "v4", provider: "test", modelId: "budget", supportedUrls: {},
    doGenerate: () => { throw new Error("not used"); },
    async doStream() { replies++; return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) }; },
  };
  const plan: KernelTool = { name: "make_changes", description: "plan", inputSchema: { type: "object" }, execute: async () => ({ text: "{\"done\":[]}", reply: "Done: Tempo 120 → 124 BPM." }) };
  const kernel = createAgentKernel({ binding: { id: "test/budget", model, prepare: (request) => ({ prompt: request.messages, tools: request.tools }) }, instructions: "budget", tools: [plan], signal: signal() });
  const result = await kernel.run("set the tempo to 124", signal(), () => {});
  assert.equal(result.stopReason, "completed");
  assert.equal(replies, 1, `model replies for a finished plan: ${replies}, each seconds long`);
  await kernel.close();
});
