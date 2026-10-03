/**
 * What a listening device wrote, made sense of: its raw 32-bit floats (left, right, the beat's phase and
 * Live's position), trimmed to what it recorded, cut where Live's transport ran or jumped, and placed on
 * the Set's beats, so Kumi can take exactly the part it played and hand it to the ear as an ordinary WAV.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface Capture {
  left: Float32Array;
  right: Float32Array;
  /** Live's beat as the device heard it: 0 not recorded, 1 recorded while stopped, 1–2 recorded while playing (1 + the beat's phase). */
  sync: Float32Array;
  /** Live's position in beats, as the device polled it (a few milliseconds behind); from a device that records it. */
  position?: Float32Array;
  sampleRate: number;
}

/** A stretch the transport ran through without a jump: its frames, the beat its first frame is on, and samples per beat. */
export interface Run { from: number; to: number; beat: number; samplesPerBeat: number }

/** How the device laid its floats out (Max doesn't say): channels interleaved or one after another, and the byte order. */
type Layout = { interleaved: boolean; littleEndian: boolean };

const isSync = (value: number) => value === 0 || (value >= 1 && value <= 2.000001);
/** The shortest stretch worth keeping, in frames. */
const MIN_RUN = 64;

/** A device's raw file, read. */
export async function readCapture(file: string, channels: number, sampleRate: number): Promise<Capture> {
  return parseCapture(await readFile(file), channels, sampleRate);
}

/** The floats as a capture: the layout whose beat channel reads as one, then trimmed to the frames recorded. */
export function parseCapture(bytes: Buffer, channels: number, sampleRate: number): Capture {
  if (channels < 3) throw new Error("A capture has left, right and the beat.");
  // The beat's phase is the third channel; Live's position, when there's a fourth.
  const BEAT = 2; const WHERE = channels >= 4 ? 3 : undefined;
  const frames = Math.floor(bytes.length / 4 / channels);
  if (!frames) return { left: new Float32Array(0), right: new Float32Array(0), sync: new Float32Array(0), ...(WHERE !== undefined ? { position: new Float32Array(0) } : {}), sampleRate };
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
      const beat = read(layout, BEAT, frame);
      const left = read(layout, 0, frame);
      const where = WHERE !== undefined ? read(layout, WHERE, frame) : 0;
      if (isSync(beat) && Number.isFinite(left) && Math.abs(left) < 1_000 && Number.isFinite(where) && Math.abs(where) < 1e7) fits++;
    }
    const score = fits / Math.max(1, seen);
    if (score > bestScore) { bestScore = score; best = layout; }
  }
  // Recording starts at the buffer's start, so what follows the last recorded frame was never written.
  let last = frames - 1;
  while (last >= 0 && !(read(best, BEAT, last) >= 1)) last--;
  const length = last + 1;
  const left = new Float32Array(length); const right = new Float32Array(length); const sync = new Float32Array(length);
  const position = WHERE !== undefined ? new Float32Array(length) : undefined;
  for (let frame = 0; frame < length; frame++) {
    left[frame] = read(best, 0, frame); right[frame] = read(best, 1, frame); sync[frame] = read(best, BEAT, frame);
    if (position) position[frame] = read(best, WHERE!, frame);
  }
  return { left, right, sync, ...(position ? { position } : {}), sampleRate };
}

/**
 * The stretches where Live's transport ran, split where it jumped (a move of the playhead while playing).
 * A capture with Live's position places each stretch by it, and splits where it says Live jumped on a beat
 * (Live waits for its launch quantization, so the phase alone often can't show the jump). Without it,
 * `anchors` say what beat a stretch started near: the playhead Kumi jumped to, or where the Set was when
 * the device was armed; the beat's phase makes that exact. A stretch with no anchor near it is placed by
 * the one before it.
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
      // A few frames aren't a stretch: once stopped, the beat holds where it stopped and no frame follows from the last.
      if (frame - start >= MIN_RUN) found.push({ from: start, to: frame, beat: 0, samplesPerBeat: 1 / step });
      start = on ? frame : -1;
    }
  }
  // How long a beat is, measured where the phase comes round (the step between two samples is too coarse in
  // 32-bit floats: a fraction of a percent, milliseconds over a bar).
  const measured = found.map((run) => beatLength(sync, run.from, run.to)).filter((length): length is number => length !== undefined);
  const typical = measured.length ? measured.sort((a, b) => a - b)[Math.floor(measured.length / 2)]! : 1 / step;
  for (const run of found) run.samplesPerBeat = beatLength(sync, run.from, run.to) ?? typical;
  if (capture.position) return found.flatMap((run) => placed(capture, run));
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

/** Samples per beat in a stretch, from where its phase comes round (to a fraction of a sample); undefined with fewer than two. */
function beatLength(sync: Float32Array, from: number, to: number): number | undefined {
  let first: number | undefined; let last = 0; let count = 0;
  for (let frame = from + 1; frame < to; frame++) {
    const before = sync[frame - 1]!; const after = sync[frame]!;
    if (after >= before) continue;
    // Where the phase reached 1, between the two samples.
    const rise = after + 1 - before;
    const at = frame - 1 + (rise > 0 ? (2 - before) / rise : 0);
    first ??= at; last = at; count++;
  }
  return first !== undefined && count >= 2 ? (last - first) / (count - 1) : undefined;
}

/** How far behind Live the polled position may be, at most, in seconds; and how long it must agree to count. */
const POSITION_LAG = 0.06;
const AGREED = 0.06;

/**
 * A stretch placed by Live's position: every 10 ms the position (rounded to the beat the phase is in) says
 * what beat the stretch started on. Where that changes and stays changed, Live jumped: on the last beat
 * before the position caught up (where the phase came round), or where it caught up when no beat was there.
 * A while that doesn't agree long enough (the position catching up after a jump the phase showed) goes with
 * the part after it.
 */
function placed(capture: Capture, run: Run): Run[] {
  const { sync, sampleRate } = capture; const position = capture.position!;
  const hop = Math.max(1, Math.round(sampleRate / 100));
  const perBeat = run.samplesPerBeat;
  const samples: { frame: number; first: number }[] = [];
  for (let frame = run.from; frame < run.to; frame += hop) {
    const phase = Math.max(0, sync[frame]! - 1);
    samples.push({ frame, first: Math.round(position[frame]! - phase) + phase - (frame - run.from) / perBeat });
  }
  // Samples in a row that agree; only those long enough count.
  const groups: { from: number; to: number; first: number }[] = [];
  for (const [index, sample] of samples.entries()) {
    const last = groups.at(-1);
    if (last && Math.abs(sample.first - last.first) < 0.02) last.to = index + 1;
    else groups.push({ from: index, to: index + 1, first: sample.first });
  }
  const steady = groups.filter((group) => (group.to - group.from) * hop >= AGREED * sampleRate);
  const found: Run[] = [];
  let from = run.from;
  for (const [index, group] of steady.entries()) {
    const next = steady[index + 1];
    let to = run.to;
    if (next) {
      const caughtUp = samples[next.from]!.frame;
      to = caughtUp;
      for (let frame = caughtUp; frame > Math.max(from + 1, caughtUp - POSITION_LAG * sampleRate); frame--) if (sync[frame]! < sync[frame - 1]!) { to = frame; break; }
    }
    if (to - from >= MIN_RUN) found.push({ from, to, beat: group.first + (from - run.from) / perBeat, samplesPerBeat: perBeat });
    from = to;
  }
  return found;
}

/** Max's beat ramp reads 0 for its first signal vector after Live starts or jumps (64 samples; at most this). */
const FIRST_VECTOR = 256;

/**
 * The frame a beat falls on within a run, or undefined when the run doesn't cover it. A run's first signal
 * vector (where the ramp read 0) is Live playing too, so a beat just before the run's start is found there.
 */
export function frameAt(run: Run, beat: number): number | undefined {
  const frame = Math.round(run.from + (beat - run.beat) * run.samplesPerBeat);
  return frame >= Math.max(0, run.from - FIRST_VECTOR) && frame < run.to ? frame : undefined;
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
