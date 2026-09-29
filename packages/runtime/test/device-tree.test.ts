import assert from "node:assert/strict";
import { test } from "node:test";
import type { PinnedNode } from "../src/core/contracts.js";
import { opened, signal } from "./fixtures/synthetic-bridge.js";

test("a track's device tree is read level by level: its devices, then each rack's chains and theirs", async () => {
  const b = await opened({ racks: true });
  try {
    const tree = await b.integration.deviceTree!("7:track:0", signal());
    assert.deepEqual(tree, { trackRef: "7:track:0", devices: [
      { ref: "7:device:0:0", name: "Instrument Rack", className: "InstrumentGroupDevice", chains: [
        { ref: "7:chain:0:0:0", name: "Keys", devices: [{ ref: "7:device:0:0:0:0", name: "Operator", className: "Operator" }] },
        { ref: "7:chain:0:0:1", name: "Pad", devices: [] }] },
      { ref: "7:device:0:1", name: "Reverb", className: "Reverb" }] });
    assert.equal(await b.integration.deviceTree!("not a ref", signal()), undefined);
  } finally { await b.integration.close(); }
});

test("what the producer pointed at goes to the model with a reference it can use this turn, or says it's gone", async () => {
  const b = await opened({ racks: true });
  try {
    const pinned: PinnedNode = { trackRef: "7:track:0", ref: "7:device:0:0:0:0", node: "device", name: "Operator", trail: ["Instrument Rack", "Keys"], siblings: [], track: "Fixture Bass" };
    const observation = await b.integration.observe(signal(), { pinned });
    const context = JSON.parse(observation.context);
    assert.equal(context.pinned.name, "Operator"); assert.equal(context.pinned.in, "Instrument Rack › Keys"); assert.equal(context.pinned.track, "Fixture Bass");
    assert.match(context.pinned.ref, /^device:\d+$/, "the model's short name for it");
    assert.match(context.pinned.note, /"this", "this device" or "this group" in their message means it/);
    const read = await observation.tools.find((tool) => tool.name === "live_discover")!.execute({ kind: "parameter", parent: context.pinned.ref }, signal());
    assert.doesNotMatch(read.text, /must come from discovery/, "usable at once, without discovering it again");
    // Moved within the rack's chain: found again by name where it was. Gone: said so.
    const moved = JSON.parse((await b.integration.observe(signal(), { pinned: { ...pinned, ref: "7:device:0:0:0:9" } })).context).pinned;
    assert.equal(moved.name, "Operator");
    const gone = JSON.parse((await b.integration.observe(signal(), { pinned: { ...pinned, name: "Chorus" } })).context).pinned;
    assert.match(gone.gone, /pointed at “Chorus” on Fixture Bass in Kumi, and it isn't there any more/);
    assert.equal(JSON.parse((await b.integration.observe(signal())).context).pinned, undefined, "only when pointing at something");
  } finally { await b.integration.close(); }
});
