/**
 * What a listening device wrote, made sense of: its raw 32-bit floats (left, right and Live's beat),
 * trimmed to what it recorded, cut where Live's transport ran or jumped, and placed on the Set's beats,
 * so Kumi can take exactly the part it played and hand it to the ear as an ordinary WAV.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface Capture {
  left: Float32Array;
  right: Float32Array;
  /** Live's beat as the device heard it: 0 not recorded, 1 recorded while stopped, 1–2 recorded while playing (1 + the beat's phase). */
  sync: Float32Array;
  sampleRate: number;
}

/** A stretch the transport ran through without a jump: its frames, the beat its first frame is on, and samples per beat. */
export interface Run { from: number; to: number; beat: number; samplesPerBeat: number }

/** How the device laid its floats out (Max doesn't say): channels interleaved or one after another, and the byte order. */
type Layout = { interleaved: boolean; littleEndian: boolean };

const isSync = (value: number) => value === 0 || (value >= 1 && value <= 2.000001);

/** A device's raw file, read. */
export async function readCapture(file: string, channels: number, sampleRate: number): Promise<Capture> {
  return parseCapture(await readFile(file), channels, sampleRate);
}

/** The floats as a capture: the layout whose beat channel reads as one, then trimmed to the frames recorded. */
export function parseCapture(bytes: Buffer, channels: number, sampleRate: number): Capture {
  if (channels < 3) throw new Error("A capture has left, right and the beat.");
  const frames = Math.floor(bytes.length / 4 / channels);
  if (!frames) return { left: new Float32Array(0), right: new Float32Array(0), sync: new Float32Array(0), sampleRate };
  const read = (layout: Layout, channel: number, frame: number) => {
    const index = layout.interleaved ? frame * channels + channel : channel * frames + frame;
    return layout.littleEndian ? bytes.readFloatLE(index * 4) : bytes.readFloatBE(index * 4);
  };
  const layouts: Layout[] = [{ interleaved: true, littleEndian: true }, { interleaved: false, littleEndian: true }, { interleaved: true, littleEndian: false }, { interleaved: false, littleEndian: false }];
  // A few thousand frames spread over the file decide it.
  const step = Math.max(1, Math.floor(frames / 4096));
  let best = layouts[0]!; let bestScore = -1;
  for (const layout of layouts) {
    let fits = 0; let seen = 0;
    for (let frame = 0; frame < frames; frame += step) {
      seen++;
      const beat = read(layout, channels - 1, frame);
      const left = read(layout, 0, frame);
      if (isSync(beat) && Number.isFinite(left) && Math.abs(left) < 1_000) fits++;
    }
    const score = fits / Math.max(1, seen);
    if (score > bestScore) { bestScore = score; best = layout; }
  }
  // Recording starts at the buffer's start, so what follows the last recorded frame was never written.
  let last = frames - 1;
  while (last >= 0 && !(read(best, channels - 1, last) >= 1)) last--;
  const length = last + 1;
  const left = new Float32Array(length); const right = new Float32Array(length); const sync = new Float32Array(length);
  for (let frame = 0; frame < length; frame++) {
    left[frame] = read(best, 0, frame); right[frame] = read(best, 1, frame); sync[frame] = read(best, channels - 1, frame);
  }
  return { left, right, sync, sampleRate };
}

/**
 * The stretches where Live's transport ran, split where it jumped (a move of the playhead while playing).
 * `anchors` say what beat a stretch started near: the playhead Kumi jumped to, or where the Set was when
 * the device was armed; the beat's phase in the third channel makes that exact. A stretch with no anchor
 * near it is placed by the one before it.
 */
export function runs(capture: Capture, anchors: { first?: number; afterJump?: number } = {}): Run[] {
  const { sync } = capture;
  const n = sync.length;
  const playing = (frame: number) => sync[frame]! > 1 + 1e-7;
  // How far the phase moves each sample while playing: the most common step.
  const steps: number[] = [];
  for (let frame = 1; frame < n && steps.length < 20_000; frame++) {
    const delta = sync[frame]! - sync[frame - 1]!;
    if (playing(frame) && playing(frame - 1) && delta > 0 && delta < 0.01) steps.push(delta);
  }
  if (!steps.length) return [];
  steps.sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)]!;
  const tolerance = Math.max(1e-6, step * 0.35);
  const continues = (frame: number) => {
    const delta = sync[frame]! - sync[frame - 1]!;
    return Math.abs(delta - step) <= tolerance || Math.abs(delta - (step - 1)) <= tolerance
      // A phase of exactly 0 (a beat's first sample) reads as stopped: it continues when the phase before was
      // just under 1 (the beat came round). A jump that lands on a beat has some other phase before it.
      || (sync[frame] === 1 && Math.abs(sync[frame - 1]! - 2 + step) <= tolerance);
  };
  const found: Run[] = [];
  let start = -1;
  for (let frame = 0; frame <= n; frame++) {
    const on = frame < n && (playing(frame) || (sync[frame] === 1 && frame > 0 && frame + 1 < n && playing(frame - 1) && playing(frame + 1)));
    const joined = on && start >= 0 && frame > start && continues(frame);
    if (on && start < 0) { start = frame; continue; }
    if (start >= 0 && (!on || !joined)) {
      found.push({ from: start, to: frame, beat: 0, samplesPerBeat: 1 / step });
      start = on ? frame : -1;
    }
  }
  // Each stretch's first beat: its phase is exact, the whole beats come from the anchor nearest it.
  let previous: Run | undefined;
  for (const [index, run] of found.entries()) {
    const phase = sync[run.from]! - 1;
    const guess = index === 0 && anchors.first !== undefined ? anchors.first
      : index > 0 && anchors.afterJump !== undefined ? anchors.afterJump
      : previous ? previous.beat + (run.from - previous.from) / previous.samplesPerBeat
      : anchors.first ?? anchors.afterJump ?? 0;
    run.beat = Math.round(guess - phase) + phase;
    previous = run;
  }
  return found;
}

/** The frame a beat falls on within a run, or undefined when the run doesn't cover it. */
export function frameAt(run: Run, beat: number): number | undefined {
  const frame = Math.round(run.from + (beat - run.beat) * run.samplesPerBeat);
  return frame >= run.from && frame < run.to ? frame : undefined;
}

/** Part of a capture as a 32-bit float stereo WAV (what the ear reads). */
export async function writeCaptureWav(file: string, capture: Capture, from: number, to: number): Promise<void> {
  const start = Math.max(0, Math.min(capture.left.length, Math.floor(from)));
  const end = Math.max(start, Math.min(capture.left.length, Math.floor(to)));
  const frames = end - start;
  const data = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) {
    data.writeFloatLE(capture.left[start + frame]!, frame * 8);
    data.writeFloatLE(capture.right[start + frame]!, frame * 8 + 4);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1"); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(capture.sampleRate, 24); header.writeUInt32LE(capture.sampleRate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  await writeFile(file, Buffer.concat([header, data]), { mode: 0o600 });
}

/** The loudest sample of a stretch, in dBFS (-Infinity for silence): a quick "was anything there". */
export function peakDb(capture: Capture, from = 0, to = capture.left.length): number {
  let peak = 0;
  for (let frame = Math.max(0, from); frame < Math.min(to, capture.left.length); frame++) peak = Math.max(peak, Math.abs(capture.left[frame]!), Math.abs(capture.right[frame]!));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
