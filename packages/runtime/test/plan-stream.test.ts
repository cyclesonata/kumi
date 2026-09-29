import assert from "node:assert/strict";
import { test } from "node:test";
import { stepScanner } from "../src/integrations/ableton/plan-stream.js";

const plan = {
  final: true,
  steps: [
    { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Pads {wide} [A]", kind: "midi" }], scenes: [] }, as: "pads" },
    { tool: "rename", input: { kind: "track", ref: "track:1", name: "Say \"hi\" \\ bye }]" } },
    { tool: "load_sample_to_pad", input: { deviceRef: "@rack", sample: { random: true, folders: ["/Samples/Kicks"] } }, each: { note: [36, 37, 38] } },
  ],
  note: "after",
};

function scan(text: string, sizes: number[]) {
  const steps: unknown[] = [];
  const push = stepScanner((step) => steps.push(step));
  let at = 0;
  for (let index = 0; at < text.length; index++) { const size = sizes[index % sizes.length]!; push(text.slice(at, at + size)); at += size; }
  return steps;
}

test("a plan's steps are picked out whole as the model writes them, however its text is split", () => {
  for (const text of [JSON.stringify(plan), JSON.stringify(plan, null, 2)]) {
    for (const sizes of [[1], [2, 3], [7], [64], [text.length]]) assert.deepEqual(scan(text, sizes), plan.steps, `chunks of ${sizes.join("/")}`);
  }
});

test("each step is handed on as soon as it closes, not when the plan does", () => {
  const seen: unknown[] = [];
  const push = stepScanner((step) => seen.push(step));
  const text = JSON.stringify({ steps: plan.steps.slice(0, 2) });
  const firstEnds = text.indexOf("}", text.indexOf("\"as\":\"pads\"")) + 1;
  push(text.slice(0, firstEnds - 1));
  assert.equal(seen.length, 0, "not before its closing brace");
  push(text.slice(firstEnds - 1, firstEnds));
  assert.deepEqual(seen, [plan.steps[0]]);
  push(text.slice(firstEnds));
  assert.deepEqual(seen, plan.steps.slice(0, 2));
});

test("only the top-level steps count, and text the scan can't follow ends it quietly", () => {
  const nested: unknown[] = [];
  stepScanner((step) => nested.push(step))(JSON.stringify({ other: { steps: [{ tool: "set_tempo" }] }, steps: [{ tool: "set_tempo", input: { tempo: 120 } }] }));
  assert.deepEqual(nested, [{ tool: "set_tempo", input: { tempo: 120 } }], "a \"steps\" key deeper in isn't the plan's");
  const broken: unknown[] = [];
  const push = stepScanner((step) => broken.push(step));
  push("{\"steps\": [{\"tool\": \"set_tempo\"}]}}}");
  push("{\"steps\": [{\"tool\": \"after\"}]}");
  assert.deepEqual(broken, [{ tool: "set_tempo" }], "after a stray bracket nothing more is picked out");
});
