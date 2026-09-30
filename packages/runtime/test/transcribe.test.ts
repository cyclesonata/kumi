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

test("transcribed notes reach the model as rows in beats at the Set's tempo, to a 16th, with what's played most", async () => {
  const { transcription } = await import("../src/audio/tools.js");
  const rows = transcription([{ time: 0.52, duration: 0.24, midi: 60, velocity: 100, confidence: 0.9 }, { time: 1.01, duration: 0.1, midi: null, velocity: 80, confidence: 0 }, { time: 1.49, duration: 0.5, midi: 60, velocity: 90, confidence: 0.9 }], 120);
  assert.deepEqual(rows.rows, [[1, 60, 100, 0.5], [2, null, 80, 0.25], [3, 60, 90, 1]]);
  assert.equal(rows.pitched, 2); assert.equal(rows.unpitched, 1);
  assert.deepEqual(rows.mostPlayed, [{ midi: 60, count: 2 }]);
  assert.match(String(rows.unit), /beats at 120 BPM/);
});
