import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaries, hearForm } from "../src/audio/structure.js";
import { listeningTools } from "../src/audio/tools.js";
import { wav } from "./fixtures/synthetic-audio.js";

const RATE = 48000;
/** A song at 120 BPM (a bar is two seconds) from sections of parts: a pad's note, hats, a kick and a bass (sines: a naive saw's resets read as clicks). */
function song(sections: { bars: number; chord: number[]; pad: number; hats?: boolean; kick?: boolean; bass?: number }[]): Float32Array {
  const total = sections.reduce((sum, section) => sum + section.bars * 2, 0);
  const out = new Float32Array(total * RATE);
  let start = 0;
  for (const section of sections) {
    const length = section.bars * 2 * RATE;
    for (let index = 0; index < length; index++) {
      const t = index / RATE; let value = 0;
      for (const hz of section.chord) value += section.pad * Math.sin(2 * Math.PI * hz * t);
      if (section.hats) { const since = t % 0.25; value += 0.06 * Math.exp(-since * 120) * (((index * 1103515245 + 12345) % 2147483648) / 1073741824 - 1); }
      if (section.kick) { const since = t % 0.5; value += 0.7 * Math.exp(-since * 18) * Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-since * 30)) * since); }
      if (section.bass) value += 0.2 * Math.sin(2 * Math.PI * section.bass * t) + 0.08 * Math.sin(4 * Math.PI * section.bass * t);
      out[start + index] = value;
    }
    start += length;
  }
  return out;
}

test("a song's form: sections where what's played and how it sounds change, in bars, with their energy, what's alike and their part in it", async () => {
  // A on the pad, then F in the break: what's played changes there, not only how loud.
  const a = [220]; const f = [174.61];
  const file = wav("form.wav", song([
    { bars: 8, chord: a, pad: 0.05, hats: true },
    { bars: 8, chord: a, pad: 0.05, hats: true, kick: true, bass: 55 },
    { bars: 8, chord: f, pad: 0.04 },
    { bars: 8, chord: a, pad: 0.05, hats: true, kick: true, bass: 55 },
  ]));
  const form = await hearForm(file, { tempo: 120 });
  assert.equal(form.tempo.from, "file"); assert.ok(Math.abs(form.tempo.bpm - 120) < 2, `heard ${form.tempo.bpm} BPM`);
  assert.equal(form.bars, 32);
  assert.deepEqual(form.sections.map((section) => [section.bar, section.bars]), [[1, 8], [9, 8], [17, 8], [25, 8]]);
  assert.deepEqual(form.sections.map((section) => section.like), ["A", "B", "C", "B"]);
  assert.deepEqual(form.sections.map((section) => section.level), ["low", "high", "low", "high"]);
  assert.deepEqual(form.sections.map((section) => section.low), ["thin", "full", "thin", "full"]);
  assert.deepEqual(form.sections.map((section) => section.role), ["intro", "peak", "break", "peak"]);
  assert.equal(form.sections[2]!.density, "sparse");
  assert.equal(form.sections[0]!.from, "0:00"); assert.equal(form.sections[1]!.from, "0:16");
  assert.match(form.summary, /^intro 8 · peak 8 · break 8 · peak 8 \(32 bars at 1\d\d(\.\d)? BPM\)$/);
  // At another tempo the bars are the same, and so is how long they'd run there.
  assert.equal((await hearForm(file, { tempo: 128 })).atSetTempo, "1:00 at the Set's 128 BPM");
  // listen hears it with form: true.
  const [listen] = listeningTools({ onEvent: () => {} });
  const heard = await listen!.execute({ file, form: true, tempo: 120 }, new AbortController().signal);
  assert.equal(heard.isError ?? false, false, heard.text);
  assert.equal((JSON.parse(heard.text) as { form: { summary: string } }).form.summary, form.summary);
});

test("section edges come from the novelty along the matrix's diagonal, snapped to four-bar phrases, never closer than four bars", () => {
  // Blocks of 7, 9 and 8 bars: the edges at 7 and 16 snap to 8 and 16.
  const blocks = [7, 9, 8]; const owner = blocks.flatMap((length, block) => Array.from({ length }, () => block));
  const matrix = owner.map((a) => owner.map((b) => (a === b ? 1 : 0.2)));
  assert.deepEqual(boundaries(matrix, owner.length), [8, 16]);
  // A steady song has none.
  assert.deepEqual(boundaries(owner.map(() => owner.map(() => 1)), owner.length), []);
});
