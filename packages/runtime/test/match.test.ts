import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeFile } from "../src/audio/analyze.js";
import { closeness } from "../src/audio/match.js";

const RATE = 48000;
const folder = mkdtempSync(join(tmpdir(), "kumi-match-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

/** A 16-bit stereo WAV of one signal. */
function wav(name: string, signal: Float32Array): string {
  const data = Buffer.alloc(signal.length * 4);
  signal.forEach((value, frame) => { const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767); data.writeInt16LE(sample, frame * 4); data.writeInt16LE(sample, frame * 4 + 2); });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "latin1"); header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  const path = join(folder, name); writeFileSync(path, Buffer.concat([header, data])); return path;
}
const length = (seconds: number) => Math.round(seconds * RATE);
/** A saw at `hz`, its partials rolled off above `cutoff` (a one-pole low-pass, run twice). */
function saw(seconds: number, hz: number, cutoff = 20000): Float32Array {
  const out = new Float32Array(length(seconds));
  for (let index = 0; index < out.length; index++) { const phase = (index * hz / RATE) % 1; out[index] = 0.3 * (2 * phase - 1); }
  const a = Math.exp(-2 * Math.PI * cutoff / RATE);
  for (let pass = 0; pass < 2; pass++) { let state = 0; for (let index = 0; index < out.length; index++) { state = (1 - a) * out[index]! + a * state; out[index] = state; } }
  return out;
}
function noise(seconds: number, seed = 7): Float32Array {
  const out = new Float32Array(length(seconds)); let x = seed;
  for (let index = 0; index < out.length; index++) { x = (x * 1103515245 + 12345) % 2147483648; out[index] = 0.3 * (x / 1073741824 - 1); }
  return out;
}
/** Short saw notes every `every` seconds: a part with a rhythm. */
function pattern(seconds: number, every: number, hz = 110): Float32Array {
  const out = new Float32Array(length(seconds)); const note = saw(0.08, hz);
  for (let at = 0; at + note.length < out.length; at += length(every)) for (let index = 0; index < note.length; index++) out[at + index] = note[index]! * Math.exp(-index / (0.02 * RATE));
  return out;
}

test("the same sound against itself is ~100%; a tone against noise is low; the same tone darkened is in between", async () => {
  const bright = await analyzeFile(wav("bright.wav", saw(3, 110)), { focus: "sound" });
  const again = await analyzeFile(wav("again.wav", saw(3, 110)), { focus: "sound" });
  const dark = await analyzeFile(wav("dark.wav", saw(3, 110, 700)), { focus: "sound" });
  const hiss = await analyzeFile(wav("hiss.wav", noise(3)), { focus: "sound" });
  const self = closeness(bright, again);
  const darker = closeness(dark, bright);
  const unlike = closeness(hiss, bright);
  assert.ok(self.score >= 97, `self ${self.score}`);
  assert.ok(unlike.score <= 45, `noise ${unlike.score}`);
  assert.ok(darker.score > unlike.score + 10 && darker.score < self.score - 10, `darker ${darker.score} between ${unlike.score} and ${self.score}`);
  assert.equal(self.gaps.length, 0, "nothing to change");
  assert.match(darker.gaps.join(" · "), /darker|brighten/, "says which way to go");
  assert.ok(darker.features.every((feature) => feature.similarity >= 0 && feature.similarity <= 100));
});

test("a section is judged on density and rhythm too: the same part is close, one four times as dense less so", async () => {
  const part = await analyzeFile(wav("part.wav", pattern(8, 0.5)), { focus: "mix" });
  const same = await analyzeFile(wav("same.wav", pattern(8, 0.5)), { focus: "mix" });
  const busy = await analyzeFile(wav("busy.wav", pattern(8, 0.125)), { focus: "mix" });
  const close = closeness(same, part, "section");
  const dense = closeness(busy, part, "section");
  assert.equal(close.focus, "section");
  assert.ok(close.score >= 95, `same part ${close.score}`);
  assert.ok(dense.score < close.score - 10, `denser ${dense.score}`);
  assert.ok(dense.features.find((feature) => feature.name === "density")!.similarity < 60);
  assert.match(dense.gaps.join(" · "), /too dense/);
});
