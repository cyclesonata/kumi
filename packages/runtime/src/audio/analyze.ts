/**
 * How Kumi "hears": one pass over an audio file measures what an engineer listens for, as numbers
 * a model can reason with. Loudness (BS.1770: integrated, short-term, range, true peak), tonal
 * balance in named bands, stereo width per band, dynamics and transients, tempo, key, and the
 * energy over time as a small text spectrogram. A single sound (a synth note, a drum hit, a short
 * sample) also gets its pitch, harmonic make-up, envelope and movement (filter sweeps, wobble).
 * The result is versioned JSON, stable enough for later tools, a decision model included.
 */
import { AudioError, openAudio, type AudioSource } from "./decode.js";
import { Biquad, clock, db, dbAmplitude, fft, kWeighting, noteOf, percentile, PITCH_CLASSES, round, TruePeak, window } from "./dsp.js";

export const ANALYSIS_VERSION = 1;

export const BANDS = [
  { name: "sub", from: 20, to: 60 },
  { name: "bass", from: 60, to: 120 },
  { name: "upper bass", from: 120, to: 250 },
  { name: "low mids", from: 250, to: 500 },
  { name: "mids", from: 500, to: 1000 },
  { name: "upper mids", from: 1000, to: 2000 },
  { name: "presence", from: 2000, to: 4000 },
  { name: "bite", from: 4000, to: 6000 },
  { name: "brilliance", from: 6000, to: 10000 },
  { name: "air", from: 10000, to: 20000 },
] as const;

export interface BandLevel { name: string; hz: string; db: number; width: number; correlation: number }
export interface SoundAnalysis {
  pitch?: { note: string; hz: number; cents: number; confidence: number; movement?: string };
  harmonics?: { partials: number[]; shape: string; slopeDbPerOctave: number; oddToEven: number; noiseDb: number; inharmonicity: number };
  envelope: { attackMs: number; decayMs: number; sustainDb: number; releaseMs: number; lengthMs: number };
  movement: { brightness: string; lfo?: { hz: number; on: string; depth: string; atTempo?: string } };
}
export interface Analysis {
  kumiAudio: typeof ANALYSIS_VERSION;
  file: string;
  format: string;
  sampleRate: number;
  channels: number;
  seconds: number;
  analyzed: { from: string; to: string; focus: "mix" | "sound" };
  loudness: { integratedLufs: number | null; shortTermMaxLufs: number | null; rangeLu: number | null; truePeakDbtp: number; samplePeakDbfs: number; clippedSamples: number };
  balance: { bands: BandLevel[]; tiltDbPerOctave: number; centroidHz: number };
  stereo: { correlation: number; width: number; lowEndMono: boolean } | null;
  dynamics: { crestDb: number; peakToLoudnessDb: number | null; onsetsPerSecond: number };
  tempo: { bpm: number; confidence: number } | null;
  key: { name: string; confidence: number } | null;
  overTime: { every: string; lufs: (number | null)[] };
  spectrogram: { rows: { band: string; cells: string }[]; columns: string; scale: string };
  sound?: SoundAnalysis;
  /**
   * When things happen, finely: the onset strength (0–1) and the level (dB) every `step` seconds. For
   * comparing rhythm and how loudness moves (closeness), not for the model to read.
   */
  timeline?: { step: number; onset: number[]; level: number[] };
  /** The notes heard, when asked for (transcribe): each onset with its pitch, velocity and length. */
  notes?: HeardNote[];
}

/** A note transcribed from audio: when (seconds from the start of what was analyzed), how long, its pitch (MIDI; none for a hit without one), how hard. */
export interface HeardNote { time: number; duration: number; midi: number | null; velocity: number; confidence: number }

export interface AnalyzeOptions {
  /** "sound" for a single note or hit, "mix" for a song; "auto" picks by length. */
  focus?: "mix" | "sound" | "auto";
  /** Seconds into the file to start at, and how many to analyze. */
  start?: number;
  seconds?: number;
  signal?: AbortSignal;
  /** Transcribe the notes (the first minute at most). */
  transcribe?: boolean;
}

/** The longest stretch analyzed; more is sampled from its start. */
const MAX_SECONDS = 12 * 60;
const SOUND_SECONDS = 20;

export async function analyzeFile(path: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  const source = await openAudio(path, options.signal ? { signal: options.signal } : {});
  try { return await analyzeSource(source, path, options); } finally { await source.close(); }
}

export async function analyzeSource(source: AudioSource, name: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  const { sampleRate, channels } = source;
  if (sampleRate < 8000 || sampleRate > 384000) throw new AudioError(`A sample rate of ${sampleRate} Hz isn't one Kumi can analyze.`);
  const total = source.frames / sampleRate;
  const startSeconds = Math.max(0, options.start ?? 0);
  const length = Math.min(options.seconds ?? MAX_SECONDS, MAX_SECONDS, total - startSeconds);
  // A start at or past the end is a request for audio the file doesn't have, not for its last moment.
  if (!(length > 0.02)) throw new AudioError(startSeconds > 0 ? `There's no audio in that part of the file: it's ${clock(total)} long.` : "There's no audio in that part of the file.");
  const focus = options.focus === "mix" || options.focus === "sound" ? options.focus : length <= SOUND_SECONDS ? "sound" : "mix";
  source.seek(startSeconds * sampleRate);
  const frames = Math.floor(length * sampleRate);
  const meter = new Meter(sampleRate, channels, frames);
  const keepMono = focus === "sound" || options.transcribe ? new Float32Array(Math.min(frames, focus === "sound" ? frames : sampleRate * 60)) : undefined;
  let done = 0;
  while (done < frames) {
    options.signal?.throwIfAborted();
    const block = await source.read(Math.min(65536, frames - done));
    if (!block) break;
    meter.push(block, keepMono, done);
    done += block[0]!.length;
    // Other work (a redraw, a keypress) gets its turn between blocks.
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (done < sampleRate * 0.02) throw new AudioError("There's no audio in that part of the file.");
  const summary = meter.finish(done);
  const analysis: Analysis = {
    kumiAudio: ANALYSIS_VERSION, file: name.split(/[\\/]/).at(-1) ?? name, format: source.format, sampleRate, channels,
    seconds: round(total, 2), analyzed: { from: clock(startSeconds), to: clock(startSeconds + done / sampleRate), focus },
    ...summary,
  };
  if (keepMono && focus === "sound") analysis.sound = analyzeSound(keepMono.subarray(0, done), sampleRate, summary.tempo?.bpm);
  if (keepMono && options.transcribe) analysis.notes = transcribe(keepMono.subarray(0, Math.min(done, keepMono.length)), sampleRate, meter.onsetCurve());
  return analysis;
}

const FRAME = 4096;
/** Columns of the text spectrogram. */
const COLUMNS = 24;

class Meter {
  // Loudness: K-weighted mean square per 100 ms, per channel.
  private readonly filters: [Biquad, Biquad][];
  private readonly block100: number;
  private readonly squares: number[][] = [];
  private readonly partial: Float64Array;
  private filled = 0;
  private samplePeak = 0; private truePeak = 0; private clipped = 0;
  private readonly peakers: TruePeak[];
  /** Samples left to check between for a hidden peak, after a loud one. */
  private readonly peakWatch: number[];
  private sumSquares = 0; private sumLR = 0; private sumLL = 0; private sumRR = 0;
  // Spectrum: FFT frames of both channels at once.
  private readonly left = new Float64Array(FRAME); private readonly right = new Float64Array(FRAME);
  private ring = 0;
  private readonly re = new Float64Array(FRAME); private readonly im = new Float64Array(FRAME);
  private readonly bandOf: Int16Array;
  private readonly mid: Float64Array; private readonly side: Float64Array; private readonly cross: Float64Array;
  private readonly leftPower: Float64Array; private readonly rightPower: Float64Array;
  private readonly slices: Float64Array[] = [];
  private readonly chroma = new Float64Array(12);
  private readonly chromaOf: Int8Array;
  private centroidSum = 0; private centroidWeight = 0;
  private spectra = 0;
  private readonly sliceFrames: number;
  // Onsets, for tempo and density: energy in three bands per 512 samples.
  private readonly onsetFilters: { low: Biquad; high: Biquad };
  private onsetEnergy = [0, 0, 0]; private onsetCount = 0;
  private readonly onsetFrames: number[][] = [];
  private position = 0;

  constructor(private readonly sampleRate: number, private readonly channels: number, frames: number) {
    this.filters = Array.from({ length: channels }, () => kWeighting(sampleRate));
    this.block100 = Math.round(sampleRate / 10);
    this.partial = new Float64Array(channels);
    this.peakers = Array.from({ length: channels }, () => new TruePeak());
    this.peakWatch = Array.from({ length: channels }, () => 0);
    this.bandOf = new Int16Array(FRAME / 2 + 1).fill(-1);
    this.chromaOf = new Int8Array(FRAME / 2 + 1).fill(-1);
    for (let bin = 1; bin <= FRAME / 2; bin++) {
      const hz = bin * sampleRate / FRAME;
      this.bandOf[bin] = BANDS.findIndex((band) => hz >= band.from && hz < band.to);
      if (hz >= 55 && hz <= 4500) this.chromaOf[bin] = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
    }
    this.mid = new Float64Array(BANDS.length); this.side = new Float64Array(BANDS.length); this.cross = new Float64Array(BANDS.length);
    this.leftPower = new Float64Array(BANDS.length); this.rightPower = new Float64Array(BANDS.length);
    // No more columns than spectra: a short sound gets fewer, none of them empty.
    this.sliceFrames = Math.max(FRAME, Math.ceil(frames / COLUMNS));
    this.onsetFilters = { low: lowPass(sampleRate, 150), high: highPass(sampleRate, 2500) };
  }

  push(block: Float32Array[], keepMono: Float32Array | undefined, offset: number) {
    const count = block[0]!.length;
    const left = block[0]!; const right = block[1] ?? left;
    for (let index = 0; index < count; index++) {
      const l = left[index]!; const r = right[index]!;
      // Loudness and peaks.
      for (let channel = 0; channel < this.channels; channel++) {
        const sample = block[channel]![index]!;
        const [shelf, highPass] = this.filters[channel]!;
        const weighted = highPass.process(shelf.process(sample));
        this.partial[channel]! += weighted * weighted;
        const magnitude = Math.abs(sample);
        if (magnitude > this.samplePeak) this.samplePeak = magnitude;
        if (magnitude >= 0.999) this.clipped++;
        const peaker = this.peakers[channel]!;
        peaker.push(sample);
        // Between quiet samples no peak can hide: only the stretch around a loud one is oversampled.
        if (magnitude > this.truePeak * 0.5) this.peakWatch[channel] = 12;
        if (this.peakWatch[channel]! > 0) { this.peakWatch[channel]!--; this.truePeak = Math.max(this.truePeak, peaker.peak(), magnitude); }
      }
      if (++this.filled === this.block100) {
        this.squares.push(Array.from(this.partial, (sum) => sum / this.block100));
        this.partial.fill(0); this.filled = 0;
      }
      const mono = (l + r) / 2;
      this.sumSquares += mono * mono; this.sumLR += l * r; this.sumLL += l * l; this.sumRR += r * r;
      if (keepMono && offset + index < keepMono.length) keepMono[offset + index] = mono;
      // Spectrum.
      this.left[this.ring] = l; this.right[this.ring] = r;
      if (++this.ring === FRAME) { this.spectrum(); this.ring = 0; }
      // Onsets.
      const low = this.onsetFilters.low.process(mono); const high = this.onsetFilters.high.process(mono);
      this.onsetEnergy[0]! += low * low; this.onsetEnergy[1]! += mono * mono; this.onsetEnergy[2]! += high * high;
      if (++this.onsetCount === 512) { this.onsetFrames.push(this.onsetEnergy); this.onsetEnergy = [0, 0, 0]; this.onsetCount = 0; }
      this.position++;
    }
  }

  /** One FFT for both channels: left real, right imaginary, separated by symmetry. */
  private spectrum() {
    const hann = window(FRAME);
    for (let index = 0; index < FRAME; index++) { this.re[index] = this.left[index]! * hann[index]!; this.im[index] = this.right[index]! * hann[index]!; }
    fft(this.re, this.im);
    const slice = Math.max(0, Math.min(COLUMNS - 1, Math.floor((this.position - FRAME / 2) / this.sliceFrames)));
    const bands = (this.slices[slice] ??= new Float64Array(BANDS.length));
    let weighted = 0; let power = 0;
    for (let bin = 1; bin <= FRAME / 2; bin++) {
      const mirror = (FRAME - bin) % FRAME;
      const zr = this.re[bin]!; const zi = this.im[bin]!; const wr = this.re[mirror]!; const wi = this.im[mirror]!;
      // L = (Z[k] + conj(Z[N-k])) / 2, R = (Z[k] - conj(Z[N-k])) / 2i
      const lr = (zr + wr) / 2; const li = (zi - wi) / 2;
      const rr = (zi + wi) / 2; const ri = (wr - zr) / 2;
      const leftPower = lr * lr + li * li; const rightPower = rr * rr + ri * ri;
      const mr = (lr + rr) / 2; const mi = (li + ri) / 2; const sr = (lr - rr) / 2; const si = (li - ri) / 2;
      const midPower = mr * mr + mi * mi; const sidePower = sr * sr + si * si;
      const total = this.channels > 1 ? midPower : leftPower;
      const band = this.bandOf[bin]!;
      if (band >= 0) {
        bands[band]! += total;
        this.mid[band]! += midPower; this.side[band]! += sidePower; this.cross[band]! += lr * rr + li * ri;
        this.leftPower[band]! += leftPower; this.rightPower[band]! += rightPower;
      }
      const pitchClass = this.chromaOf[bin]!;
      if (pitchClass >= 0) this.chroma[pitchClass]! += Math.sqrt(total);
      const hz = bin * this.sampleRate / FRAME;
      weighted += hz * total; power += total;
    }
    if (power > 1e-12) { this.centroidSum += weighted; this.centroidWeight += power; }
    this.spectra++;
  }

  finish(frames: number) {
    // A short file still gets a spectrum: its last, partial frame, zero-padded.
    if (this.spectra === 0 && this.ring > 0) { this.left.fill(0, this.ring); this.right.fill(0, this.ring); this.position = Math.max(this.position, FRAME / 2); this.spectrum(); }
    const seconds = frames / this.sampleRate;
    const loudness = gatedLoudness(this.squares);
    const rms = Math.sqrt(this.sumSquares / Math.max(1, frames));
    const totalPower = BANDS.reduce((sum, _, band) => sum + this.sliceSum(band), 0);
    const bands: BandLevel[] = BANDS.map((band, index) => {
      const power = this.sliceSum(index);
      const mid = this.mid[index]!; const side = this.side[index]!;
      const cross = this.cross[index]! / Math.sqrt(Math.max(1e-30, this.leftPower[index]! * this.rightPower[index]!));
      return { name: band.name, hz: `${band.from}–${band.to >= 1000 ? `${band.to / 1000}k` : band.to}`, db: round(db(power / Math.max(1e-30, totalPower))),
        width: this.channels > 1 ? round(side / Math.max(1e-30, mid + side), 2) : 0, correlation: this.channels > 1 ? round(Math.max(-1, Math.min(1, cross)), 2) : 1 };
    });
    // Tilt: level per octave against frequency, as a line.
    const points = BANDS.map((band, index) => ({ x: Math.log2(Math.sqrt(band.from * band.to)), y: db(this.sliceSum(index) / Math.log2(band.to / band.from)) }))
      .filter((point) => point.y > -150 && 2 ** point.x < this.sampleRate / 2);
    const tilt = slope(points);
    const correlation = this.sumLR / Math.sqrt(Math.max(1e-30, this.sumLL * this.sumRR));
    const lowWidth = ((this.side[0]! + this.side[1]!) / Math.max(1e-30, this.mid[0]! + this.mid[1]! + this.side[0]! + this.side[1]!));
    const onsets = onsetStrength(this.onsetFrames);
    const tempo = seconds >= 6 ? estimateTempo(onsets, this.sampleRate / 512) : null;
    const key = estimateKey(this.chroma);
    return {
      loudness: { integratedLufs: loudness.integrated === null ? null : round(loudness.integrated), shortTermMaxLufs: loudness.shortTermMax === null ? null : round(loudness.shortTermMax),
        rangeLu: loudness.range === null ? null : round(loudness.range), truePeakDbtp: round(dbAmplitude(this.truePeak)), samplePeakDbfs: round(dbAmplitude(this.samplePeak)), clippedSamples: this.clipped },
      balance: { bands, tiltDbPerOctave: round(tilt), centroidHz: Math.round(this.centroidSum / Math.max(1e-30, this.centroidWeight)) },
      stereo: this.channels > 1 ? { correlation: round(correlation, 2), width: round(bands.reduce((sum, band) => sum + band.width, 0) / bands.length, 2), lowEndMono: lowWidth < 0.05 } : null,
      dynamics: { crestDb: round(dbAmplitude(this.samplePeak) - dbAmplitude(rms)), peakToLoudnessDb: loudness.integrated === null ? null : round(dbAmplitude(this.truePeak) - loudness.integrated),
        onsetsPerSecond: round(countOnsets(onsets) / Math.max(0.1, seconds)) },
      tempo, key,
      overTime: overTime(this.squares, this.channels, seconds),
      spectrogram: this.picture(seconds),
      timeline: this.timeline(onsets),
    };
  }

  /** The onset strength per 512 samples, for transcribing. */
  onsetCurve(): Float64Array { return onsetStrength(this.onsetFrames); }

  /** Onsets and level at a fine step (512 samples, pooled so a long file keeps 2,000 points at most). */
  private timeline(onsets: Float64Array): NonNullable<Analysis["timeline"]> {
    const pool = Math.max(1, Math.ceil(onsets.length / 2000));
    const peak = Math.max(1e-9, ...onsets);
    const onset: number[] = []; const level: number[] = [];
    for (let at = 0; at < onsets.length; at += pool) {
      let strongest = 0; let energy = 0;
      for (let index = at; index < Math.min(onsets.length, at + pool); index++) { strongest = Math.max(strongest, onsets[index]!); energy += this.onsetFrames[index]?.[1] ?? 0; }
      onset.push(round(strongest / peak, 2)); level.push(round(Math.max(-90, db(energy / (512 * pool)))));
    }
    return { step: round(512 * pool / this.sampleRate, 4), onset, level };
  }

  private sliceSum(band: number): number { return this.slices.reduce((sum, slice) => sum + (slice?.[band] ?? 0), 0); }

  /** Bands (air at the top) across time, 0–9 in 3 dB steps below the loudest cell. */
  private picture(seconds: number): Analysis["spectrogram"] {
    const cells = this.slices.map((slice) => (slice ? Array.from(slice, (power) => db(power)) : undefined));
    const loudest = Math.max(...cells.flatMap((row) => row ?? []).filter((value) => value > -150));
    const columns = Math.max(1, this.slices.length);
    const rows = BANDS.map((band, index) => ({ band: band.name,
      cells: Array.from({ length: columns }, (_, column) => {
        const value = cells[column]?.[index];
        if (value === undefined || value < -150 || !Number.isFinite(loudest)) return "·";
        const level = Math.round(9 - (loudest - value) / 3);
        return level < 0 ? "·" : String(level);
      }).join("") })).reverse();
    return { rows, columns: `${clock(0)} to ${clock(seconds)}, ${columns} steps`, scale: "9 = loudest, each step 3 dB quieter, · = silent" };
  }
}

function lowPass(sampleRate: number, hz: number): Biquad {
  const k = Math.tan(Math.PI * hz / sampleRate); const q = Math.SQRT1_2; const norm = 1 / (1 + k / q + k * k);
  return new Biquad(k * k * norm, 2 * k * k * norm, k * k * norm, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm);
}
function highPass(sampleRate: number, hz: number): Biquad {
  const k = Math.tan(Math.PI * hz / sampleRate); const q = Math.SQRT1_2; const norm = 1 / (1 + k / q + k * k);
  return new Biquad(norm, -2 * norm, norm, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm);
}

function slope(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const mx = points.reduce((sum, point) => sum + point.x, 0) / points.length; const my = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const num = points.reduce((sum, point) => sum + (point.x - mx) * (point.y - my), 0); const den = points.reduce((sum, point) => sum + (point.x - mx) ** 2, 0);
  return den ? num / den : 0;
}

/** BS.1770-4 gating over 400 ms blocks; EBU R128 short-term (3 s) and loudness range. */
function gatedLoudness(squares: number[][]) {
  const blockLoudness = (from: number, count: number) => {
    let sum = 0;
    for (let channel = 0; channel < (squares[0]?.length ?? 0); channel++) {
      let mean = 0;
      for (let index = from; index < from + count; index++) mean += squares[index]![channel]!;
      sum += mean / count;
    }
    return { power: sum, lufs: -0.691 + db(sum) };
  };
  const blocks: { power: number; lufs: number }[] = [];
  for (let index = 0; index + 4 <= squares.length; index++) blocks.push(blockLoudness(index, 4));
  const absolute = blocks.filter((block) => block.lufs > -70);
  let integrated: number | null = null;
  if (absolute.length) {
    const relative = -0.691 + db(absolute.reduce((sum, block) => sum + block.power, 0) / absolute.length) - 10;
    const gated = absolute.filter((block) => block.lufs > relative);
    if (gated.length) integrated = -0.691 + db(gated.reduce((sum, block) => sum + block.power, 0) / gated.length);
  }
  const shortTerm: number[] = [];
  for (let index = 0; index + 30 <= squares.length; index += 10) shortTerm.push(blockLoudness(index, 30).lufs);
  const audible = shortTerm.filter((value) => value > -70);
  let range: number | null = null;
  if (audible.length >= 2) {
    const gate = -0.691 + db(audible.reduce((sum, value) => sum + 10 ** ((value + 0.691) / 10), 0) / audible.length) - 20;
    const kept = audible.filter((value) => value > gate);
    if (kept.length >= 2) range = percentile(kept, 0.95) - percentile(kept, 0.1);
  }
  return { integrated, shortTermMax: audible.length ? Math.max(...audible) : null, range };
}

/** Loudness in (up to) 16 equal stretches, so builds, drops and breaks show. */
function overTime(squares: number[][], channels: number, seconds: number): Analysis["overTime"] {
  const parts = Math.min(16, Math.max(1, Math.floor(squares.length / 10)));
  const per = squares.length / parts;
  const lufs = Array.from({ length: parts }, (_, part) => {
    const from = Math.floor(part * per); const to = Math.max(from + 1, Math.floor((part + 1) * per));
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      let mean = 0;
      for (let index = from; index < to; index++) mean += squares[index]?.[channel] ?? 0;
      sum += mean / (to - from);
    }
    const value = -0.691 + db(sum);
    return value > -70 ? round(value) : null;
  });
  return { every: `${round(seconds / parts, 1)} s`, lufs };
}

/** An onset strength curve: the rise in log energy of three bands, 512 samples a step. */
function onsetStrength(frames: number[][]): Float64Array {
  const out = new Float64Array(frames.length);
  for (let index = 1; index < frames.length; index++) {
    let rise = 0;
    for (let band = 0; band < 3; band++) {
      const now = Math.log10(1e-9 + frames[index]![band]!); const before = Math.log10(1e-9 + frames[index - 1]![band]!);
      rise += Math.max(0, now - before) * (band === 0 ? 1.5 : 1);
    }
    out[index] = rise;
  }
  // Take away the local average, so steady loudness doesn't count as onsets.
  const smooth = new Float64Array(out.length); const span = 16;
  let running = 0;
  for (let index = 0; index < out.length; index++) {
    running += out[index]!;
    if (index >= span) running -= out[index - span]!;
    smooth[index] = Math.max(0, out[index]! - running / Math.min(index + 1, span));
  }
  return smooth;
}

/**
 * Where notes start, for transcribing: the level every `hop` samples, and a start wherever it rises 6 dB or
 * more within ~25 ms (from where the last note had decayed to), within 45 dB of the loudest, at least 40 ms
 * after the last. A repeated note is found as well as a new one; a note at the very start too.
 */
function noteStarts(mono: Float32Array, sampleRate: number, hop: number): number[] {
  const level: number[] = [];
  for (let from = 0; from < mono.length; from += hop) {
    let sum = 0; const to = Math.min(mono.length, from + hop);
    for (let index = from; index < to; index++) sum += mono[index]! * mono[index]!;
    level.push(10 * Math.log10(sum / Math.max(1, to - from) + 1e-12));
  }
  const loudest = Math.max(...level);
  const back = Math.max(1, Math.round(0.025 * sampleRate / hop)); const gap = Math.round(0.04 * sampleRate / hop);
  // How far the level climbed from its lowest in the last ~25 ms (from silence, for the very first).
  const rise = level.map((value, index) => { const before = level.slice(Math.max(0, index - back), index); return value - (before.length ? Math.min(...before) : -120); });
  const starts: number[] = []; let last = -gap;
  for (let index = 0; index < level.length; index++) {
    if (rise[index]! < 6 || level[index]! < loudest - 45 || index - last < gap) continue;
    // The steepest point of the rise, a little after its start: the local maximum of the rise.
    if (rise[index]! < (rise[index + 1] ?? -Infinity)) continue;
    starts.push(index); last = index;
  }
  return starts;
}

/** The onsets' places in a strength curve: peaks over the threshold, at least ~50 ms apart. */
function onsetPeaks(strength: Float64Array): number[] {
  if (strength.length < 3) return [];
  const values = Array.from(strength);
  const threshold = percentile(values, 0.5) + 2 * Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  const peaks: number[] = []; let last = -10;
  for (let index = 1; index < strength.length - 1; index++) {
    const value = strength[index]!;
    if (value > threshold && value >= strength[index - 1]! && value >= strength[index + 1]! && index - last >= 4) { peaks.push(index); last = index; }
  }
  return peaks;
}

/**
 * The notes in a stretch of audio: each onset, the pitch it settles on (by the same pitch tracking as a
 * single sound's, over its first 150 ms), how hard it starts against the loudest, and how long until it
 * falls 18 dB or the next one starts. A hit without a clear pitch has none. Monophonic: the strongest line.
 */
export function transcribe(mono: Float32Array, sampleRate: number, _strength?: Float64Array): HeardNote[] {
  const hop = 256; const peaks = noteStarts(mono, sampleRate, hop);
  const rms = (from: number, length: number) => { let sum = 0; const to = Math.min(mono.length, from + length); for (let index = from; index < to; index++) sum += mono[index]! ** 2; return Math.sqrt(sum / Math.max(1, to - from)); };
  const found = peaks.map((peak, index) => {
    const start = Math.max(0, peak * hop - hop);
    const next = index + 1 < peaks.length ? peaks[index + 1]! * hop : mono.length;
    // Its attack: the loudest 5 ms in its first 60 ms, and where that is.
    const slot = Math.round(sampleRate * 0.005);
    const levels = Array.from({ length: 12 }, (_, step) => rms(start + step * slot, slot));
    const loudestAt = levels.indexOf(Math.max(...levels));
    const attack = dbAmplitude(Math.max(1e-9, levels[loudestAt]!));
    // Its length: from where it starts sounding until it falls 18 dB below its attack, or the next note starts (two seconds at most).
    const window = Math.round(sampleRate * 0.01);
    let end = start + loudestAt * slot;
    while (end + window < Math.min(next, start + sampleRate * 2) && dbAmplitude(rms(end, window)) > attack - 18) end += window;
    // Its pitch: tracked over its first 150 ms, after the first 20 ms of attack.
    const from = start + Math.round(sampleRate * 0.02);
    const tracked = from < mono.length ? trackPitch(mono.subarray(from, Math.min(mono.length, from + Math.round(sampleRate * 0.15) + 4096)), sampleRate).filter((frame) => frame.confidence > 0.6 && frame.hz > 30) : [];
    const hz = tracked.length ? percentile(tracked.map((frame) => frame.hz), 0.5) : 0;
    const confidence = tracked.length ? percentile(tracked.map((frame) => frame.confidence), 0.5) : 0;
    return { time: start / sampleRate, duration: Math.max(0.02, (end - start) / sampleRate), midi: hz > 0 ? noteOf(hz).midi : null, attack, confidence };
  });
  const loudest = Math.max(-200, ...found.map((note) => note.attack));
  return found.map(({ attack, ...note }) => ({ ...note, time: round(note.time, 3), duration: round(note.duration, 3), velocity: Math.max(1, Math.min(127, Math.round(127 + 3 * (attack - loudest)))), confidence: round(note.confidence, 2) }));
}

function countOnsets(strength: Float64Array): number {
  if (strength.length < 3) return 0;
  const values = Array.from(strength);
  const threshold = percentile(values, 0.5) + 2 * Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  let count = 0; let last = -10;
  for (let index = 1; index < strength.length - 1; index++) {
    const value = strength[index]!;
    // At least ~50 ms apart (512 samples is 11.6 ms at 44.1 kHz).
    if (value > threshold && value >= strength[index - 1]! && value >= strength[index + 1]! && index - last >= 4) { count++; last = index; }
  }
  return count;
}

/** Tempo from the onset curve's autocorrelation, 60–200 BPM, preferring the 90–160 range listeners tap. */
export function estimateTempo(strength: Float64Array, rate: number): { bpm: number; confidence: number } | null {
  const minLag = Math.floor(rate * 60 / 200); const maxLag = Math.ceil(rate * 60 / 60);
  if (strength.length < maxLag * 3) return null;
  const mean = strength.reduce((sum, value) => sum + value, 0) / strength.length;
  const centered = Float64Array.from(strength, (value) => value - mean);
  const zero = centered.reduce((sum, value) => sum + value * value, 0);
  if (zero <= 0) return null;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let index = lag; index < centered.length; index++) sum += centered[index]! * centered[index - lag]!;
    scores[lag] = sum / zero;
  }
  let best = -1; let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * rate / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.9) ** 2);
    const score = scores[lag]! * weight;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || scores[best]! <= 0.02) return null;
  // Parabolic interpolation between the neighbouring lags.
  const a = scores[best - 1] ?? scores[best]!; const b = scores[best]!; const c = scores[best + 1] ?? scores[best]!;
  const shift = a - 2 * b + c !== 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
  const bpm = 60 * rate / (best + Math.max(-0.5, Math.min(0.5, shift)));
  return { bpm: round(bpm, 1), confidence: round(Math.min(1, scores[best]! * 2), 2) };
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
/** The key whose (Krumhansl–Kessler) profile best matches the music's pitch classes. */
export function estimateKey(chroma: Float64Array): { name: string; confidence: number } | null {
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const correlate = (profile: number[], tonic: number) => {
    const x = Array.from({ length: 12 }, (_, index) => chroma[(index + tonic) % 12]!);
    const mx = x.reduce((sum, value) => sum + value, 0) / 12; const my = profile.reduce((sum, value) => sum + value, 0) / 12;
    let num = 0; let dx = 0; let dy = 0;
    for (let index = 0; index < 12; index++) { num += (x[index]! - mx) * (profile[index]! - my); dx += (x[index]! - mx) ** 2; dy += (profile[index]! - my) ** 2; }
    return num / Math.sqrt(Math.max(1e-30, dx * dy));
  };
  const scores = [...Array.from({ length: 12 }, (_, tonic) => ({ name: `${PITCH_CLASSES[tonic]} major`, score: correlate(MAJOR, tonic) })),
    ...Array.from({ length: 12 }, (_, tonic) => ({ name: `${PITCH_CLASSES[tonic]} minor`, score: correlate(MINOR, tonic) }))].sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  if (!best || best.score < 0.3) return null;
  return { name: best.name, confidence: round(Math.max(0, Math.min(1, (best.score - (next?.score ?? 0)) * 5 + best.score / 2)), 2) };
}

// ---- a single sound

/** Pitch, harmonics, envelope and movement of one note or hit. */
export function analyzeSound(mono: Float32Array, sampleRate: number, bpm?: number): SoundAnalysis {
  const envelope = amplitudeEnvelope(mono, sampleRate);
  const pitchTrack = trackPitch(mono, sampleRate);
  const voiced = pitchTrack.filter((frame) => frame.confidence > 0.6);
  let pitch: SoundAnalysis["pitch"];
  let harmonics: SoundAnalysis["harmonics"];
  if (voiced.length >= Math.max(3, pitchTrack.length * 0.25)) {
    const hz = percentile(voiced.map((frame) => frame.hz), 0.5);
    const note = noteOf(hz);
    const confidence = voiced.length / Math.max(1, pitchTrack.length);
    pitch = { note: note.name, hz: round(hz, 1), cents: note.cents, confidence: round(confidence, 2), ...(() => { const movement = pitchMovement(voiced, hz); return movement ? { movement } : {}; })() };
    harmonics = partials(mono, sampleRate, hz, envelope.steadyAt);
  }
  return {
    ...(pitch ? { pitch } : {}), ...(harmonics ? { harmonics } : {}),
    envelope: { attackMs: envelope.attackMs, decayMs: envelope.decayMs, sustainDb: envelope.sustainDb, releaseMs: envelope.releaseMs, lengthMs: envelope.lengthMs },
    movement: movement(mono, sampleRate, bpm),
  };
}

function amplitudeEnvelope(mono: Float32Array, sampleRate: number) {
  const step = Math.max(1, Math.round(sampleRate * 0.005));
  const levels: number[] = [];
  for (let from = 0; from < mono.length; from += step) {
    let sum = 0; const to = Math.min(mono.length, from + step);
    for (let index = from; index < to; index++) sum += mono[index]! * mono[index]!;
    levels.push(Math.sqrt(sum / (to - from)));
  }
  const peak = Math.max(...levels, 1e-9);
  const peakAt = levels.indexOf(peak);
  const ms = (steps: number) => Math.round(steps * step / sampleRate * 1000);
  const start = Math.max(0, levels.findIndex((level) => level > peak * 0.01));
  const attackEnd = levels.findIndex((level, index) => index >= start && level >= peak * 0.9);
  const end = levels.length - 1 - [...levels].reverse().findIndex((level) => level > peak * 0.01);
  // Sustain: the typical level through the middle of what follows the peak.
  const after = levels.slice(peakAt, end + 1);
  const sustain = after.length > 8 ? percentile(after.slice(Math.floor(after.length * 0.4), Math.floor(after.length * 0.8)), 0.5) : peak;
  const decayEnd = peakAt + Math.max(0, after.findIndex((level) => level <= sustain * 1.12));
  const releaseFrom = peakAt + after.length - 1 - [...after].reverse().findIndex((level) => level >= sustain * 0.9);
  return {
    attackMs: ms(Math.max(0, attackEnd - start)), decayMs: ms(Math.max(0, decayEnd - peakAt)), sustainDb: round(dbAmplitude(sustain / peak)),
    releaseMs: ms(Math.max(0, end - Math.max(releaseFrom, decayEnd))), lengthMs: ms(Math.max(0, end - start)),
    /** Where the note has settled: after the attack and decay. */
    steadyAt: Math.min(mono.length - 1, (Math.max(decayEnd, attackEnd) + 2) * step),
  };
}

/** YIN pitch (cumulative mean normalized difference), computed with FFT autocorrelation. */
export function trackPitch(mono: Float32Array, sampleRate: number): { hz: number; confidence: number; at: number }[] {
  const size = 2048; const maxLag = size; const hop = 1024;
  const out: { hz: number; confidence: number; at: number }[] = [];
  const fftSize = 4096;
  const re = new Float64Array(fftSize); const im = new Float64Array(fftSize);
  const limit = Math.min(mono.length, sampleRate * 10);
  for (let from = 0; from + size + maxLag <= limit; from += hop) {
    re.fill(0); im.fill(0);
    let energy = 0;
    for (let index = 0; index < size + maxLag && index < fftSize; index++) re[index] = mono[from + index]!;
    for (let index = 0; index < size; index++) energy += mono[from + index]! ** 2;
    if (energy / size < 1e-7) { out.push({ hz: 0, confidence: 0, at: from }); continue; }
    // Autocorrelation of the frame's first `size` samples against the whole window.
    const kernelRe = new Float64Array(fftSize); const kernelIm = new Float64Array(fftSize);
    for (let index = 0; index < size; index++) kernelRe[index] = mono[from + index]!;
    fft(re, im); fft(kernelRe, kernelIm);
    for (let bin = 0; bin < fftSize; bin++) {
      const ar = re[bin]!; const ai = im[bin]!; const br = kernelRe[bin]!; const bi = -kernelIm[bin]!;
      re[bin] = ar * br - ai * bi; im[bin] = ar * bi + ai * br;
    }
    // Inverse FFT by conjugation.
    for (let bin = 0; bin < fftSize; bin++) im[bin] = -im[bin]!;
    fft(re, im);
    const r = (lag: number) => re[lag]! / fftSize;
    // Energies of the shifted windows, by running sums.
    const squares = new Float64Array(size + maxLag + 1);
    for (let index = 0; index < size + maxLag; index++) squares[index + 1] = squares[index]! + mono[from + index]! ** 2;
    const window0 = squares[size]!;
    let running = 0; let best = -1; let bestValue = 1;
    const difference = new Float64Array(maxLag);
    const minLag = Math.max(2, Math.floor(sampleRate / 2000));
    for (let lag = 1; lag < maxLag; lag++) {
      const shifted = squares[lag + size]! - squares[lag]!;
      difference[lag] = window0 + shifted - 2 * r(lag);
      running += difference[lag]!;
      const normalized = difference[lag]! * lag / Math.max(1e-12, running);
      if (lag >= minLag && normalized < 0.15) {
        // The first dip under the threshold, followed to its bottom.
        let at = lag; let value = normalized; let cumulative = running;
        while (at + 1 < maxLag) {
          const nextShift = squares[at + 1 + size]! - squares[at + 1]!;
          const nextDifference = window0 + nextShift - 2 * r(at + 1);
          const nextRunning = cumulative + nextDifference;
          const nextValue = nextDifference * (at + 1) / Math.max(1e-12, nextRunning);
          if (nextValue >= value) break;
          at++; value = nextValue; cumulative = nextRunning;
        }
        best = at; bestValue = value;
        break;
      }
    }
    out.push(best > 0 ? { hz: sampleRate / best, confidence: Math.max(0, 1 - bestValue), at: from } : { hz: 0, confidence: 0, at: from });
  }
  return out;
}

function pitchMovement(voiced: { hz: number; at: number }[], hz: number): string | undefined {
  const cents = (value: number) => 1200 * Math.log2(value / hz);
  const first = voiced.slice(0, 3).map((frame) => cents(frame.hz));
  const start = first.length ? percentile(first, 0.5) : 0;
  if (Math.abs(start) >= 150) return `starts ${round(Math.abs(start) / 100, 1)} semitones ${start > 0 ? "higher" : "lower"} and settles`;
  const deviations = voiced.map((frame) => cents(frame.hz));
  const spread = percentile(deviations, 0.9) - percentile(deviations, 0.1);
  return spread > 40 ? `wavers about ${Math.round(spread / 2)} cents (vibrato or drift)` : undefined;
}

/** The partials' levels (dB below the strongest) and what they say about the waveform. */
function partials(mono: Float32Array, sampleRate: number, f0: number, steadyAt: number): SoundAnalysis["harmonics"] {
  const size = 16384;
  if (mono.length < 2048) return undefined;
  const from = Math.max(0, Math.min(steadyAt, mono.length - size));
  const re = new Float64Array(size); const im = new Float64Array(size);
  const taper = window(Math.min(size, mono.length - from), "blackman-harris");
  for (let index = 0; index < taper.length; index++) re[index] = (mono[from + index] ?? 0) * taper[index]!;
  fft(re, im);
  const magnitude = (bin: number) => Math.hypot(re[bin] ?? 0, im[bin] ?? 0);
  const binHz = sampleRate / size;
  const found: { k: number; db: number; hz: number }[] = [];
  for (let k = 1; k <= 24; k++) {
    const target = k * f0;
    if (target > sampleRate / 2 - 500) break;
    const reach = Math.max(2, Math.round(target * 0.03 / binHz));
    const center = Math.round(target / binHz);
    let peak = 0; let peakBin = center;
    for (let bin = Math.max(1, center - reach); bin <= Math.min(size / 2, center + reach); bin++) {
      const value = magnitude(bin);
      if (value > peak) { peak = value; peakBin = bin; }
    }
    found.push({ k, db: dbAmplitude(peak), hz: peakBin * binHz });
  }
  if (!found.length) return undefined;
  const strongest = Math.max(...found.map((partial) => partial.db));
  const relative = found.map((partial) => round(partial.db - strongest));
  // The floor between partials: noise, breath, grit.
  const floor: number[] = [];
  for (let k = 1; k < found.length; k++) {
    const between = Math.round(((k + 0.5) * f0) / binHz);
    if (between < size / 2) floor.push(dbAmplitude(magnitude(between)));
  }
  const noiseDb = floor.length ? round(percentile(floor, 0.5) - strongest) : -90;
  const audible = found.filter((partial) => partial.db - strongest > -50);
  const odd = audible.filter((partial) => partial.k % 2 === 1 && partial.k > 1).reduce((sum, partial) => sum + 10 ** (partial.db / 10), 0);
  const even = audible.filter((partial) => partial.k % 2 === 0).reduce((sum, partial) => sum + 10 ** (partial.db / 10), 0);
  const oddToEven = round(even > 0 ? db(odd / even) : 60);
  const slopeValue = slope(audible.map((partial) => ({ x: Math.log2(partial.k), y: partial.db - strongest })));
  const inharmonicity = round(audible.slice(1).reduce((sum, partial) => sum + Math.abs(partial.hz / (partial.k * f0) - 1), 0) / Math.max(1, audible.length - 1), 3);
  const significant = relative.filter((value) => value > -30).length;
  const shape = inharmonicity > 0.02 ? "inharmonic (FM, bell or metallic)"
    : noiseDb > -20 ? "noisy (noise, breath or heavy distortion)"
    : significant <= 2 && relative[0]! > -3 ? "sine-like (few harmonics)"
    : oddToEven > 12 ? (slopeValue < -9 ? "triangle-like (odd harmonics, falling fast)" : "square- or pulse-like (odd harmonics)")
    : slopeValue > -4 ? "bright, rich (saw-like or distorted)" : slopeValue > -8 ? "saw-like (all harmonics)" : "soft or filtered (harmonics fall fast)";
  return { partials: relative.slice(0, 16), shape, slopeDbPerOctave: round(slopeValue), oddToEven, noiseDb, inharmonicity };
}

/** How the brightness (and level) moves: a filter opening or closing, or a periodic wobble. */
function movement(mono: Float32Array, sampleRate: number, bpm?: number): SoundAnalysis["movement"] {
  const size = 1024; const hop = 256;
  const re = new Float64Array(size); const im = new Float64Array(size); const hann = window(size);
  const brightness: number[] = []; const levels: number[] = [];
  for (let from = 0; from + size <= mono.length && brightness.length < 4000; from += hop) {
    let energy = 0;
    for (let index = 0; index < size; index++) { const value = mono[from + index]!; re[index] = value * hann[index]!; im[index] = 0; energy += value * value; }
    if (energy / size < 1e-7) { brightness.push(NaN); levels.push(0); continue; }
    fft(re, im);
    let weighted = 0; let power = 0;
    for (let bin = 1; bin < size / 2; bin++) { const p = re[bin]! ** 2 + im[bin]! ** 2; weighted += bin * p; power += p; }
    brightness.push(weighted / Math.max(1e-30, power) * sampleRate / size);
    levels.push(Math.sqrt(energy / size));
  }
  const valid = brightness.map((value, index) => ({ value, index })).filter((point) => Number.isFinite(point.value));
  if (valid.length < 8) return { brightness: "too short to tell" };
  const third = Math.floor(valid.length / 3);
  const early = percentile(valid.slice(0, Math.max(1, third)).map((point) => point.value), 0.5);
  const middle = percentile(valid.slice(third, Math.max(third + 1, 2 * third)).map((point) => point.value), 0.5);
  const late = percentile(valid.slice(2 * third).map((point) => point.value), 0.5);
  const ratio = (a: number, b: number) => 12 * Math.log2(Math.max(1, a) / Math.max(1, b));
  const change = ratio(late, early);
  const brightnessText = Math.abs(change) < 2 && Math.abs(ratio(middle, early)) < 2 ? `steady, around ${Math.round(middle)} Hz`
    : middle > early * 1.25 && middle > late * 1.25 ? `opens then closes (${Math.round(early)} → ${Math.round(middle)} → ${Math.round(late)} Hz)`
    : change > 0 ? `opens over the note (${Math.round(early)} → ${Math.round(late)} Hz)` : `closes over the note (${Math.round(early)} → ${Math.round(late)} Hz)`;
  const rate = sampleRate / hop;
  const lfo = periodicity(valid.map((point) => Math.log2(Math.max(1, point.value))), rate, 0.5, 20);
  // A level's wobble means nothing in a take that's largely silence (its edges read as one).
  const silent = levels.filter((level) => level === 0).length / Math.max(1, levels.length);
  const levelLfo = silent > 0.2 ? undefined : periodicity(levels.map((level) => Math.log10(1e-6 + level)), rate, 0.5, 20);
  const chosen = lfo && (!levelLfo || lfo.strength >= levelLfo.strength) ? { ...lfo, on: "brightness (filter)" } : levelLfo ? { ...levelLfo, on: "level (tremolo or sidechain)" } : undefined;
  const note = chosen && bpm ? noteValue(chosen.hz, bpm) : undefined;
  return { brightness: brightnessText, ...(chosen && chosen.strength > 0.35 ? { lfo: { hz: round(chosen.hz, 2), on: chosen.on, depth: chosen.strength > 0.7 ? "strong" : "moderate", ...(note ? { atTempo: note } : {}) } } : {}) };
}

function periodicity(series: number[], rate: number, lowHz: number, highHz: number): { hz: number; strength: number } | undefined {
  // At least two cycles have to fit in what's there.
  lowHz = Math.max(lowHz, 2 * rate / series.length);
  if (lowHz >= highHz || series.length < 8) return undefined;
  const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
  const centered = series.map((value) => value - mean);
  const zero = centered.reduce((sum, value) => sum + value * value, 0);
  if (zero <= 1e-12) return undefined;
  const minLag = Math.max(1, Math.floor(rate / highHz)); const maxLag = Math.min(series.length - 1, Math.ceil(rate / lowHz));
  const scores = new Float64Array(maxLag + 2);
  let best = -1; let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let index = lag; index < centered.length; index++) sum += centered[index]! * centered[index - lag]!;
    scores[lag] = sum / zero * centered.length / (centered.length - lag);
    if (scores[lag]! > bestScore) { bestScore = scores[lag]!; best = lag; }
  }
  if (best <= 0) return undefined;
  // A period also repeats at twice and three times its length: prefer the shortest that scores
  // nearly as well, which is the modulation's own rate.
  for (const divisor of [4, 3, 2]) {
    const guess = Math.round(best / divisor);
    let local = -1; let localScore = 0;
    for (let lag = Math.max(minLag, guess - 2); lag <= Math.min(maxLag, guess + 2); lag++) if (scores[lag]! > localScore) { localScore = scores[lag]!; local = lag; }
    if (local > 0 && localScore >= bestScore * 0.8) { best = local; bestScore = localScore; break; }
  }
  return { hz: rate / best, strength: Math.min(1, bestScore) };
}

/** "1/8" or "1/4 triplet" for an LFO rate at a tempo, when it's close to one. */
export function noteValue(hz: number, bpm: number): string | undefined {
  const beat = bpm / 60;
  const values: [string, number][] = [["1 bar", 0.25], ["1/2", 0.5], ["1/4", 1], ["1/4 triplet", 1.5], ["1/8", 2], ["1/8 triplet", 3], ["1/16", 4], ["1/16 triplet", 6], ["1/32", 8]];
  let best: string | undefined; let bestError = 0.06;
  for (const [name, perBeat] of values) {
    const error = Math.abs(Math.log2(hz / (beat * perBeat)));
    if (error < bestError) { bestError = error; best = name; }
  }
  return best;
}
