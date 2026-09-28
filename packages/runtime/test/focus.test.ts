import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LiveFocus } from "../src/core/contracts.js";
import { parseFocus, startFocusFeed } from "../src/integrations/ableton/focus.js";

test("focus rows become plain names, and anything malformed is left out", () => {
  assert.deepEqual(parseFocus({
    focusTrackName: "Bass", focusTrackColor: "#f59a3c", focusTrackKind: "midi", focusSceneName: "Verse", focusClipName: "",
    focusDeviceName: "Operator", focusParameterName: "Filter Freq", focusParameterValue: "1.20 kHz", focusParameterOwner: "Operator",
    focusChainName: null, focusView: "Session", focusDetail: "Device", focusBrowser: false, focusSelectedNotes: 3,
  }), {
    track: { name: "Bass", color: "#f59a3c", kind: "midi" }, scene: "Verse", clip: "", device: "Operator",
    parameter: { name: "Filter Freq", value: "1.20 kHz", owner: "Operator" }, view: "Session", detail: "Device", browser: false, selectedNotes: 3,
  });
  assert.deepEqual(parseFocus({ focusTrackName: "Pad", focusTrackColor: "orange", focusTrackKind: "spaceship", focusView: "Mixer", focusSelectedNotes: -1 }), { track: { name: "Pad" } });
  assert.equal(parseFocus({ selectedTrackRef: "1:track:0" }), null, "an older bridge without focus fields reports nothing");
});

test("the feed reports focus only when it changes, survives failed reads, and stops cleanly", async () => {
  const rows = [
    { focusTrackName: "Bass" }, { focusTrackName: "Bass" }, "fail", { focusTrackName: "Keys", focusDetail: "Clip", focusClipName: "Verse" },
  ];
  let reads = 0;
  const seen: (LiveFocus | null)[] = [];
  const feed = startFocusFeed({
    intervalMs: 5,
    onFocus: (focus) => seen.push(focus),
    read: async () => {
      const row = rows[Math.min(reads++, rows.length - 1)];
      if (row === "fail") throw new Error("bridge busy");
      return { content: [{ type: "text", text: JSON.stringify({ items: [row] }) }] } as CallToolResult;
    },
  });
  await delay(60);
  feed.stop();
  feed.stop();
  assert.deepEqual(seen, [{ track: { name: "Bass" } }, { track: { name: "Keys" }, clip: "Verse", detail: "Clip" }, null]);
  const count = reads;
  await delay(20);
  assert.equal(reads, count, "no reads after stopping");
});
