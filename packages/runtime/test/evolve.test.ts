import assert from "node:assert/strict";
import { test } from "node:test";
import { Evolution, searchable, seeded, type Knob } from "../src/core/evolve.js";

const knobs = (device: string, values: number[]): Knob[] => values.map((value, index) => ({ ref: `${device}:${index}`, device, name: `Knob ${index}`, min: 0, max: 1, value }));
/** A hidden sound to find: the closer each knob to its target, the higher the score. */
const target = [0.8, 0.2, 0.65, 0.4, 0.9];
const score = (values: readonly number[], offset = 0) => Math.max(0, 100 - offset - 120 * Math.sqrt(values.reduce((sum, value, index) => sum + (value - target[index]!) ** 2, 0) / values.length));

test("the search climbs toward what scores best, keeps each slot's best, and never loses the leader", () => {
  const evolution = new Evolution(seeded(7));
  evolution.add({ name: "Kumi · Goal · A", label: "Operator", chain: "Operator", knobs: knobs("Operator", [0.5, 0.5, 0.5, 0.5, 0.5]) });
  evolution.add({ name: "Kumi · Goal · B", label: "Operator (wide)", chain: "Operator", knobs: knobs("Operator", [0.1, 0.9, 0.1, 0.9, 0.1]) });
  // Another chain can't reach as high (its sound differs): diversity stays, but it doesn't take over.
  evolution.add({ name: "Kumi · Goal · C", label: "Drift", chain: "Drift", knobs: knobs("Drift", [0.5, 0.5, 0.5, 0.5, 0.5]) });
  const bests: number[] = [];
  for (let generation = 0; generation < 60; generation++) {
    const trials = evolution.propose();
    assert.equal(trials.length, 3, "one trial per slot, rendered in one pass");
    const scores = new Map(trials.map((trial) => [trial.slot, score(trial.values, trial.slot.endsWith("C") ? 25 : 0)] as const));
    evolution.scored(trials, scores);
    bests.push(evolution.best!);
  }
  assert.ok(bests.every((value, index) => index === 0 || value >= bests[index - 1]! - 1e-9), "the best never goes down (hearing it again only averages the same score)");
  assert.ok(bests[0]! < 75 && bests.at(-1)! > 88, `from ${bests[0]} to ${bests.at(-1)}`);
  assert.equal(evolution.leader!.chain, "Operator");
  assert.ok(evolution.slots.some((slot) => slot.chain === "Drift"), "the other family keeps its slot");
  assert.equal(evolution.rendered, 180);
  assert.equal(evolution.trend.length, 60);
});

test("crossover only mixes slots of one chain; a slot never scored plays as it is; stuck slots are reseeded", () => {
  const evolution = new Evolution(seeded(3), { moves: 2, crossover: 1, random: 0, patience: 2, recheck: 99 });
  evolution.add({ name: "A", label: "A", chain: "Operator", knobs: knobs("Operator", [0, 0, 0]) });
  evolution.add({ name: "B", label: "B", chain: "Drift", knobs: knobs("Drift", [1, 1, 1]) });
  assert.deepEqual(evolution.propose().map((trial) => trial.how), ["start", "start"]);
  evolution.scored(evolution.propose(), new Map([["A", 50], ["B", 40]]));
  // Crossover is certain here, but no slot shares A's chain: A is nudged instead.
  assert.ok(evolution.propose().every((trial) => trial.how === "nudge"));
  // B fails twice: its values are reseeded (another chain: at random) and it earns a new score.
  for (let round = 0; round < 2; round++) evolution.scored(evolution.propose(), new Map([["A", 50], ["B", 10]]));
  const b = evolution.slots.find((slot) => slot.name === "B")!;
  assert.equal(b.score, undefined);
  assert.equal(evolution.propose().find((trial) => trial.slot === "B")!.how, "start");
});

test("the search leaves switches that silence a chain, levels and the safety limiter alone, and snaps stepped knobs", () => {
  const all: Knob[] = [
    { ref: "1", device: "Operator", name: "Device On", min: 0, max: 1, value: 1 },
    { ref: "2", device: "Operator", name: "Volume", min: 0, max: 1, value: 0.8 },
    { ref: "3", device: "Operator", name: "Filter Freq", min: 0, max: 1, value: 0.5 },
    { ref: "4", device: "Limiter", name: "Gain", min: 0, max: 1, value: 0.5 },
    { ref: "5", device: "Operator", name: "Algorithm", min: 0, max: 10, step: 1, value: 3 },
    { ref: "6", device: "Operator", name: "Fixed", min: 1, max: 1, value: 1 },
  ];
  assert.deepEqual(searchable(all).map((knob) => knob.name), ["Filter Freq", "Algorithm"]);
  const evolution = new Evolution(seeded(11), { moves: 2, crossover: 0, random: 1, patience: 9, recheck: 99 });
  evolution.add({ name: "A", label: "A", chain: "Operator", knobs: all });
  evolution.scored(evolution.propose(), new Map([["A", 10]]));
  for (let round = 0; round < 20; round++) {
    const [trial] = evolution.propose();
    assert.ok(Number.isInteger(trial!.values[1]), "Algorithm moves in whole steps");
    evolution.scored([trial!], new Map([["A", 5]]));
  }
});

test("knobs Live won't set leave a slot's search; a chain offers its most sound-shaping few dozen", () => {
  const evolution = new Evolution(seeded(2));
  evolution.add({ name: "A", label: "A", chain: "Operator", knobs: knobs("Operator", [0.1, 0.2, 0.3]) });
  evolution.scored(evolution.propose(), new Map([["A", 40]]));
  evolution.freeze("A", new Set(["Operator|Knob 1"]));
  const slot = evolution.slots[0]!;
  assert.deepEqual(slot.knobs.map((knob) => knob.name), ["Knob 0", "Knob 2"]);
  assert.deepEqual(slot.elite, [0.1, 0.3]);
  assert.equal(evolution.propose()[0]!.values.length, 2);
  const many: Knob[] = Array.from({ length: 60 }, (_, index) => ({ ref: String(index), device: "Operator", name: index === 59 ? "Filter Freq" : `Osc-B Unused ${index}`, min: 0, max: 1, value: 0 }));
  const chosen = searchable(many);
  assert.equal(chosen.length, 24);
  assert.equal(chosen[0]!.name, "Filter Freq", "what shapes the sound comes first");
});

test("a best that holds is heard again: one lucky render can't hold the search", () => {
  const evolution = new Evolution(seeded(4), { moves: 1, crossover: 0, random: 0, patience: 99, recheck: 2 });
  evolution.add({ name: "A", label: "A", chain: "Operator", knobs: knobs("Operator", [0.5]) });
  // Its first render is lucky (90); it really sounds like 70, and every trial after scores 60.
  evolution.scored(evolution.propose(), new Map([["A", 90]]));
  const hows: string[] = [];
  for (let round = 0; round < 6; round++) {
    const trials = evolution.propose();
    hows.push(trials[0]!.how);
    evolution.scored(trials, new Map([["A", trials[0]!.how === "recheck" ? 70 : 60]]));
  }
  assert.ok(hows.includes("recheck"));
  assert.ok(evolution.best! < 90, `the lucky 90 is averaged down: ${evolution.best}`);
});
