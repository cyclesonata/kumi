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
