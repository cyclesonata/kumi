/**
 * A song's form, heard: where its sections change, how much energy and how busy each one is, which ones
 * are alike, all in bars, so an arrangement can mirror a reference's form. Each bar gets what's played
 * (chroma) and how it sounds (an MFCC-like timbre, its level, its low end); a bar-by-bar self-similarity
 * matrix shows the sections as blocks, and a checkerboard kernel along its diagonal (novelty) finds their
 * edges, snapped to four-bar phrases where they're near one.
 */
import { AudioError, openAudio } from "./decode.js";
import { Biquad, clock, db, fft, percentile, round, window } from "./dsp.js";

export const FORM_VERSION = 1;

export interface FormSection {
  /** Where it starts and ends in the file ("0:31"), its first bar (1 is the first) and its length in bars. */
  from: string; to: string; bar: number; bars: number;
  /** Its level against the loudest section: 1 is as loud, 0 is 18 dB or more below. */
  energy: number; level: "low" | "mid" | "high";
  /** Hits per bar against the song's usual: sparse, steady or busy. */
  density: "sparse" | "steady" | "busy";
  /** Whether its low end (kick, bass) is full or thin, against the fullest section. */
  low: "full" | "thin";
  /** Sections alike share a letter: A, B, A again. */
  like: string;
  /** What it does in the form: intro, main, build, peak, break or outro. */
  role: "intro" | "main" | "build" | "peak" | "break" | "outro";
}
export interface Form {
  kumiForm: typeof FORM_VERSION;
  file: string; seconds: number;
  /** The tempo bars are counted at: the file's own, or the Set's when the file doesn't show one. */
  tempo: { bpm: number; from: "file" | "set" };
  beatsPerBar: number; bars: number;
  sections: FormSection[];
  /** "intro 8 · main 16 · peak 16 · break 8 · peak 16 · outro 8" */
  summary: string;
  /** How long the same bars run at the Set's tempo. */
  atSetTempo?: string;
}

export interface FormOptions { /** The Set's tempo: the file's tempo is read in its octave (not half or double). */ tempo?: number; beatsPerBar?: number; signal?: AbortSignal }

/** The longest stretch heard; a form needs a whole song, not more. */
const MAX_SECONDS = 15 * 60;
const MEL_BANDS = 24;
const TIMBRE = 12;

/** The form of the song in a file. */
export async function hearForm(path: string, options: FormOptions = {}): Promise<Form> {
  const source = await openAudio(path, options.signal ? { signal: options.signal } : {});
  try {
    const { sampleRate } = source;
    if (sampleRate < 8000 || sampleRate > 384000) throw new AudioError(`A sample rate of ${sampleRate} Hz isn't one Kumi can analyze.`);
    const frames = Math.min(source.frames, Math.floor(MAX_SECONDS * sampleRate));
    const meter = new FormMeter(sampleRate);
    for (let done = 0; done < frames;) {
      options.signal?.throwIfAborted();
      const block = await source.read(Math.min(65536, frames - done));
      if (!block) break;
      meter.push(block);
      done += block[0]!.length;
      // Other work (a redraw, a keypress) gets its turn between blocks.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return meter.form(path.split(/[\\/]/).at(-1) ?? path, source.frames / sampleRate, options);
  } finally { await source.close(); }
}

/** Mel bands over FFT bins: a triangle each, from 40 Hz to 16 kHz (or Nyquist). */
function melBank(sampleRate: number, size: number): { from: number; weights: Float64Array }[] {
  const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700); const hz = (value: number) => 700 * (10 ** (value / 2595) - 1);
  const low = mel(40); const high = mel(Math.min(16000, sampleRate / 2 - 1));
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, index) => hz(low + (high - low) * index / (MEL_BANDS + 1)) * size / sampleRate);
  return Array.from({ length: MEL_BANDS }, (_, band) => {
    const [left, center, right] = [edges[band]!, edges[band + 1]!, edges[band + 2]!];
    const from = Math.max(1, Math.floor(left)); const to = Math.min(size / 2, Math.ceil(right));
    const weights = new Float64Array(Math.max(0, to - from + 1));
    for (let bin = from; bin <= to; bin++) weights[bin - from] = bin < center ? Math.max(0, (bin - left) / Math.max(1e-9, center - left)) : Math.max(0, (right - bin) / Math.max(1e-9, right - center));
    return { from, weights };
  });
}

class FormMeter {
  private readonly size: number; private readonly hop: number;
  private readonly ring: Float64Array; private filled = 0;
  private readonly re: Float64Array; private readonly im: Float64Array;
  private readonly mels: { from: number; weights: Float64Array }[];
  private readonly chromaOf: Int8Array; private readonly lowBins: number;
  /** Per spectrum frame: chroma, timbre, level (dB) and the low end's share. */
  private readonly chroma: Float64Array[] = []; private readonly timbre: Float64Array[] = []; private readonly level: number[] = []; private readonly lowShare: number[] = [];
  // Onsets, for the tempo and how busy a bar is: energy in three bands per 512 samples.
  private readonly onsetFilters: { low: Biquad; high: Biquad };
  private onsetEnergy = [0, 0, 0]; private onsetCount = 0; private readonly onsetFrames: number[][] = [];

  constructor(private readonly sampleRate: number) {
    this.size = sampleRate > 50000 ? 8192 : 4096; this.hop = this.size / 2;
    this.ring = new Float64Array(this.size); this.re = new Float64Array(this.size); this.im = new Float64Array(this.size);
    this.mels = melBank(sampleRate, this.size);
    this.chromaOf = new Int8Array(this.size / 2 + 1).fill(-1);
    for (let bin = 1; bin <= this.size / 2; bin++) { const hz = bin * sampleRate / this.size; if (hz >= 55 && hz <= 4500) this.chromaOf[bin] = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12; }
    this.lowBins = Math.round(150 * this.size / sampleRate);
    const k = (hz: number) => Math.tan(Math.PI * hz / sampleRate);
    const lowK = k(150); const lowNorm = 1 / (1 + lowK * Math.SQRT2 + lowK * lowK);
    const highK = k(2500); const highNorm = 1 / (1 + highK * Math.SQRT2 + highK * highK);
    this.onsetFilters = {
      low: new Biquad(lowK * lowK * lowNorm, 2 * lowK * lowK * lowNorm, lowK * lowK * lowNorm, 2 * (lowK * lowK - 1) * lowNorm, (1 - lowK * Math.SQRT2 + lowK * lowK) * lowNorm),
      high: new Biquad(highNorm, -2 * highNorm, highNorm, 2 * (highK * highK - 1) * highNorm, (1 - highK * Math.SQRT2 + highK * highK) * highNorm),
    };
  }

  push(block: Float32Array[]) {
    const left = block[0]!; const right = block[1] ?? left;
    for (let index = 0; index < left.length; index++) {
      const mono = (left[index]! + right[index]!) / 2;
      this.ring[this.filled % this.size] = mono; this.filled++;
      // A spectrum every hop, each over the last `size` samples: frame f covers f·hop to f·hop + size.
      if (this.filled >= this.size && (this.filled - this.size) % this.hop === 0) this.spectrum();
      const low = this.onsetFilters.low.process(mono); const high = this.onsetFilters.high.process(mono);
      this.onsetEnergy[0]! += low * low; this.onsetEnergy[1]! += mono * mono; this.onsetEnergy[2]! += high * high;
      if (++this.onsetCount === 512) { this.onsetFrames.push(this.onsetEnergy); this.onsetEnergy = [0, 0, 0]; this.onsetCount = 0; }
    }
  }

  private spectrum() {
    const hann = window(this.size);
    const start = this.filled % this.size;
    for (let index = 0; index < this.size; index++) { this.re[index] = this.ring[(start + index) % this.size]! * hann[index]!; this.im[index] = 0; }
    fft(this.re, this.im);
    const chroma = new Float64Array(12); let total = 0; let low = 0;
    const power = new Float64Array(this.size / 2 + 1);
    for (let bin = 1; bin <= this.size / 2; bin++) {
      const value = this.re[bin]! ** 2 + this.im[bin]! ** 2; power[bin] = value; total += value;
      if (bin <= this.lowBins) low += value;
      const pitch = this.chromaOf[bin]!; if (pitch >= 0) chroma[pitch]! += Math.sqrt(value);
    }
    const bands = this.mels.map(({ from, weights }) => { let sum = 0; for (let at = 0; at < weights.length; at++) sum += weights[at]! * (power[from + at] ?? 0); return Math.log10(1e-12 + sum); });
    // A DCT of the log mel bands, without its first coefficient (the level, kept on its own): the sound's colour.
    const timbre = new Float64Array(TIMBRE);
    for (let coefficient = 1; coefficient <= TIMBRE; coefficient++) { let sum = 0; for (let band = 0; band < MEL_BANDS; band++) sum += bands[band]! * Math.cos(Math.PI * coefficient * (band + 0.5) / MEL_BANDS); timbre[coefficient - 1] = sum; }
    this.chroma.push(chroma); this.timbre.push(timbre); this.level.push(db(total)); this.lowShare.push(total > 1e-20 ? low / total : 0);
  }

  form(file: string, seconds: number, options: FormOptions): Form {
    const beatsPerBar = options.beatsPerBar ?? 4;
    const onsets = onsetStrength(this.onsetFrames); const onsetRate = this.sampleRate / 512;
    const found = estimateTempo(onsets, onsetRate, options.tempo);
    const bpm = found ?? options.tempo ?? 120;
    const tempo = { bpm: round(bpm, 1), from: found ? "file" as const : "set" as const };
    const frameSeconds = this.hop / this.sampleRate;
    // The bars start where the music does: the first frame within 40 dB of the loudest.
    let loudest = -200; for (const value of this.level) loudest = Math.max(loudest, value);
    const firstFrame = Math.max(0, this.level.findIndex((value) => value > loudest - 40));
    const barSeconds = beatsPerBar * 60 / bpm;
    const origin = firstFrame * frameSeconds;
    const count = Math.max(0, Math.floor((seconds - origin) / barSeconds + 0.25));
    const empty: Form = { kumiForm: FORM_VERSION, file, seconds: round(seconds, 2), tempo, beatsPerBar, bars: count, sections: [], summary: "too short to have a form" };
    if (count < 4 || !this.level.length) return empty;
    // Each bar: the frames in it, averaged.
    const peaks = onsetPeaks(onsets);
    const bars = Array.from({ length: count }, (_, bar) => {
      const from = Math.floor((origin + bar * barSeconds) / frameSeconds); const to = Math.max(from + 1, Math.floor((origin + (bar + 1) * barSeconds) / frameSeconds));
      const frames = Array.from({ length: to - from }, (_, at) => from + at).filter((frame) => frame < this.level.length);
      const mean = (pick: (frame: number) => number) => frames.length ? frames.reduce((sum, frame) => sum + pick(frame), 0) / frames.length : 0;
      const chroma = Array.from({ length: 12 }, (_, pitch) => mean((frame) => this.chroma[frame]![pitch]!));
      const norm = Math.hypot(...chroma) || 1;
      const hits = peaks.filter((at) => at / onsetRate >= origin + bar * barSeconds && at / onsetRate < origin + (bar + 1) * barSeconds).length;
      return { chroma: chroma.map((value) => value / norm), timbre: Array.from({ length: TIMBRE }, (_, index) => mean((frame) => this.timbre[frame]![index]!)),
        level: 10 * Math.log10(1e-20 + mean((frame) => 10 ** (this.level[frame]! / 10))), low: mean((frame) => this.lowShare[frame]!), hits };
    });
    // Timbre, level and low end in units of their spread across the song, so each counts beside the chroma.
    const z = (values: number[]) => { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1; return values.map((value) => (value - mean) / spread); };
    const timbres = Array.from({ length: TIMBRE }, (_, index) => z(bars.map((bar) => bar.timbre[index]!)));
    const levels = z(bars.map((bar) => bar.level)); const lows = z(bars.map((bar) => bar.low));
    const vectors = bars.map((bar, at) => [...bar.chroma.map((value) => value * 2), ...timbres.map((column) => column[at]! / Math.sqrt(TIMBRE) * 2), levels[at]! * 1.5, lows[at]!]);
    const similar = (a: number[], b: number[]) => { let dot = 0; let left = 0; let right = 0; for (let index = 0; index < a.length; index++) { dot += a[index]! * b[index]!; left += a[index]! ** 2; right += b[index]! ** 2; } return dot / Math.sqrt(Math.max(1e-12, left * right)); };
    const matrix = vectors.map((row) => vectors.map((other) => similar(row, other)));
    const edges = boundaries(matrix, count);
    // Sections between the edges, each with its own numbers.
    const starts = [0, ...edges]; const sections = starts.map((from, index) => ({ from, to: starts[index + 1] ?? count }));
    const sectionLevel = sections.map(({ from, to }) => 10 * Math.log10(1e-20 + bars.slice(from, to).reduce((sum, bar) => sum + 10 ** (bar.level / 10), 0) / (to - from)));
    const loudestSection = Math.max(...sectionLevel);
    const hitsPerBar = sections.map(({ from, to }) => bars.slice(from, to).reduce((sum, bar) => sum + bar.hits, 0) / (to - from));
    const usualHits = percentile(bars.map((bar) => bar.hits), 0.5) || 1;
    const lowEnd = sections.map(({ from, to }) => bars.slice(from, to).reduce((sum, bar) => sum + bar.low, 0) / (to - from));
    const fullest = Math.max(1e-9, ...lowEnd);
    const centroid = (from: number, to: number) => vectors[0]!.map((_, index) => vectors.slice(from, to).reduce((sum, vector) => sum + vector[index]!, 0) / (to - from));
    // Alike: a section close enough to an earlier one (by its average bar) takes its letter.
    const letters: { letter: string; centre: number[] }[] = [];
    const like = sections.map(({ from, to }) => {
      const centre = centroid(from, to);
      const match = letters.map((item) => ({ item, score: similar(item.centre, centre) })).sort((a, b) => b.score - a.score)[0];
      if (match && match.score >= 0.8) return match.item.letter;
      const letter = String.fromCharCode(65 + Math.min(25, letters.length)); letters.push({ letter, centre }); return letter;
    });
    const energy = sectionLevel.map((value) => Math.max(0, Math.min(1, round(1 + (value - loudestSection) / 18, 2))));
    const level = sectionLevel.map((value): FormSection["level"] => (value > loudestSection - 3 ? "high" : value > loudestSection - 8 ? "mid" : "low"));
    const roles = sections.map((_, index): FormSection["role"] => {
      const last = index === sections.length - 1;
      if (level[index] === "high") return "peak";
      if (index === 0) return "intro";
      if (last) return "outro";
      // Rising into a peak: a build; low between others: a break.
      if (level[index + 1] === "high" && energy[index]! >= energy[index - 1]! - 0.05) return "build";
      if (level[index] === "low") return "break";
      return "main";
    });
    const at = (bar: number) => clock(Math.min(seconds, origin + bar * barSeconds));
    const result: FormSection[] = sections.map(({ from, to }, index) => ({ from: at(from), to: at(to), bar: from + 1, bars: to - from, energy: energy[index]!, level: level[index]!,
      density: hitsPerBar[index]! < usualHits * 0.6 ? "sparse" : hitsPerBar[index]! > usualHits * 1.4 ? "busy" : "steady", low: lowEnd[index]! >= fullest * 0.6 ? "full" : "thin",
      like: like[index]!, role: roles[index]! }));
    return { kumiForm: FORM_VERSION, file, seconds: round(seconds, 2), tempo, beatsPerBar, bars: count, sections: result,
      summary: `${result.map((section) => `${section.role} ${section.bars}`).join(" · ")} (${count} bars at ${tempo.bpm} BPM)`,
      ...(options.tempo ? { atSetTempo: `${clock(count * beatsPerBar * 60 / options.tempo)} at the Set's ${round(options.tempo, 2)} BPM` } : {}) };
  }
}

/**
 * Where sections change: peaks of the novelty along the matrix's diagonal (a checkerboard kernel, tapered),
 * at least two bars from either end and four from each other, the strongest first; each snapped to a
 * four-bar phrase when it's within a bar of one.
 */
export function boundaries(matrix: readonly (readonly number[])[], count: number): number[] {
  const half = count >= 32 ? 4 : 2;
  const sigma = half / 2;
  const novelty = Array.from({ length: count }, (_, bar) => {
    if (bar < 2 || bar > count - 2) return 0;
    let sum = 0; let weight = 0;
    for (let a = -half; a < half; a++) for (let b = -half; b < half; b++) {
      const i = bar + a; const j = bar + b;
      if (i < 0 || j < 0 || i >= count || j >= count) continue;
      const taper = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
      sum += (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1) * taper * matrix[i]![j]!; weight += taper;
    }
    return weight ? sum / weight : 0;
  });
  const positive = novelty.filter((value) => value > 0);
  if (!positive.length) return [];
  const mean = positive.reduce((sum, value) => sum + value, 0) / positive.length;
  const spread = Math.sqrt(positive.reduce((sum, value) => sum + (value - mean) ** 2, 0) / positive.length);
  const peaks = novelty.map((value, bar) => ({ value, bar }))
    .filter(({ value, bar }) => value > Math.max(0.05, mean + 0.25 * spread) && value >= (novelty[bar - 1] ?? 0) && value >= (novelty[bar + 1] ?? 0))
    .sort((a, b) => b.value - a.value);
  const chosen: number[] = [];
  for (const { bar } of peaks) {
    const phrase = Math.round(bar / 4) * 4;
    const snapped = Math.abs(phrase - bar) <= 1 && phrase >= 2 && phrase <= count - 2 ? phrase : bar;
    if (chosen.every((other) => Math.abs(other - snapped) >= 4)) chosen.push(snapped);
  }
  return chosen.sort((a, b) => a - b);
}

/** An onset strength curve: the rise in log energy of three bands, 512 samples a step, the local average taken away. */
function onsetStrength(frames: number[][]): Float64Array {
  const out = new Float64Array(frames.length);
  for (let index = 1; index < frames.length; index++) {
    let rise = 0;
    for (let band = 0; band < 3; band++) rise += Math.max(0, Math.log10(1e-9 + frames[index]![band]!) - Math.log10(1e-9 + frames[index - 1]![band]!)) * (band === 0 ? 1.5 : 1);
    out[index] = rise;
  }
  const smooth = new Float64Array(out.length); let running = 0;
  for (let index = 0; index < out.length; index++) {
    running += out[index]!; if (index >= 16) running -= out[index - 16]!;
    smooth[index] = Math.max(0, out[index]! - running / Math.min(index + 1, 16));
  }
  return smooth;
}

/** The onsets' places: peaks over the threshold, at least ~50 ms apart. */
function onsetPeaks(strength: Float64Array): number[] {
  const values = Array.from(strength);
  const threshold = values.length ? percentile(values, 0.5) + 2 * Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) : Infinity;
  const peaks: number[] = []; let last = -10;
  for (let index = 1; index < strength.length - 1; index++) {
    const value = strength[index]!;
    if (value > threshold && value >= strength[index - 1]! && value >= strength[index + 1]! && index - last >= 4) { peaks.push(index); last = index; }
  }
  return peaks;
}

/**
 * Tempo from the onset curve's autocorrelation, 60–200 BPM. With the Set's tempo, the octave nearest it
 * (a song heard at half or double speed is the same song); otherwise the 90–160 range listeners tap.
 */
function estimateTempo(strength: Float64Array, rate: number, near?: number): number | undefined {
  const minLag = Math.floor(rate * 60 / 200); const maxLag = Math.ceil(rate * 60 / 60);
  if (strength.length < maxLag * 3) return undefined;
  const mean = strength.reduce((sum, value) => sum + value, 0) / strength.length;
  const centered = Float64Array.from(strength, (value) => value - mean);
  const zero = centered.reduce((sum, value) => sum + value * value, 0);
  if (zero <= 0) return undefined;
  let best = -1; let bestScore = -Infinity; const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0; for (let index = lag; index < centered.length; index++) sum += centered[index]! * centered[index - lag]!;
    scores[lag] = sum / zero;
    const bpm = 60 * rate / lag; const weight = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.9) ** 2);
    if (scores[lag]! * weight > bestScore) { bestScore = scores[lag]! * weight; best = lag; }
  }
  if (best < 0 || scores[best]! <= 0.02) return undefined;
  const bpm = 60 * rate / best;
  if (!near) return bpm;
  const octaves = [bpm / 2, bpm, bpm * 2].filter((value) => value >= 40 && value <= 300);
  return octaves.sort((a, b) => Math.abs(Math.log2(a / near)) - Math.abs(Math.log2(b / near)))[0];
}
