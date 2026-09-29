/** The signal processing Kumi's listening is built from: FFT, windows, filters, conversions. */

const tables = new Map<number, { cos: Float64Array; sin: Float64Array; reverse: Uint32Array }>();

function table(size: number) {
  let found = tables.get(size);
  if (found) return found;
  if (size < 2 || (size & (size - 1))) throw new Error("FFT size must be a power of two");
  const bits = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let index = 0; index < size; index++) {
    let value = 0;
    for (let bit = 0; bit < bits; bit++) value = (value << 1) | ((index >> bit) & 1);
    reverse[index] = value;
  }
  const cos = new Float64Array(size / 2); const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index++) { cos[index] = Math.cos(-2 * Math.PI * index / size); sin[index] = Math.sin(-2 * Math.PI * index / size); }
  found = { cos, sin, reverse };
  tables.set(size, found);
  return found;
}

/** In-place complex FFT (radix 2); `re` and `im` have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  const { cos, sin, reverse } = table(size);
  for (let index = 0; index < size; index++) {
    const other = reverse[index]!;
    if (other > index) {
      let swap = re[index]!; re[index] = re[other]!; re[other] = swap;
      swap = im[index]!; im[index] = im[other]!; im[other] = swap;
    }
  }
  for (let length = 2; length <= size; length *= 2) {
    const half = length / 2; const stride = size / length;
    for (let start = 0; start < size; start += length) {
      for (let offset = 0; offset < half; offset++) {
        const twiddle = offset * stride;
        const wr = cos[twiddle]!; const wi = sin[twiddle]!;
        const a = start + offset; const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi; const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
}

const windows = new Map<string, Float64Array>();
/** A Hann window (or Blackman–Harris, for finding partials), normalized so its sum is 1. */
export function window(size: number, kind: "hann" | "blackman-harris" = "hann"): Float64Array {
  const key = `${kind}:${size}`;
  let found = windows.get(key);
  if (found) return found;
  found = new Float64Array(size);
  let sum = 0;
  for (let index = 0; index < size; index++) {
    const phase = 2 * Math.PI * index / (size - 1);
    found[index] = kind === "hann" ? 0.5 - 0.5 * Math.cos(phase)
      : 0.35875 - 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) - 0.01168 * Math.cos(3 * phase);
    sum += found[index]!;
  }
  for (let index = 0; index < size; index++) found[index]! /= sum;
  windows.set(key, found);
  return found;
}

/** A biquad filter (transposed direct form II) with its own state. */
export class Biquad {
  private z1 = 0; private z2 = 0;
  constructor(private readonly b0: number, private readonly b1: number, private readonly b2: number, private readonly a1: number, private readonly a2: number) {}
  process(input: number): number {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    return output;
  }
}

/**
 * ITU-R BS.1770's K-weighting (a high shelf, then a high pass) at any sample rate, from the
 * analog prototypes the 48 kHz coefficients came from.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533; const gain = 3.999843853973347; let q = 0.7071752369554196;
  let k = Math.tan(Math.PI * f0 / sampleRate);
  const vh = 10 ** (gain / 20); const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf = new Biquad((vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0);
  f0 = 38.13547087602444; q = 0.5003270373238773;
  k = Math.tan(Math.PI * f0 / sampleRate);
  a0 = 1 + k / q + k * k;
  const highPass = new Biquad(1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0);
  return [shelf, highPass];
}

/**
 * 4× oversampling for true peak (BS.1770 annex 2), as a windowed-sinc polyphase filter: each call
 * takes the next sample and returns the largest magnitude among the four it stands for.
 */
export class TruePeak {
  private static readonly TAPS = 12;
  private static phases: Float64Array[] | undefined;
  private readonly history = new Float64Array(TruePeak.TAPS);
  private at = 0;
  constructor() {
    if (!TruePeak.phases) {
      const taps = TruePeak.TAPS; const factor = 4;
      TruePeak.phases = Array.from({ length: factor }, (_, phase) => {
        const coefficients = new Float64Array(taps);
        for (let tap = 0; tap < taps; tap++) {
          const x = tap - taps / 2 + 1 - phase / factor;
          const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          const hann = 0.5 + 0.5 * Math.cos(Math.PI * x / (taps / 2));
          coefficients[tap] = sinc * hann;
        }
        return coefficients;
      });
    }
  }
  /** Feed a sample; only worth calling for loud ones, since between quiet samples no peak can hide. */
  push(sample: number): void { this.history[this.at] = sample; this.at = (this.at + 1) % TruePeak.TAPS; }
  /** The largest magnitude between the last samples pushed. */
  peak(): number {
    let most = 0;
    for (const coefficients of TruePeak.phases!) {
      let sum = 0;
      for (let tap = 0; tap < TruePeak.TAPS; tap++) sum += coefficients[tap]! * this.history[(this.at + TruePeak.TAPS - 1 - tap) % TruePeak.TAPS]!;
      most = Math.max(most, Math.abs(sum));
    }
    return most;
  }
}

export const db = (power: number) => (power > 1e-20 ? 10 * Math.log10(power) : -200);
export const dbAmplitude = (amplitude: number) => (amplitude > 1e-10 ? 20 * Math.log10(amplitude) : -200);
export const round = (value: number, places = 1) => { const scale = 10 ** places; return Math.round(value * scale) / scale; };

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** "F1 −12 cents" for 43.3 Hz (A4 = 440 Hz, C4 = MIDI 60). */
export function noteOf(hz: number): { name: string; midi: number; cents: number } {
  const exact = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(exact);
  return { name: `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`, midi, cents: Math.round((exact - midi) * 100) };
}
export const PITCH_CLASSES = NOTES;

/** The value at fraction `p` (0…1) of the sorted values. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * p));
  const low = Math.floor(at); const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/** "3:05" */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
