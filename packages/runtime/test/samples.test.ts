import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { audioSeconds, findSamples, folderPath, userLibrary } from "../src/integrations/ableton/samples.js";

/** A WAV header and `seconds` of silence: 44.1 kHz, 16-bit stereo. */
function wav(seconds: number): Buffer {
  const data = Math.round(44_100 * seconds) * 4;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data, 4); header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44_100, 24); header.writeUInt32LE(44_100 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}
/** An AIFF header for `frames` frames at 44.1 kHz. */
function aiff(frames: number): Buffer {
  const comm = Buffer.alloc(26);
  comm.write("COMM", 0, "latin1"); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(1, 8); comm.writeUInt32BE(frames, 10); comm.writeUInt16BE(16, 14);
  // 44100 as an 80-bit extended float.
  Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]).copy(comm, 16);
  const form = Buffer.alloc(12); form.write("FORM", 0, "latin1"); form.writeUInt32BE(4 + comm.length, 4); form.write("AIFF", 8, "latin1");
  return Buffer.concat([form, comm]);
}

function library() {
  const root = mkdtempSync(join(tmpdir(), "kumi-samples-"));
  const put = (path: string, bytes: Buffer | string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), bytes); };
  put("Drums/Kicks/Kick 808 Long.wav", wav(1.5));
  put("Drums/Kicks/Kick Punchy.wav", wav(0.25));
  put("Drums/Snares/Snare Crack.aif", aiff(22_050));
  put("Drums/Hats/Closed Hat.wav", wav(0.1));
  put("Drums/Hats/notes.txt", "not audio");
  put("Drums/.hidden/Kick Secret.wav", wav(0.2));
  put("Ableton Folder Info/Previews/Kick Preset.adv.ogg", Buffer.from("OggS"));
  put("Loops/90 BPM Break.wav", wav(2.667));
  // A link back up the tree must not send the search round in circles.
  symlinkSync(root, join(root, "Drums", "loop"), process.platform === "win32" ? "junction" : "dir");
  return root;
}

test("samples are found by words in their names and folders, best matches first, with their lengths", async () => {
  const root = library();
  try {
    const kicks = await findSamples({ folders: [root], words: ["KICK"], limit: 10 });
    assert.deepEqual(kicks.samples.map((sample) => sample.name), ["Kick 808 Long", "Kick Punchy"], "case doesn't matter; hidden folders, Live's preview folders and links are skipped");
    assert.equal(kicks.samples[0]!.seconds, 1.5); assert.equal(kicks.samples[1]!.seconds, 0.25);
    assert.equal(kicks.samples[0]!.folder, root); assert.ok(kicks.samples[0]!.bytes > 0);
    const snares = await findSamples({ folders: [root], words: ["drums", "snare"], limit: 10 });
    assert.deepEqual(snares.samples.map((sample) => [sample.name, sample.seconds]), [["Snare Crack", 0.5]], "every word must appear, in a folder or the name; AIFF lengths too");
    const everything = await findSamples({ folders: [root], limit: 50 });
    assert.equal(everything.matched, 5, "only audio files count");
    assert.equal(everything.scanned, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("random picks come from the matches; missing folders are reported", async () => {
  const root = library();
  try {
    const picked = await findSamples({ folders: [root], words: ["drums"], limit: 2, random: true });
    assert.equal(picked.samples.length, 2);
    for (const sample of picked.samples) assert.match(sample.path, /Drums/);
    const gone = join(root, "Nowhere");
    const missing = await findSamples({ folders: [gone, root], words: ["break"], limit: 5 });
    assert.deepEqual(missing.missing, [gone]); assert.deepEqual(missing.samples.map((sample) => sample.name), ["90 BPM Break"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("folders are full paths or ~/…; the User Library is where Live keeps it", () => {
  assert.equal(folderPath("~/Samples", "/home/me"), join("/home/me", "Samples"));
  assert.equal(folderPath("~", "/home/me"), "/home/me");
  assert.equal(folderPath("Samples", "/home/me"), undefined, "a relative folder isn't a place Kumi can find");
  assert.equal(userLibrary("darwin", "/Users/me"), join("/Users/me", "Music", "Ableton", "User Library"));
  assert.equal(userLibrary("win32", "C:\\Users\\me"), join("C:\\Users\\me", "Documents", "Ableton", "User Library"));
});

test("lengths come only from headers that make sense", () => {
  assert.equal(audioSeconds(wav(0.5).subarray(0, 44), 44 + 88_200), 0.5);
  assert.equal(audioSeconds(Buffer.from("ID3 not a wav"), 100), undefined);
  assert.equal(audioSeconds(Buffer.alloc(0), 0), undefined);
});
