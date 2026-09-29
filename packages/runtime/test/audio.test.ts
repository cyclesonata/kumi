import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeFile, noteValue } from "../src/audio/analyze.js";
import { openAudio } from "../src/audio/decode.js";
import { hear } from "../src/audio/index.js";
import { execFileSync } from "node:child_process";

const RATE = 48000;
const folder = mkdtempSync(join(tmpdir(), "kumi-audio-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

/** A WAV file of the given channels: 16-bit PCM, 24-bit PCM or 32-bit float. */
function wav(name: string, channels: Float32Array[], options: { rate?: number; bits?: 16 | 24 | 32 } = {}): string {
  const rate = options.rate ?? RATE; const bits = options.bits ?? 16; const float = bits === 32;
  const frames = channels[0]!.length; const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels.length * bytes);
  let at = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const value = Math.max(-1, Math.min(1, channel[frame]!));
      if (float) data.writeFloatLE(value, at);
      else if (bits === 16) data.writeInt16LE(Math.round(value * 32767), at);
      else data.writeIntLE(Math.round(value * 8388607), at, 3);
      at += bytes;
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1"); header.writeUInt32LE(16, 16); header.writeUInt16LE(float ? 3 : 1, 20); header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels.length * bytes, 28); header.writeUInt16LE(channels.length * bytes, 32); header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  const path = join(folder, name);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

/** The same as a 16-bit AIFF (big-endian, 80-bit float sample rate). */
function aiff(name: string, channels: Float32Array[], rate = RATE): string {
  const frames = channels[0]!.length;
  const data = Buffer.alloc(frames * channels.length * 2);
  let at = 0;
  for (let frame = 0; frame < frames; frame++) for (const channel of channels) { data.writeInt16BE(Math.round(channel[frame]! * 32767), at); at += 2; }
  const comm = Buffer.alloc(26);
  comm.write("COMM", 0, "latin1"); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(channels.length, 8); comm.writeUInt32BE(frames, 10); comm.writeUInt16BE(16, 14);
  // 48000 as an 80-bit extended float.
  const exponent = Math.floor(Math.log2(rate)); const mantissa = rate / 2 ** exponent;
  comm.writeUInt16BE(16383 + exponent, 16); comm.writeUInt32BE(Math.floor(mantissa * 2 ** 31), 18); comm.writeUInt32BE(0, 22);
  const ssnd = Buffer.alloc(16);
  ssnd.write("SSND", 0, "latin1"); ssnd.writeUInt32BE(8 + data.length, 4); ssnd.writeUInt32BE(0, 8); ssnd.writeUInt32BE(0, 12);
  const body = Buffer.concat([Buffer.from("AIFF", "latin1"), comm, ssnd, data]);
  const head = Buffer.alloc(8); head.write("FORM", 0, "latin1"); head.writeUInt32BE(body.length, 4);
  const path = join(folder, name);
  writeFileSync(path, Buffer.concat([head, body]));
  return path;
}

const seconds = (value: number) => Math.round(value * RATE);
function tone(length: number, hz: number, amplitude: number, harmonics: (k: number) => number = (k) => (k === 1 ? 1 : 0)): Float32Array {
  const out = new Float32Array(length);
  const partials = Array.from({ length: 40 }, (_, index) => index + 1).filter((k) => k * hz < RATE / 2 - 1000 && harmonics(k) !== 0);
  for (let index = 0; index < length; index++) {
    let value = 0;
    for (const k of partials) value += harmonics(k) * Math.sin(2 * Math.PI * k * hz * index / RATE);
    out[index] = value * amplitude;
  }
  return out;
}
const saw = (k: number) => 1 / k;
const square = (k: number) => (k % 2 === 1 ? 1 / k : 0);

test("a stereo 1 kHz sine at −20 dBFS reads −20 LUFS, one band, fully correlated", async () => {
  const sine = tone(seconds(8), 1000, 0.1);
  const result = await analyzeFile(wav("sine-1k.wav", [sine, sine]), { focus: "mix" });
  assert.ok(Math.abs(result.loudness.integratedLufs! + 20) < 0.3, `integrated ${result.loudness.integratedLufs}`);
  assert.ok(Math.abs(result.loudness.truePeakDbtp + 20) < 0.3, `true peak ${result.loudness.truePeakDbtp}`);
  assert.ok((result.loudness.rangeLu ?? 0) < 0.5, "a steady tone has no loudness range");
  // 1 kHz sits on the line between mids and upper mids: all its energy is in those two.
  const near = result.balance.bands.filter((band) => band.name === "mids" || band.name === "upper mids").reduce((sum, band) => sum + 10 ** (band.db / 10), 0);
  assert.ok(10 * Math.log10(near) > -0.2, "nearly all energy at 1 kHz");
  assert.equal(result.stereo?.correlation, 1); assert.equal(result.stereo?.width, 0); assert.equal(result.stereo?.lowEndMono, true);
  assert.equal(result.spectrogram.rows.length, 10);
  assert.ok(result.spectrogram.rows.some((row) => /^9+$/.test(row.cells)), "one steady loudest row");
});

test("out-of-phase channels read as negative correlation and wide", async () => {
  const left = tone(seconds(3), 300, 0.3); const right = Float32Array.from(left, (value) => -value);
  const result = await analyzeFile(wav("phase.wav", [left, right]), { focus: "mix" });
  assert.ok(result.stereo!.correlation < -0.95, `correlation ${result.stereo!.correlation}`);
  assert.ok(result.balance.bands.find((band) => band.name === "upper bass")!.width > 0.95);
});

test("a saw, a square and a sine are told apart, with their pitch", async () => {
  const sawNote = await analyzeFile(wav("saw-a2.wav", [tone(seconds(1.5), 110, 0.3, saw)]));
  assert.equal(sawNote.analyzed.focus, "sound");
  assert.equal(sawNote.sound?.pitch?.note, "A2"); assert.ok(Math.abs(sawNote.sound!.pitch!.hz - 110) < 1);
  assert.match(sawNote.sound!.harmonics!.shape, /saw/); assert.ok(Math.abs(sawNote.sound!.harmonics!.slopeDbPerOctave + 6) < 1.5, `slope ${sawNote.sound!.harmonics!.slopeDbPerOctave}`);
  const squareNote = await analyzeFile(wav("square-a3.wav", [tone(seconds(1.5), 220, 0.3, square)]));
  assert.equal(squareNote.sound?.pitch?.note, "A3"); assert.match(squareNote.sound!.harmonics!.shape, /square|pulse/);
  const sineNote = await analyzeFile(wav("sine-e4.wav", [tone(seconds(1.5), 329.63, 0.3)]));
  assert.equal(sineNote.sound?.pitch?.note, "E4"); assert.match(sineNote.sound!.harmonics!.shape, /sine/);
  const lowNote = await analyzeFile(wav("saw-f1.wav", [tone(seconds(2), 43.65, 0.3, saw)]));
  assert.equal(lowNote.sound?.pitch?.note, "F1", "a sub-bass note");
});

test("noise has no pitch; a shaped note has its envelope measured", async () => {
  const noise = Float32Array.from({ length: seconds(1) }, () => (Math.random() * 2 - 1) * 0.3);
  const hiss = await analyzeFile(wav("noise.wav", [noise]));
  assert.equal(hiss.sound?.pitch, undefined);
  // 40 ms attack, 200 ms decay to half, held, then a 300 ms release.
  const length = seconds(1.5); const shaped = tone(length, 220, 0.5, saw);
  for (let index = 0; index < length; index++) {
    const t = index / RATE;
    const level = t < 0.04 ? t / 0.04 : t < 0.24 ? 1 - 0.5 * (t - 0.04) / 0.2 : t < 1.2 ? 0.5 : Math.max(0, 0.5 * (1 - (t - 1.2) / 0.3));
    shaped[index]! *= level;
  }
  const note = await analyzeFile(wav("adsr.wav", [shaped]));
  const envelope = note.sound!.envelope;
  assert.ok(envelope.attackMs >= 20 && envelope.attackMs <= 60, `attack ${envelope.attackMs}`);
  assert.ok(Math.abs(envelope.sustainDb + 6) < 1.5, `sustain ${envelope.sustainDb}`);
  assert.ok(envelope.decayMs >= 100 && envelope.decayMs <= 300, `decay ${envelope.decayMs}`);
  assert.ok(envelope.releaseMs >= 150 && envelope.releaseMs <= 400, `release ${envelope.releaseMs}`);
});

test("a wobble's rate is heard as a filter LFO, and named at the tempo", async () => {
  const length = seconds(3); const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const t = index / RATE; const open = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    let value = 0;
    for (let k = 1; k <= 30; k++) value += (k <= 2 ? 1 : open) / k * Math.sin(2 * Math.PI * k * 55 * t);
    out[index] = value * 0.2;
  }
  const result = await analyzeFile(wav("wobble.wav", [out]));
  const lfo = result.sound!.movement.lfo;
  assert.ok(lfo, "a wobble");
  assert.ok(Math.abs(lfo.hz - 4) < 0.3, `rate ${lfo.hz}`); assert.match(lfo.on, /brightness/);
  assert.equal(noteValue(4, 120), "1/8");
  assert.equal(noteValue(3, 120), "1/4 triplet"); assert.equal(noteValue(6, 120), "1/8 triplet"); assert.equal(noteValue(5.1, 120), undefined, "between note values");
});

test("clicks at 128 BPM give the tempo; C major material gives the key", async () => {
  const length = seconds(16); const beats = new Float32Array(length);
  const every = RATE * 60 / 128;
  for (let beat = 0; beat * every < length; beat++) {
    const at = Math.round(beat * every);
    for (let index = 0; index < 2000 && at + index < length; index++) beats[at + index] = Math.exp(-index / 300) * Math.sin(2 * Math.PI * 60 * index / RATE) * 0.8;
  }
  const drums = await analyzeFile(wav("clicks-128.wav", [beats, beats]), { focus: "mix" });
  assert.ok(drums.tempo && Math.abs(drums.tempo.bpm - 128) < 1.5, `tempo ${JSON.stringify(drums.tempo)}`);
  assert.ok(drums.dynamics.onsetsPerSecond > 1.5 && drums.dynamics.onsetsPerSecond < 3, `onsets ${drums.dynamics.onsetsPerSecond}`);
  // C, E, G and a little F and A: a I–IV–V feel.
  const notes = [261.63, 329.63, 392.0, 261.63, 349.23, 440.0, 392.0, 493.88, 293.66, 261.63, 329.63, 392.0];
  const song = new Float32Array(seconds(12));
  notes.forEach((hz, index) => {
    const from = seconds(index); const part = tone(seconds(1), hz, 0.2, (k) => (k <= 3 ? 1 / k : 0));
    const bass = tone(seconds(1), [130.81, 174.61, 196.0][index % 3]!, 0.15);
    for (let offset = 0; offset < part.length; offset++) song[from + offset] = part[offset]! + bass[offset]!;
  });
  const keyed = await analyzeFile(wav("c-major.wav", [song, song]), { focus: "mix" });
  assert.equal(keyed.key?.name, "C major");
});

test("WAV (16-bit, 24-bit, float) and AIFF decode to the same samples; other files are refused plainly", async () => {
  const sine = tone(seconds(0.5), 440, 0.5);
  for (const [name, path] of [["16", wav("d16.wav", [sine], { bits: 16 })], ["24", wav("d24.wav", [sine], { bits: 24 })], ["float", wav("dfloat.wav", [sine], { bits: 32 })], ["aiff", aiff("d16.aiff", [sine])]] as const) {
    const source = await openAudio(path);
    assert.equal(source.sampleRate, RATE, name); assert.equal(source.channels, 1, name); assert.equal(source.frames, sine.length, name);
    const block = await source.read(1000);
    assert.ok(Math.abs(block![0]![100]! - sine[100]!) < 1e-3, `${name}: ${block![0]![100]} vs ${sine[100]}`);
    await source.close();
  }
  writeFileSync(join(folder, "notes.txt"), "hello");
  await assert.rejects(openAudio(join(folder, "notes.txt")), /isn't an audio format/);
  writeFileSync(join(folder, "fake.wav"), "not a wav file at all");
  await assert.rejects(openAudio(join(folder, "fake.wav")), /doesn't look like WAV or AIFF/);
  await assert.rejects(openAudio(join(folder, "missing.wav")), /no file there/);
});

test("a song-length file is analyzed quickly, part by part", async () => {
  // Long enough to need many blocks; short enough not to crowd other tests' timing on CI.
  const length = seconds(75);
  const left = new Float32Array(length); const right = new Float32Array(length);
  for (let index = 0; index < length; index++) { const noise = Math.random() * 2 - 1; left[index] = noise * 0.2; right[index] = (noise * 0.7 + (Math.random() * 2 - 1) * 0.3) * 0.2; }
  const path = wav("long.wav", [left, right]);
  const started = performance.now();
  const result = await analyzeFile(path);
  const ms = performance.now() - started;
  assert.equal(result.analyzed.focus, "mix");
  assert.equal(result.spectrogram.rows[0]!.cells.length, 24);
  assert.equal(result.overTime.lufs.length, 16);
  assert.ok(ms < 6000, `75 seconds took ${Math.round(ms)} ms`);
  const part = await analyzeFile(path, { start: 30, seconds: 30 });
  assert.equal(part.analyzed.from, "0:30"); assert.equal(part.analyzed.to, "1:00");
});

test("the listen tool hears a file, or sets it against a reference with loudness matched, and tells the app", async () => {
  const { listeningTools } = await import("../src/audio/tools.js");
  const events: unknown[] = [];
  const [listen] = listeningTools({ onEvent: (event) => events.push(event) });
  const signal = new AbortController().signal;
  // A "mix" with extra low mids against a flatter "reference", 12 dB quieter.
  const length = seconds(8);
  const bright = Float32Array.from({ length }, () => (Math.random() * 2 - 1) * 0.25);
  const lowMids = tone(length, 350, 0.3);
  const mix = Float32Array.from(bright, (value, index) => (value + lowMids[index]!) * 0.25);
  const mine = wav("mine.wav", [mix, mix]); const reference = wav("reference.wav", [bright, bright]);
  const alone = JSON.parse((await listen!.execute({ file: mine, focus: "mix" }, signal)).text) as { kumiAudio: number; loudness: { integratedLufs: number } };
  assert.equal(alone.kumiAudio, 1); assert.ok(alone.loudness.integratedLufs < -10);
  const result = await listen!.execute({ file: mine, compare_to: reference, focus: "mix" }, signal);
  const body = JSON.parse(result.text) as { comparison: { headlines: string[]; balance: { band: string; difference: number }[]; loudness: { differenceLu: number } } };
  assert.ok(body.comparison.balance.find((band) => band.band === "low mids")!.difference > 3, "the extra low mids show, loudness-matched");
  assert.match(body.comparison.headlines.join(" | "), /low mids \(250–500 Hz\) \+\d+\.\d dB over the reference/);
  assert.match(body.comparison.headlines.join(" | "), /LU quieter overall/);
  assert.equal(events.length, 2);
  const heard = events[1] as { type: string; compared: { reference: string; differences: number[] } };
  assert.equal(heard.type, "heard"); assert.equal(heard.compared.reference, "reference.wav"); assert.equal(heard.compared.differences.length, 10);
  const missing = await listen!.execute({ file: join(folder, "nowhere.wav") }, signal);
  assert.equal(missing.isError, true); assert.match(missing.text, /no file there/);
});

test("stopping a listen while a format is being converted stops the converter and leaves no copy behind", { skip: process.platform !== "darwin" && "afconvert makes the M4A here" }, async () => {
  const source = wav("long.wav", [tone(RATE * 90, 110, 0.3)]);
  const m4a = join(folder, "long.m4a");
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", source, m4a]);
  const copies = () => readdirSync(tmpdir()).filter((name) => name.startsWith("kumi-audio-") && !name.startsWith("kumi-audio-test-")).sort();
  const before = copies();
  const stop = new AbortController();
  const listening = hear(m4a, { signal: stop.signal });
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(listening);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(copies(), before, "the converted copy is gone");
  const finished = await hear(m4a, {});
  assert.equal(finished.file, "long.m4a", "named as the producer's file, not the converted copy");
  assert.equal(finished.format, "m4a");
  assert.deepEqual(copies(), before, "and gone after a listen that finished too");
});
