import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freeBytes, lowDisk, MB } from "../src/core/disk.js";

test("free space is read for a path's disk, from its nearest folder that exists", async () => {
  const free = await freeBytes(join(tmpdir(), "kumi-not-there", "deeper", "file.wav"));
  assert.ok(typeof free === "number" && free > 0);
});

test("a nearly full disk gets a plain refusal saying what's free and what to do; enough room, or no answer, says nothing", async () => {
  assert.equal(await lowDisk("/x", 500 * MB, "Live records to", async () => 182 * MB),
    "Only 182 MB is free on the disk Live records to, so it would likely fail partway. Free some space (empty the Trash or Recycle Bin, or move old bounces and videos off that disk), then try again.");
  assert.match(String(await lowDisk("/x", 2_000 * MB, "Kumi keeps its programs on", async () => 1_500 * MB)), /^Only 1\.5 GB is free/);
  assert.equal(await lowDisk("/x", 500 * MB, "Live records to", async () => 800 * MB), undefined);
  assert.equal(await lowDisk("/x", 500 * MB, "Live records to", async () => undefined), undefined);
});
