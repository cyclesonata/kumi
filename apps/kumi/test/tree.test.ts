import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeviceNode, DeviceTree } from "@kumi/runtime";
import { focusPathRefs, treeRows, treeWindow } from "../src/tui/tree.js";

const fx = (ref: string, name: string): DeviceNode => ({ ref, name, className: name.replace(/\W/g, ""), deviceType: "audio_effect" });
/** The brief's example: 4-Audio with a Chorus, a Compressor, an Audio Effect Rack of two chains, and a Gate. */
const audio: DeviceTree = { trackRef: "1:track:3", devices: [
  fx("d0", "Chorus-Ensemble"), fx("d1", "Compressor"),
  { ref: "d2", name: "Audio Effect Rack", className: "AudioEffectGroupDevice", canHaveChains: true, chains: [
    { ref: "c0", name: "Chain 1", devices: [fx("d2a", "Saturator"), fx("d2b", "EQ Eight")] },
    { ref: "c1", name: "Chain 2", devices: [fx("d2c", "Saturator"), fx("d2d", "Utility")] },
  ] },
  fx("d3", "Gate"),
] };
const lines = (tree: DeviceTree, focus: { device?: string; chain?: string }) => treeRows(tree, focus).map((row) => `${row.prefix}${row.name}${row.count ? ` (${row.count})` : ""}${row.role === "focus" ? " ◀" : row.role === "path" ? " ·" : ""}`);

test("the path to the selected device is open, and everything else is folded to a count", () => {
  assert.deepEqual(lines(audio, { device: "Saturator", chain: "Chain 1" }), [
    "├ Chorus-Ensemble",
    "├ Compressor",
    "├ Audio Effect Rack ·",
    "│ ├ Chain 1 ·",
    "│ │ ├ Saturator ◀",
    "│ │ └ EQ Eight",
    "│ └ Chain 2 (2)",
    "└ Gate",
  ]);
  // Nothing selected in a rack: the track's devices, racks folded.
  assert.deepEqual(lines(audio, { device: "Gate" }), ["├ Chorus-Ensemble", "├ Compressor", "├ Audio Effect Rack (2)", "└ Gate ◀"]);
  // A selected rack shows its chains, folded.
  assert.deepEqual(lines(audio, { device: "Audio Effect Rack" }).slice(2, 5), ["├ Audio Effect Rack ◀", "│ ├ Chain 1 (2)", "│ └ Chain 2 (2)"]);
});

test("two devices of one name are told apart by the chain selected in Live", () => {
  assert.deepEqual(focusPathRefs(audio, "Saturator", "Chain 2"), ["d2", "c1", "d2c"]);
  assert.deepEqual(focusPathRefs(audio, "Saturator", "Chain 1"), ["d2", "c0", "d2a"]);
  assert.deepEqual(focusPathRefs(audio, "Saturator", undefined), ["d2", "c0", "d2a"], "else the first");
  assert.equal(focusPathRefs(audio, "Reverb", undefined), undefined);
});

test("rows carry their kind, where they are and their neighbours, for the icon, the pin and the model", () => {
  const rows = treeRows(audio, { device: "Saturator", chain: "Chain 1" });
  const saturator = rows.find((row) => row.ref === "d2a")!;
  assert.deepEqual({ kind: saturator.kind, trail: saturator.trail, siblings: saturator.siblings }, { kind: "audio-effect", trail: ["Audio Effect Rack", "Chain 1"], siblings: ["EQ Eight"] });
  assert.equal(rows.find((row) => row.ref === "d2")!.kind, "audio-rack");
  assert.equal(rows.find((row) => row.ref === "c0")!.kind, "chain");
});

test("a Drum Rack's pads fold to a count, nested racks open along the path, and a long tree keeps the focus in its window", () => {
  const drums: DeviceTree = { trackRef: "1:track:0", devices: [
    { ref: "r", name: "Drum Rack", className: "DrumGroupDevice", canHaveChains: true, canHaveDrumPads: true, chains: Array.from({ length: 16 }, (_, index) => ({ ref: `p${index}`, name: `Pad ${index + 1}` })) },
    { ref: "i", name: "Instrument Rack", className: "InstrumentGroupDevice", canHaveChains: true, chains: [
      { ref: "ic", name: "Layer", devices: [{ ref: "ia", name: "Audio Effect Rack", className: "AudioEffectGroupDevice", canHaveChains: true, chains: [
        { ref: "iac", name: "Chain", devices: [fx("deep", "Erosion")] }] }] }] },
  ] };
  assert.deepEqual(lines(drums, { device: "Erosion" }), [
    "├ Drum Rack (16)",
    "└ Instrument Rack ·",
    "  └ Layer ·",
    "    └ Audio Effect Rack ·",
    "      └ Chain ·",
    "        └ Erosion ◀",
  ]);
  assert.equal(treeRows(drums, { device: "Drum Rack" }).filter((row) => row.kind === "drum-pad").length, 16, "a selected Drum Rack lists its pads");
  const long = treeRows(drums, { device: "Drum Rack" });
  const window = treeWindow(long, 12, 12);
  assert.equal(window.rows.length, 12); assert.equal(window.above + window.below + 12, long.length);
  assert.ok(window.rows.includes(long[12]!), "the kept row is in view");
  assert.deepEqual(treeWindow(long.slice(0, 5), 12, 0), { rows: long.slice(0, 5), above: 0, below: 0 });
});
