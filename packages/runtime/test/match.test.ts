import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeFile } from "../src/audio/analyze.js";
import { closeness } from "../src/audio/match.js";
import { noise, pattern, saw, wav } from "./fixtures/synthetic-audio.js";


test("the same sound against itself is ~100%; a tone against noise is low; the same tone darkened is in between", async () => {
  const bright = await analyzeFile(wav("bright.wav", saw(3, 110)), { focus: "sound" });
  const again = await analyzeFile(wav("again.wav", saw(3, 110)), { focus: "sound" });
  const dark = await analyzeFile(wav("dark.wav", saw(3, 110, 700)), { focus: "sound" });
  const hiss = await analyzeFile(wav("hiss.wav", noise(3)), { focus: "sound" });
  const self = closeness(bright, again);
  const darker = closeness(dark, bright);
  const unlike = closeness(hiss, bright);
  assert.ok(self.score >= 97, `self ${self.score}`);
  assert.ok(unlike.score <= 45, `noise ${unlike.score}`);
  assert.ok(darker.score > unlike.score + 10 && darker.score < self.score - 10, `darker ${darker.score} between ${unlike.score} and ${self.score}`);
  assert.equal(self.gaps.length, 0, "nothing to change");
  assert.match(darker.gaps.join(" · "), /darker|brighten/, "says which way to go");
  assert.ok(darker.features.every((feature) => feature.similarity >= 0 && feature.similarity <= 100));
});

test("a section is judged on density and rhythm too: the same part is close, one four times as dense less so", async () => {
  const part = await analyzeFile(wav("part.wav", pattern(8, 0.5)), { focus: "mix" });
  const same = await analyzeFile(wav("same.wav", pattern(8, 0.5)), { focus: "mix" });
  const busy = await analyzeFile(wav("busy.wav", pattern(8, 0.125)), { focus: "mix" });
  const close = closeness(same, part, "section");
  const dense = closeness(busy, part, "section");
  assert.equal(close.focus, "section");
  assert.ok(close.score >= 95, `same part ${close.score}`);
  assert.ok(dense.score < close.score - 10, `denser ${dense.score}`);
  assert.ok(dense.features.find((feature) => feature.name === "density")!.similarity < 60);
  assert.match(dense.gaps.join(" · "), /too dense/);
});

test("a gap no knob closes is named with the structure that closes it: a missing sub asks for a sub layer", async () => {
  const withSub = saw(3, 110).map((value, index) => value + 0.5 * Math.sin(2 * Math.PI * 41.2 * index / 48000));
  const reference = await analyzeFile(wav("with-sub.wav", withSub), { focus: "sound" });
  const mine = await analyzeFile(wav("no-sub.wav", saw(3, 110)), { focus: "sound" });
  const result = closeness(mine, reference);
  assert.equal(result.structural?.kind, "missing-low", JSON.stringify(result));
  assert.match(result.structural!.move, /sub layer/);
  assert.equal(closeness(mine, mine).structural, undefined, "nothing to change against itself");
});

test("a section's timing counts: the same sound in another rhythm scores lower, and a part that builds up against one that doesn't is named", async () => {
  const hit = saw(0.08, 110).map((value, index) => value * Math.exp(-index / (0.02 * 48000)));
  const place = (times: number[], seconds: number, gain = (_time: number) => 1) => {
    const out = new Float32Array(Math.round(seconds * 48000));
    for (const time of times) { const from = Math.round(time * 48000); hit.forEach((value, index) => { if (from + index < out.length) out[from + index]! += value * gain(time); }); }
    return out;
  };
  const straight = Array.from({ length: 16 }, (_, index) => index * 0.25);
  const other = straight.map((time, index) => time + (index % 2 ? 0.125 : 0));
  const reference = await analyzeFile(wav("rhythm-ref.wav", place(straight, 4.2)), { focus: "mix" });
  const same = closeness(await analyzeFile(wav("rhythm-same.wav", place(straight, 4.2)), { focus: "mix" }), reference, "section");
  const shifted = closeness(await analyzeFile(wav("rhythm-shifted.wav", place(other, 4.2)), { focus: "mix" }), reference, "section");
  const rhythm = (result: typeof same) => result.features.find((feature) => feature.name === "rhythm")!.similarity;
  assert.ok(rhythm(same) > 90 && rhythm(shifted) < rhythm(same) - 20, `rhythm ${rhythm(same)} against ${rhythm(shifted)}`);
  assert.ok(shifted.score < same.score);
  // A swell against a level part.
  const swell = await analyzeFile(wav("contour-swell.wav", place(straight, 4.2, (time) => 0.05 + time / 4)), { focus: "mix" });
  const level = closeness(await analyzeFile(wav("contour-level.wav", place(straight, 4.2, () => 0.5)), { focus: "mix" }), swell, "section");
  assert.match(level.gaps.join(" "), /the reference builds up over time/);
});
