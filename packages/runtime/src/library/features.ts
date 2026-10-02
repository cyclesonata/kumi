/**
 * A sound measured for the library: its length and level, brightness, noise, envelope, rhythm,
 * pitch and key, and a compact vector for "sounds like": the timbre's MFCC-style means and spread,
 * with spectral and envelope stats. Cheap enough for tens of thousands of files: up to 30 seconds
 * of each is read, one FFT size, no spectrogram.
 */
import { estimateKey, estimateTempo, trackPitch } from "../audio/analyze.js";
import { openAudio } from "../audio/decode.js";
import { dbAmplitude, fft, kWeighting, percentile, window } from "../audio/dsp.js";

/** Changes when the measurements do: sounds measured differently are measured again. */
export const FEATURES_VERSION = 1;
/** The vector's parts, in order, by the group a match is explained with. */
export const VECTOR_GROUPS: readonly { group: "tone" | "movement" | "brightness" | "noise" | "weight" | "envelope" | "length" | "rhythm" | "width"; count: number; weight: number }[] = [
  { group: "tone", count: 12, weight: 2 }, // MFCC means, c1–c12
  { group: "movement", count: 13, weight: 0.4 }, // their spread over time, c0–c12
  { group: "brightness", count: 3, weight: 1 }, // centroid, its spread, rolloff
  { group: "noise", count: 3, weight: 1 }, // flatness, flux, zero crossings
  { group: "weight", count: 3, weight: 1 }, // low, mid and high shares
  { group: "envelope", count: 3, weight: 1.2 }, // attack, decay, crest
  { group: "length", count: 1, weight: 0.8 },
  { group: "rhythm", count: 1, weight: 0.8 },
  { group: "width", count: 1, weight: 0.3 },
];
export const VECTOR_LENGTH = VECTOR_GROUPS.reduce((sum, part) => sum + part.count, 0);

export interface SoundFeatures {
  /** The whole file's length. */
  seconds: number;
  /** How long it sounds (to 40 dB below its peak), within what was read. */
  audibleSeconds: number;
  /** The K-weighted level of its audible part, about LUFS. */
  loudnessDb: number;
  peakDb: number;
  crestDb: number;
  centroidHz: number;
  rolloffHz: number;
  /** 0 (a pure tone) to 1 (white noise). */
  flatness: number;
  attackMs: number;
  /** From the peak until 20 dB down. */
  decayMs: number;
  onsetsPerSecond: number;
  /** 0 (mono) to 1 (all side). */
  width: number;
  lowShare: number; midShare: number; highShare: number;
  pitch?: { hz: number; confidence: number };
  key?: { name: string; confidence: number };
  rhythm?: { bpm: number; confidence: number };
  vector: number[];
}

const MAX_SECONDS = 30;
const MEL_BANDS = 40;
const COEFFICIENTS = 13;

const filterbanks = new Map<string, { from: Int32Array; to: Int32Array; weights: Float64Array[] }>();
/** Triangular mel filters over the FFT's bins, 30 Hz to 16 kHz (or Nyquist). */
function melFilters(size: number, sampleRate: number) {
  const key = `${size}:${sampleRate}`;
  const found = filterbanks.get(key);
  if (found) return found;
  const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700); const hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const low = mel(30); const high = mel(Math.min(16_000, sampleRate / 2 - 1));
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, index) => hz(low + (high - low) * index / (MEL_BANDS + 1)) * size / sampleRate);
  const from = new Int32Array(MEL_BANDS); const to = new Int32Array(MEL_BANDS); const weights: Float64Array[] = [];
  for (let band = 0; band < MEL_BANDS; band++) {
    const left = edges[band]!; const center = edges[band + 1]!; const right = edges[band + 2]!;
    from[band] = Math.max(1, Math.floor(left)); to[band] = Math.min(size / 2, Math.ceil(right));
    const row = new Float64Array(to[band]! - from[band]! + 1);
    for (let bin = from[band]!; bin <= to[band]!; bin++) row[bin - from[band]!] = bin < center ? Math.max(0, (bin - left) / Math.max(1e-9, center - left)) : Math.max(0, (right - bin) / Math.max(1e-9, right - center));
    weights.push(row);
  }
  const bank = { from, to, weights };
  filterbanks.set(key, bank);
  return bank;
}

const cosines = (() => {
  const table: Float64Array[] = [];
  for (let k = 0; k < COEFFICIENTS; k++) table.push(Float64Array.from({ length: MEL_BANDS }, (_, n) => Math.cos(Math.PI * k * (n + 0.5) / MEL_BANDS)));
  return table;
})();

/** Measure audio already in memory: one Float32Array per channel. `seconds` is the whole file's length. */
export function measureSamples(channels: readonly Float32Array[], sampleRate: number, seconds: number): SoundFeatures {
  const left = channels[0]!; const right = channels[1] ?? left;
  const length = left.length;
  const mono = new Float32Array(length);
  let peak = 0; let squares = 0; let sides = 0; let crossings = 0;
  for (let index = 0; index < length; index++) {
    const l = left[index]!; const r = right[index]!;
    const mid = (l + r) / 2; const side = (l - r) / 2;
    mono[index] = mid; squares += mid * mid; sides += side * side;
    const magnitude = Math.max(Math.abs(l), Math.abs(r));
    if (magnitude > peak) peak = magnitude;
    if (index && (mid >= 0) !== (mono[index - 1]! >= 0)) crossings++;
  }
  // The envelope, every 5 ms: where it starts, peaks, falls 20 dB, and ends (40 dB down).
  const step = Math.max(1, Math.round(sampleRate * 0.005));
  const levels: number[] = [];
  for (let from = 0; from < length; from += step) {
    let sum = 0; const to = Math.min(length, from + step);
    for (let index = from; index < to; index++) sum += mono[index]! * mono[index]!;
    levels.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const top = Math.max(1e-9, ...levels);
  const peakAt = levels.indexOf(top);
  const start = Math.max(0, levels.findIndex((level) => level > top * 0.01));
  const attackEnd = levels.findIndex((level, index) => index >= start && level >= top * 0.9);
  const fallen = levels.findIndex((level, index) => index > peakAt && level < top * 0.1);
  let end = levels.length - 1; while (end > start && levels[end]! < top * 0.01) end--;
  const ms = (steps: number) => steps * step / sampleRate * 1000;
  const attackMs = ms(Math.max(0, attackEnd - start));
  const decayMs = ms(Math.max(1, (fallen < 0 ? end : fallen) - peakAt));
  const audibleSeconds = Math.max(step / sampleRate, (end - start + 1) * step / sampleRate);
  // Level: K-weighted, over 100 ms blocks no more than 20 dB under the loudest (an approximate LUFS).
  const [shelf, highPass] = kWeighting(sampleRate);
  const block = Math.max(1, Math.round(sampleRate / 10)); const blocks: number[] = []; let blockSum = 0; let filled = 0;
  for (let index = 0; index < length; index++) {
    const weighted = highPass.process(shelf.process(mono[index]!));
    blockSum += weighted * weighted;
    if (++filled === block || index === length - 1) { blocks.push(blockSum / filled); blockSum = 0; filled = 0; }
  }
  const loudest = Math.max(1e-20, ...blocks);
  const counted = blocks.filter((value) => value > loudest / 100);
  const loudnessDb = -0.691 + 10 * Math.log10(Math.max(1e-20, counted.reduce((sum, value) => sum + value, 0) / Math.max(1, counted.length)));
  // The spectrum, frame by frame: brightness, noise, flux, weight, timbre (mel cepstrum) and pitch classes.
  const size = sampleRate >= 32_000 ? 2048 : 1024; const hop = size / 4;
  const hann = window(size); const bank = melFilters(size, sampleRate);
  const re = new Float64Array(size); const im = new Float64Array(size); const previous = new Float64Array(size / 2 + 1); const power = new Float64Array(size / 2 + 1);
  const binHz = sampleRate / size;
  const flatFrom = Math.max(1, Math.round(50 / binHz)); const flatTo = Math.min(size / 2, Math.round(16_000 / binHz));
  const chroma = new Float64Array(12);
  const frames: { energy: number; centroid: number; rolloff: number; flatness: number; flux: number; mfcc: Float64Array }[] = [];
  let low = 0; let mid = 0; let high = 0;
  const flux: number[] = [];
  for (let from = 0; from + size <= Math.max(size, length); from += hop) {
    let energy = 0;
    for (let index = 0; index < size; index++) { const value = mono[from + index] ?? 0; re[index] = value * hann[index]!; im[index] = 0; energy += value * value; }
    fft(re, im);
    let total = 0; let weighted = 0; let logSum = 0; let flatSum = 0; let rise = 0; let magnitudes = 0;
    for (let bin = 1; bin <= size / 2; bin++) {
      const value = re[bin]! * re[bin]! + im[bin]! * im[bin]!;
      power[bin] = value; total += value; weighted += value * bin * binHz;
      const magnitude = Math.sqrt(value);
      rise += Math.max(0, magnitude - previous[bin]!); magnitudes += magnitude; previous[bin] = magnitude;
      if (bin >= flatFrom && bin <= flatTo) { logSum += Math.log(value + 1e-20); flatSum += value; }
      const hz = bin * binHz;
      if (hz < 250) low += value; else if (hz < 4000) mid += value; else high += value;
      if (hz >= 55 && hz <= 4500) chroma[((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12]! += magnitude;
    }
    flux.push(rise / Math.max(1e-12, magnitudes));
    if (total < 1e-14) { frames.push({ energy: 0, centroid: 0, rolloff: 0, flatness: 0, flux: 0, mfcc: new Float64Array(COEFFICIENTS) }); continue; }
    let cumulative = 0; let rolloffBin = size / 2;
    for (let bin = 1; bin <= size / 2; bin++) { cumulative += power[bin]!; if (cumulative >= total * 0.85) { rolloffBin = bin; break; } }
    const bins = flatTo - flatFrom + 1;
    const flatness = Math.exp(logSum / bins) / Math.max(1e-30, flatSum / bins);
    const bands = new Float64Array(MEL_BANDS);
    for (let band = 0; band < MEL_BANDS; band++) {
      let sum = 0; const row = bank.weights[band]!; const first = bank.from[band]!;
      for (let bin = first; bin <= bank.to[band]!; bin++) sum += power[bin]! * row[bin - first]!;
      bands[band] = Math.log10(sum + 1e-12);
    }
    const mfcc = new Float64Array(COEFFICIENTS);
    for (let k = 0; k < COEFFICIENTS; k++) { let sum = 0; const row = cosines[k]!; for (let n = 0; n < MEL_BANDS; n++) sum += bands[n]! * row[n]!; mfcc[k] = sum / MEL_BANDS; }
    frames.push({ energy, centroid: weighted / total, rolloff: rolloffBin * binHz, flatness, flux: flux.at(-1)!, mfcc });
  }
  // Only the frames that sound (within 50 dB of the loudest) describe the sound.
  const loudestFrame = Math.max(1e-20, ...frames.map((frame) => frame.energy));
  const heard = frames.filter((frame) => frame.energy > loudestFrame * 1e-5);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const spread = (values: number[]) => { const average = mean(values); return Math.sqrt(mean(values.map((value) => (value - average) ** 2))); };
  const coefficient = (k: number) => heard.map((frame) => frame.mfcc[k]!);
  const centroids = heard.map((frame) => Math.log2(Math.max(20, frame.centroid)));
  const centroidHz = 2 ** mean(centroids);
  const rolloffHz = 2 ** mean(heard.map((frame) => Math.log2(Math.max(20, frame.rolloff))));
  const flatness = mean(heard.map((frame) => frame.flatness));
  const fluxMean = mean(heard.map((frame) => frame.flux));
  const shares = low + mid + high;
  const lowShare = low / Math.max(1e-30, shares); const midShare = mid / Math.max(1e-30, shares); const highShare = high / Math.max(1e-30, shares);
  // Onsets: peaks of the flux over a threshold, at least 50 ms apart.
  const rate = sampleRate / hop;
  const threshold = percentile(flux, 0.5) + 1.5 * spread(flux);
  let onsets = 0; let last = -Infinity;
  for (let index = 1; index < flux.length - 1; index++) {
    const value = flux[index]!;
    if (value > threshold && value >= flux[index - 1]! && value >= flux[index + 1]! && (index - last) / rate >= 0.05) { onsets++; last = index; }
  }
  const analyzedSeconds = length / sampleRate;
  const onsetsPerSecond = onsets / Math.max(0.25, analyzedSeconds);
  const rhythm = analyzedSeconds >= 3 ? estimateTempo(Float64Array.from(flux), rate) ?? undefined : undefined;
  // Pitch: a second of the sound from where it starts.
  const pitchFrom = start * step;
  const tracked = trackPitch(mono.subarray(pitchFrom, Math.min(length, pitchFrom + sampleRate + 4096)), sampleRate);
  const voiced = tracked.filter((frame) => frame.confidence > 0.6 && frame.hz > 25);
  const pitch = voiced.length >= Math.max(2, tracked.length * 0.3) ? { hz: Math.round(percentile(voiced.map((frame) => frame.hz), 0.5) * 10) / 10, confidence: Math.round(voiced.length / tracked.length * 100) / 100 } : undefined;
  const key = estimateKey(chroma) ?? undefined;
  const rms = Math.sqrt(squares / Math.max(1, length));
  const crestDb = dbAmplitude(peak) - dbAmplitude(rms);
  const width = sides / Math.max(1e-30, squares + sides);
  const vector = [
    ...Array.from({ length: 12 }, (_, index) => mean(coefficient(index + 1))),
    ...Array.from({ length: 13 }, (_, index) => spread(coefficient(index))),
    Math.log2(centroidHz), spread(centroids), Math.log2(rolloffHz),
    Math.log10(Math.max(1e-4, flatness)), fluxMean, Math.log10(Math.max(1e-4, crossings / Math.max(1, length))),
    lowShare, midShare, highShare,
    Math.log10(attackMs + 1), Math.log10(decayMs + 1), crestDb / 10,
    Math.log10(audibleSeconds + 0.01),
    Math.log1p(onsetsPerSecond),
    width,
  ].map((value) => (Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0));
  const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
  return {
    seconds: round(seconds, 3), audibleSeconds: round(audibleSeconds, 3), loudnessDb: round(loudnessDb), peakDb: round(dbAmplitude(peak)), crestDb: round(crestDb),
    centroidHz: Math.round(centroidHz), rolloffHz: Math.round(rolloffHz), flatness: round(flatness, 3), attackMs: Math.round(attackMs), decayMs: Math.round(decayMs),
    onsetsPerSecond: round(onsetsPerSecond, 2), width: round(width, 2), lowShare: round(lowShare, 3), midShare: round(midShare, 3), highShare: round(highShare, 3),
    ...(pitch ? { pitch } : {}), ...(key ? { key } : {}), ...(rhythm ? { rhythm } : {}), vector,
  };
}

/** Measure a file: up to 30 seconds of it, from `start` seconds in. Other formats than WAV and AIFF are converted first. */
export async function measureSound(path: string, options: { signal?: AbortSignal; start?: number; seconds?: number } = {}): Promise<SoundFeatures> {
  const source = await openAudio(path, options.signal ? { signal: options.signal } : {});
  try {
    const total = source.frames / source.sampleRate;
    const startFrame = Math.max(0, Math.min(source.frames, Math.floor((options.start ?? 0) * source.sampleRate)));
    const frames = Math.min(source.frames - startFrame, Math.floor(Math.min(options.seconds ?? MAX_SECONDS, MAX_SECONDS) * source.sampleRate));
    if (frames < source.sampleRate * 0.005) throw new Error("There's no audio in that part of the file.");
    source.seek(startFrame);
    const channels = Array.from({ length: Math.min(2, source.channels) }, () => new Float32Array(frames));
    let done = 0;
    while (done < frames) {
      options.signal?.throwIfAborted();
      const block = await source.read(Math.min(65_536, frames - done));
      if (!block) break;
      for (let channel = 0; channel < channels.length; channel++) channels[channel]!.set(block[channel]!.subarray(0, Math.min(block[channel]!.length, frames - done)), done);
      done += block[0]!.length;
    }
    return measureSamples(channels.map((channel) => channel.subarray(0, done)), source.sampleRate, total);
  } finally { await source.close(); }
}
