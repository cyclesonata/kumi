import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginAdapter } from "../src/plugins/adapter.js";
import { adapterFor, groupNames, pluginGuide } from "../src/plugins/registry.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

const synth: PluginAdapter = {
  id: "fixture-synth", name: "Fixture Synth", vendor: "Kumi", kind: "instrument", match: /^fixture ?synth/i,
  overview: "Two oscillators into a filter.",
  sections: [{ name: "Filter", about: "One low-pass.", parameters: [{ role: "cutoff", names: /^(fil|filter)\s*cutoff$/i, about: "Where it closes" }, { role: "drive", names: /drive/i, about: "Grit" }] }],
  recipes: [{ name: "Reese", how: "Two saws, 12 cents apart." }],
  beyond: "Its wavetables aren't parameters.",
  wavetable: { frame: 2048, maxFrames: 256, format: "clm" },
};

test("a plug-in's guide sets Kumi's notes against its real parameters: what Kumi can turn, and the rest grouped", () => {
  assert.equal(adapterFor("Fixture Synth", [synth])?.id, "fixture-synth");
  assert.equal(adapterFor("FixtureSynth (VST3)", [synth])?.id, "fixture-synth");
  assert.equal(adapterFor("Operator", [synth]), undefined);
  const names = ["Fil Cutoff", "Fil Reso", "A Level", "A Pan", "A Octave", "B Level", "Drive"];
  const guide = pluginGuide("Fixture Synth", synth, names, [{ name: "Fil Cutoff", ref: "7:parameter:1", display: "812 Hz" }]) as Record<string, any>;
  assert.equal(guide.plugin, "Fixture Synth (Kumi)");
  assert.deepEqual(guide.canTurn, [{ name: "Fil Cutoff", ref: "7:parameter:1", now: "812 Hz" }]);
  assert.deepEqual(guide.sections[0].parameters[0].live, ["Fil Cutoff (Kumi can turn it)"]);
  assert.deepEqual(guide.sections[0].parameters[1].live, ["Drive"]);
  assert.equal(guide.parameters.notConfigured, 6);
  assert.match(guide.toTurnMore, /Configure/);
  assert.deepEqual(groupNames(["A Level", "A Pan", "B Level", "LFO 1 Rate", "LFO 1 Depth"]).map((group) => [group.group, group.count]), [["A", 2], ["B", 1], ["LFO 1", 2]]);
  const unknown = pluginGuide("Mystery Box", undefined, ["Knob 1"], []) as Record<string, any>;
  assert.match(unknown.note, /no notes on this plug-in/);
});

test("the plugin tool reads a plug-in's names and what Live exposes, and makes a wavetable into a folder the synth reads", async () => {
  const library = mkdtempSync(join(tmpdir(), "kumi-plugins-library-"));
  const b = await opened({ version: "1.0.70", parameters: true, fullControl: true });
  try {
    await tool(b.tools, "live_discover").execute({ kind: "parameter", parent: "device:1" }, signal());
    const guide = await tool(b.tools, "plugin").execute({ device: "device:1", action: "guide" }, signal());
    assert.equal(guide.isError, false, guide.text);
    const read = JSON.parse(guide.text) as { parameters: { total: number }; canTurn: { name: string }[] };
    assert.equal(read.parameters.total, 3);
    assert.ok(read.canTurn.length >= 1, "what Live exposes is listed");
    const made = await tool(b.tools, "plugin").execute({ device: "device:1", action: "wavetable", wavetable: { name: "Kumi Growl", keyframes: [{ shape: "saw" }, { shape: "square" }], count: 8 } }, signal());
    assert.equal(made.isError, false, made.text);
    const reply = JSON.parse(made.text) as { file: string; frames: number };
    assert.equal(reply.frames, 8);
    assert.ok(existsSync(reply.file));
    assert.ok(reply.file.includes("kumi-user-library-"), "into the test's own User Library");
  } finally { await b.integration.close(); void library; }
});
