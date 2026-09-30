/** Synthetic sounds as WAV files, for tests that listen: saws, noise, patterns, silence. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RATE = 48000;
export const folder = mkdtempSync(join(tmpdir(), "kumi-audio-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

/** A 16-bit stereo WAV of one signal. */
export function wav(name: string, signal: Float32Array): string {
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
export function saw(seconds: number, hz: number, cutoff = 20000): Float32Array {
  const out = new Float32Array(length(seconds));
  for (let index = 0; index < out.length; index++) { const phase = (index * hz / RATE) % 1; out[index] = 0.3 * (2 * phase - 1); }
  const a = Math.exp(-2 * Math.PI * cutoff / RATE);
  for (let pass = 0; pass < 2; pass++) { let state = 0; for (let index = 0; index < out.length; index++) { state = (1 - a) * out[index]! + a * state; out[index] = state; } }
  return out;
}
export function noise(seconds: number, seed = 7): Float32Array {
  const out = new Float32Array(length(seconds)); let x = seed;
  for (let index = 0; index < out.length; index++) { x = (x * 1103515245 + 12345) % 2147483648; out[index] = 0.3 * (x / 1073741824 - 1); }
  return out;
}
/** Short saw notes every `every` seconds: a part with a rhythm. */
export function pattern(seconds: number, every: number, hz = 110): Float32Array {
  const out = new Float32Array(length(seconds)); const note = saw(0.08, hz);
  for (let at = 0; at + note.length < out.length; at += length(every)) for (let index = 0; index < note.length; index++) out[at + index] = note[index]! * Math.exp(-index / (0.02 * RATE));
  return out;
}
export function silence(seconds: number): Float32Array { return new Float32Array(length(seconds)); }
