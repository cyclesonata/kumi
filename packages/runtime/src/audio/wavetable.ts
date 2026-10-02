/**
 * Wavetables Kumi makes for wavetable synths (Serum, Vital, Pigments and others): frames of one cycle
 * each, 2048 samples long, written as a mono 32-bit WAV with Serum's "clm " chunk (which the others read
 * or ignore). A frame is made from harmonics or a classic shape; frames between keyframes morph by their
 * harmonics, so the table sweeps smoothly; or the frames are single cycles cut from a sound.
 */
import { writeFile } from "node:fs/promises";
import { openAudio } from "./decode.js";

export const FRAME = 2048;
export const MAX_FRAMES = 256;

export type Shape = "sine" | "saw" | "square" | "triangle" | "pulse";
/** A keyframe: harmonic amplitudes (the 1st is the fundamental), or a shape (with a pulse's width, 0–1). */
export interface Keyframe { harmonics?: number[]; shape?: Shape; width?: number }
export interface WavetableSpec {
  keyframes?: Keyframe[];
  /** Frames in all (morphing between keyframes); the keyframes' count when left out. */
  count?: number;
  /** Single cycles cut evenly from a sound instead: its file, and the stretch of it (seconds). */
  fromAudio?: { file: string; start?: number; seconds?: number };
}

/** The harmonics most frames hold: up to half the frame, so nothing folds back. */
const MAX_HARMONIC = FRAME / 2 - 1;

/** A shape's harmonic amplitudes (signed, so a triangle's alternate). */
export function shapeHarmonics(shape: Shape, width = 0.5, count = 256): number[] {
  const out: number[] = [];
  for (let n = 1; n <= Math.min(count, MAX_HARMONIC); n++) {
    switch (shape) {
      case "sine": out.push(n === 1 ? 1 : 0); break;
      case "saw": out.push(1 / n); break;
      case "square": out.push(n % 2 ? 1 / n : 0); break;
      case "triangle": out.push(n % 2 ? ((n - 1) / 2 % 2 ? -1 : 1) / (n * n) : 0); break;
      case "pulse": out.push((2 / (n * Math.PI)) * Math.sin(n * Math.PI * Math.min(0.99, Math.max(0.01, width)))); break;
    }
  }
  return out;
}

/** One cycle from harmonic amplitudes (sines, from phase 0). */
export function synthesize(harmonics: readonly number[]): Float32Array {
  const frame = new Float32Array(FRAME);
  harmonics.slice(0, MAX_HARMONIC).forEach((amplitude, index) => {
    if (!amplitude) return;
    const n = index + 1;
    for (let sample = 0; sample < FRAME; sample++) frame[sample]! += amplitude * Math.sin((2 * Math.PI * n * sample) / FRAME);
  });
  return frame;
}

const harmonicsOf = (keyframe: Keyframe) => keyframe.harmonics?.length ? keyframe.harmonics : shapeHarmonics(keyframe.shape ?? "sine", keyframe.width);

/** The frames of a table from its keyframes, morphing by harmonics between them; normalized together, so the sweep keeps its levels. */
export function framesFromKeyframes(keyframes: readonly Keyframe[], count = keyframes.length): Float32Array[] {
  if (!keyframes.length) throw new Error("A wavetable needs at least one keyframe.");
  const total = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const spectra = keyframes.map(harmonicsOf);
  const frames: Float32Array[] = [];
  for (let index = 0; index < total; index++) {
    // Where this frame sits between keyframes.
    const at = total === 1 || spectra.length === 1 ? 0 : (index / (total - 1)) * (spectra.length - 1);
    const left = Math.floor(at); const right = Math.min(spectra.length - 1, left + 1); const mix = at - left;
    const length = Math.max(spectra[left]!.length, spectra[right]!.length);
    const harmonics = Array.from({ length }, (_, n) => (spectra[left]![n] ?? 0) * (1 - mix) + (spectra[right]![n] ?? 0) * mix);
    frames.push(synthesize(harmonics));
  }
  return normalize(frames);
}

/** Single cycles cut evenly from a sound: its pitch found, each cycle stretched to a frame and started where it rises through zero. */
export async function framesFromAudio(file: string, count: number, span: { start?: number; seconds?: number } = {}): Promise<Float32Array[]> {
  const source = await openAudio(file);
  let mono: Float32Array;
  try {
    const from = Math.max(0, Math.floor((span.start ?? 0) * source.sampleRate));
    const length = Math.min(source.frames - from, Math.floor((span.seconds ?? 8) * source.sampleRate));
    if (length < 256) throw new Error("That part of the sound is too short to cut cycles from.");
    source.seek(from);
    mono = new Float32Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = await source.read(Math.min(65_536, length - filled));
      if (!chunk?.[0]?.length) break;
      for (let index = 0; index < chunk[0].length; index++) mono[filled + index] = chunk.reduce((sum, channel) => sum + channel[index]!, 0) / chunk.length;
      filled += chunk[0].length;
    }
    mono = mono.subarray(0, filled);
  } finally { await source.close(); }
  const period = periodOf(mono, source.sampleRate);
  if (!period) throw new Error("Kumi couldn't hear a steady pitch in that sound to cut single cycles from; use a held note.");
  const total = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const frames: Float32Array[] = [];
  const usable = mono.length - Math.ceil(period) * 2;
  for (let index = 0; index < total; index++) {
    let at = Math.floor((usable * index) / Math.max(1, total - 1 || 1));
    // Start each cycle where it rises through zero, so frames line up and the table doesn't click.
    for (let look = 0; look < period && at + 1 < mono.length; look++, at++) if (mono[at]! <= 0 && mono[at + 1]! > 0) break;
    const frame = new Float32Array(FRAME);
    for (let sample = 0; sample < FRAME; sample++) {
      const position = at + (sample * period) / FRAME;
      const whole = Math.floor(position); const fraction = position - whole;
      frame[sample] = (mono[whole] ?? 0) * (1 - fraction) + (mono[whole + 1] ?? 0) * fraction;
    }
    frames.push(frame);
  }
  return normalize(frames);
}

/** A held note's period in samples, by autocorrelation over 30 Hz–2 kHz; undefined without a clear one. */
export function periodOf(signal: Float32Array, sampleRate: number): number | undefined {
  const window = signal.subarray(Math.floor(signal.length / 4), Math.min(signal.length, Math.floor(signal.length / 4) + 8192));
  const minLag = Math.floor(sampleRate / 2000); const maxLag = Math.min(window.length - 1, Math.floor(sampleRate / 30));
  let energy = 0; for (const value of window) energy += value * value;
  if (energy < 1e-9) return undefined;
  let best = 0; let bestLag = 0;
  const correlations = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let index = 0; index + lag < window.length; index++) sum += window[index]! * window[index + lag]!;
    correlations[lag] = sum / energy;
    if (correlations[lag]! > best) { best = correlations[lag]!; bestLag = lag; }
  }
  if (best < 0.3 || !bestLag) return undefined;
  // The first lag nearly as strong as the best one is the fundamental (not a multiple of it).
  for (let lag = minLag; lag < bestLag; lag++) if (correlations[lag]! > best * 0.9 && correlations[lag]! >= correlations[lag - 1]! && correlations[lag]! >= correlations[lag + 1]!) { bestLag = lag; break; }
  // A finer peak between samples.
  const a = correlations[bestLag - 1] ?? 0; const b = correlations[bestLag]!; const c = correlations[bestLag + 1] ?? 0;
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return bestLag + (Number.isFinite(shift) && Math.abs(shift) < 1 ? shift : 0);
}

function normalize(frames: Float32Array[]): Float32Array[] {
  let peak = 0;
  for (const frame of frames) for (const value of frame) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) for (const frame of frames) for (let index = 0; index < frame.length; index++) frame[index]! /= peak / 0.99;
  return frames;
}

/** The frames as a mono 32-bit float WAV at 44.1 kHz, with Serum's "clm " chunk saying the frame size. */
export async function writeWavetable(file: string, frames: readonly Float32Array[]): Promise<void> {
  const samples = frames.reduce((sum, frame) => sum + frame.length, 0);
  const data = Buffer.alloc(samples * 4);
  let at = 0;
  for (const frame of frames) for (const value of frame) { data.writeFloatLE(value, at); at += 4; }
  // Serum's marker: "<!>" then the frame size; the flags after it are left at their defaults.
  const marker = Buffer.from(`<!>${FRAME} 00000000 wavetable (Kumi)`, "latin1");
  const clm = Buffer.concat([Buffer.from("clm ", "latin1"), u32(marker.length), marker, Buffer.alloc(marker.length % 2)]);
  const fmt = Buffer.concat([Buffer.from("fmt ", "latin1"), u32(16), u16(3), u16(1), u32(44_100), u32(44_100 * 4), u16(4), u16(32)]);
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), fmt, clm, Buffer.from("data", "latin1"), u32(data.length), data]);
  await writeFile(file, Buffer.concat([Buffer.from("RIFF", "latin1"), u32(body.length), body]));
}
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };

/** A table from a spec: keyframes (morphing to `count` frames) or cycles cut from a sound. */
export async function buildWavetable(spec: WavetableSpec): Promise<Float32Array[]> {
  if (spec.fromAudio) return framesFromAudio(spec.fromAudio.file, spec.count ?? 64, spec.fromAudio);
  return framesFromKeyframes(spec.keyframes ?? [{ shape: "saw" }], spec.count);
}
