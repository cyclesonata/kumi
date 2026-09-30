/**
 * The goal mode's cheap monkeys: an evolutionary search over the knobs of a few candidate chains,
 * with no model call. Each slot is a track with its own chain; a candidate is a set of values for
 * that chain's knobs. Each generation proposes one trial per slot: a few knobs nudged around the
 * slot's best (the step shrinking as it fails, growing as it succeeds), now and then a crossover
 * with another slot of the same chain, now and then a fresh random draw to keep looking wide.
 * Selection keeps each slot's best (an elite per chain, so no one family takes over), and the
 * weakest slot, stuck for long, is reseeded from the leader. Structural leaps (new instruments,
 * topologies) are the model's, between generations.
 */

/** A knob a trial may move: its place, its range, and whether it moves in steps. */
export interface Knob { ref: string; device: string; name: string; min: number; max: number; step?: number; value: number }

export interface Slot {
  /** The track's name: slots are found again by it after a reconnect. */
  name: string;
  label: string;
  /** What chain it is (its devices in order): crossover only between slots of one chain. */
  chain: string;
  knobs: Knob[];
  /** The best values found for this slot, and their score. */
  elite: number[];
  score?: number;
  /** How far a nudge goes, in the knob's own range (0–1), and generations without gain. */
  sigma: number;
  stale: number;
  /** How many renders its best score is the mean of: a render varies, so a lucky one is heard again. */
  heard?: number;
}

export interface Trial { slot: string; values: number[]; how: "start" | "nudge" | "cross" | "random" | "recheck" }

/** Names of knobs the search leaves alone: switching a device off, levels the score ignores, safety. */
const LEAVE = /^(device on|on|power|output|out|volume|gain|master|global volume|limiter.*|ceiling|macro \d+|chain selector|pan|panorama)$/i;

/** Knobs that shape a sound most, searched first: filters, envelopes, oscillators' shape and level, tuning, drive. */
const SHAPING = /(filter|freq|cutoff|res(onance)?|q\b|attack|decay|sustain|release|\benv|shape|wave|tone|timbre|bright|color|colour|drive|dist|sat|detune|fine|coarse|level|mix|amount|depth|rate|spread|width|noise|body|decay|damp|stiff|mallet|feedback|morph|position|pw\b|pulse|glide)/i;
/** Most knobs searched on a chain: past a few dozen, a search of a few knobs a trial finds little. */
export const MOST_KNOBS = 24;

/** The knobs worth searching on a chain: continuous or with a few steps, not switches that silence it; the most sound-shaping first, a few dozen at most. */
export function searchable(knobs: readonly Knob[], most = MOST_KNOBS): Knob[] {
  const open = knobs.filter((knob) => knob.max > knob.min && !LEAVE.test(knob.name.trim()) && !/limiter/i.test(knob.device));
  return [...open.filter((knob) => SHAPING.test(knob.name)), ...open.filter((knob) => !SHAPING.test(knob.name))].slice(0, most);
}

/** A small seeded random source (mulberry32), so a search can be replayed in tests. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EvolveOptions {
  /** Every this many generations without gain, a slot's best is rendered again (up to four times). */
  recheck: number;
  /** Knobs nudged per trial, at most. */
  moves: number;
  /** How often a trial is a crossover (when a same-chain partner exists), or a fresh random draw. */
  crossover: number;
  random: number;
  /** Generations a slot may go without gain before the weakest is reseeded from the leader. */
  patience: number;
}
export const EVOLVE: EvolveOptions = { moves: 3, crossover: 0.2, random: 0.1, patience: 6, recheck: 3 };

export class Evolution {
  readonly slots: Slot[] = [];
  generation = 0;
  /** Each generation's best score, for the dashboard's trend. */
  readonly trend: number[] = [];
  rendered = 0;
  private lastImproved = 0;

  constructor(private readonly random: () => number = Math.random, private readonly options: EvolveOptions = EVOLVE) {}

  /** A candidate chain joins (a slot the model built): its current values are its first elite. */
  add(slot: Omit<Slot, "elite" | "sigma" | "stale" | "score"> & { score?: number }): Slot {
    const knobs = searchable(slot.knobs);
    const added: Slot = { ...slot, knobs, elite: knobs.map((knob) => knob.value), sigma: 0.2, stale: 0, ...(slot.score !== undefined ? { score: slot.score } : {}) };
    const at = this.slots.findIndex((item) => item.name === slot.name);
    if (at >= 0) this.slots[at] = added; else this.slots.push(added);
    return added;
  }
  /** Knobs Live won't set (it refuses the values) leave a slot's search. */
  freeze(name: string, keys: ReadonlySet<string>): void {
    const slot = this.slots.find((item) => item.name === name);
    if (!slot) return;
    const keep = slot.knobs.map((knob) => !keys.has(`${knob.device}|${knob.name}`));
    slot.knobs = slot.knobs.filter((_, index) => keep[index]);
    slot.elite = slot.elite.filter((_, index) => keep[index]);
  }
  remove(name: string): void { const at = this.slots.findIndex((slot) => slot.name === name); if (at >= 0) this.slots.splice(at, 1); }

  get leader(): Slot | undefined { return [...this.slots].filter((slot) => slot.score !== undefined).sort((a, b) => b.score! - a.score!)[0]; }
  get best(): number | undefined { return this.leader?.score; }
  /** Generations since the best score last rose. */
  get stalledFor(): number { return this.generation - this.lastImproved; }

  /** This generation's trials, one per slot; a slot never scored plays as it is. */
  propose(): Trial[] {
    return this.slots.map((slot) => {
      if (slot.score === undefined || !slot.knobs.length) return { slot: slot.name, values: [...slot.elite], how: "start" };
      // Renders vary: a best that has held for a while is heard again, so one lucky render can't hold the search.
      if (slot.stale > 0 && slot.stale % this.options.recheck === 0 && (slot.heard ?? 1) < 4) return { slot: slot.name, values: [...slot.elite], how: "recheck" };
      const roll = this.random();
      const partner = this.slots.filter((other) => other !== slot && other.chain === slot.chain && other.score !== undefined);
      if (partner.length && roll < this.options.crossover) {
        const other = partner[Math.floor(this.random() * partner.length)]!;
        return { slot: slot.name, values: slot.elite.map((value, index) => (this.random() < 0.5 ? value : other.elite[index] ?? value)), how: "cross" };
      }
      if (roll >= this.options.crossover && roll < this.options.crossover + this.options.random) return { slot: slot.name, values: slot.knobs.map((knob) => this.snap(knob, knob.min + this.random() * (knob.max - knob.min))), how: "random" };
      // A nudge: a few knobs, each by a normal step scaled to its range.
      const values = [...slot.elite];
      const count = 1 + Math.floor(this.random() * Math.min(this.options.moves, slot.knobs.length));
      for (let move = 0; move < count; move++) {
        const index = Math.floor(this.random() * slot.knobs.length);
        const knob = slot.knobs[index]!;
        values[index] = this.snap(knob, values[index]! + this.normal() * slot.sigma * (knob.max - knob.min));
      }
      return { slot: slot.name, values, how: "nudge" };
    });
  }

  /** A generation's scores: each slot keeps a trial that beat its best; steps grow on success and shrink on failure. */
  scored(trials: readonly Trial[], scores: ReadonlyMap<string, number>): { improved: boolean; best?: number } {
    this.generation++;
    const before = this.best ?? -1;
    for (const trial of trials) {
      const slot = this.slots.find((item) => item.name === trial.slot);
      const score = scores.get(trial.slot);
      if (!slot || score === undefined) continue;
      this.rendered++;
      if (trial.how === "recheck" && slot.score !== undefined) {
        // The best's score becomes the mean of its renders.
        const heard = (slot.heard ?? 1) + 1;
        slot.score = (slot.score * (heard - 1) + score) / heard; slot.heard = heard; slot.stale++;
        continue;
      }
      if (slot.score === undefined || score > slot.score) {
        slot.elite = [...trial.values]; slot.score = score; slot.stale = 0; slot.heard = 1;
        slot.sigma = Math.min(0.5, slot.sigma * 1.25);
      } else { slot.stale++; slot.sigma = Math.max(0.01, slot.sigma * 0.85); }
    }
    const best = this.best;
    if (best !== undefined && best > before) this.lastImproved = this.generation;
    if (best !== undefined) this.trend.push(best);
    this.reseed();
    return { improved: best !== undefined && best > before, ...(best !== undefined ? { best } : {}) };
  }

  /** The weakest slot stuck for long takes the leader's values when it shares its chain, or a fresh random draw. */
  private reseed(): void {
    const leader = this.leader;
    const stuck = this.slots.filter((slot) => slot !== leader && slot.score !== undefined && slot.stale >= this.options.patience).sort((a, b) => a.score! - b.score!)[0];
    if (!stuck || !leader) return;
    stuck.elite = stuck.chain === leader.chain ? [...leader.elite] : stuck.knobs.map((knob) => this.snap(knob, knob.min + this.random() * (knob.max - knob.min)));
    stuck.sigma = 0.2; stuck.stale = 0;
    // Its old score belonged to other values: it earns a new one.
    delete stuck.score;
  }

  private snap(knob: Knob, value: number): number {
    const clamped = Math.max(knob.min, Math.min(knob.max, value));
    return knob.step && knob.step > 0 ? Math.max(knob.min, Math.min(knob.max, knob.min + Math.round((clamped - knob.min) / knob.step) * knob.step)) : clamped;
  }
  private normal(): number {
    // Box–Muller, from the seeded source.
    const u = Math.max(1e-9, this.random()); const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
