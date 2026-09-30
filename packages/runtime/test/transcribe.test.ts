import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeFile } from "../src/audio/analyze.js";
import { wav } from "./fixtures/synthetic-audio.js";

const RATE = 48000;
/** Plucked saw notes: [time s, MIDI, amplitude], each 0.2 s with a quick decay. */
function notes(list: [number, number, number][], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const [time, midi, amplitude] of list) {
    const hz = 440 * 2 ** ((midi - 69) / 12); const from = Math.round(time * RATE);
    for (let index = 0; index < Math.round(0.2 * RATE) && from + index < out.length; index++) {
      const phase = (index * hz / RATE) % 1;
      out[from + index]! += amplitude * (2 * phase - 1) * Math.exp(-index / (0.08 * RATE)) * Math.min(1, index / 48);
    }
  }
  return out;
}

test("the notes in a part are transcribed: when each starts, its pitch, and how hard against the loudest", async () => {
  const played: [number, number, number][] = [[0.1, 60, 0.5], [0.4, 64, 0.5], [0.7, 67, 0.25], [1.0, 72, 0.5], [1.3, 48, 0.5], [1.6, 60, 0.12]];
  const analysis = await analyzeFile(wav("transcribe.wav", notes(played, 2.2)), { focus: "mix", transcribe: true });
  const heard = analysis.notes!;
  assert.equal(heard.length, played.length, JSON.stringify(heard));
  for (const [index, [time, midi]] of played.entries()) {
    assert.ok(Math.abs(heard[index]!.time - time) < 0.03, `note ${index} at ${heard[index]!.time} s, played at ${time} s`);
    assert.equal(heard[index]!.midi, midi, `note ${index}`);
  }
  assert.ok(heard[2]!.velocity < heard[1]!.velocity && heard[5]!.velocity < heard[2]!.velocity, "quieter notes are softer");
  assert.ok(heard.every((note) => note.duration > 0.05 && note.duration < 0.3), JSON.stringify(heard.map((note) => note.duration)));
  // The timeline: onsets and level at a fine step, with its peaks where the notes start.
  const timeline = analysis.timeline!;
  const peak = (time: number) => Math.max(...timeline.onset.slice(Math.max(0, Math.round(time / timeline.step) - 3), Math.round(time / timeline.step) + 4));
  assert.ok(played.every(([time]) => peak(time) > 0.2));
});

test("transcribed notes reach the model as rows in beats at the Set's tempo, as played (not snapped to the grid), with what's played most", async () => {
  const { transcription } = await import("../src/audio/tools.js");
  const rows = transcription([{ time: 0.52, duration: 0.24, midi: 60, velocity: 100, confidence: 0.9 }, { time: 1.01, duration: 0.1, midi: null, velocity: 80, confidence: 0 }, { time: 1.49, duration: 0.5, midi: 60, velocity: 90, confidence: 0.9 }], 120);
  assert.deepEqual(rows.rows, [[1.04, 60, 100, 0.48], [2.02, null, 80, 0.2], [2.98, 60, 90, 1]]);
  assert.equal(rows.pitched, 2); assert.equal(rows.unpitched, 1);
  assert.deepEqual(rows.mostPlayed, [{ midi: 60, count: 2 }]);
  assert.match(String(rows.unit), /beats at 120 BPM/);
});

test("a dense line of 16ths at varied velocities is transcribed note for note, a note at the very start too", async () => {
  // 120 BPM 16ths (0.125 s apart), velocities from loud to soft, some steps skipped.
  const steps = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 13, 15];
  const played: [number, number, number][] = steps.map((step, index) => [step * 0.125, [62, 65, 69, 62, 70, 67][index % 6]!, [0.5, 0.2, 0.35, 0.15, 0.45, 0.25][index % 6]!]);
  const analysis = await analyzeFile(wav("transcribe-dense.wav", notes(played, 2.3)), { focus: "mix", transcribe: true });
  const heard = analysis.notes!;
  const found = played.filter(([time]) => heard.some((note) => Math.abs(note.time - time) < 0.03)).length;
  assert.ok(found >= played.length - 1, `found ${found} of ${played.length}: ${JSON.stringify(heard.map((note) => [note.time, note.midi]))}`);
  assert.ok(heard.length <= played.length + 1, "no ghost notes");
});
