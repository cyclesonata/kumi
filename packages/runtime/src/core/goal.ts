/**
 * Goal mode (/goal): Kumi goes after a sound or part until it gets there, the producer stops it, or
 * a safety cap of hours. Code does most of the searching (evolve.ts: knobs nudged, crossed and
 * redrawn around the best, a generation of candidates rendered in one silent pass); the model makes
 * the structural leaps, every few generations or when the search stalls. A goal is kept on disk as it
 * goes, so it survives a restart and /goal picks it up again.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AuditionRequest } from "./contracts.js";
import type { Knob, Slot } from "./evolve.js";

export interface GoalBudget {
  /** The score that ends a goal as reached. */
  target: number;
  /** The safety cap on a goal's running time. */
  ms: number;
  /** The model's leap every this many generations, or after this many without gain. */
  leapEvery: number;
  stallGenerations: number;
}
export const GOAL_BUDGET: GoalBudget = { target: 95, ms: 4 * 60 * 60_000, leapEvery: 8, stallGenerations: 5 };

/** A goal as kept on disk: what it's after, where the part is, and the search so far. */
export interface GoalState {
  version: 1;
  goal: string;
  /** The reference, the span and the focus, as the setup audition gave them (candidates by track name). */
  request: AuditionRequest;
  /** The candidates play their Session clips (copied into the Arrangement for each render). */
  clips?: boolean;
  slots: (Omit<Slot, "knobs"> & { knobs: Knob[] })[];
  generation: number;
  rendered: number;
  trend: number[];
  first?: number;
  elapsedMs: number;
  status: "running" | "paused" | "done";
  /** What the model tried last (a leap), and where the best was kept. */
  idea?: string;
  bestTrack?: string;
  why?: string;
  /** Its lesson in the playbook, updated as the goal goes on. */
  lesson?: string;
}

/** What the app shows of a goal: the dashboard's numbers. */
export interface GoalStatus {
  type: "goal";
  state: GoalState["status"] | "starting";
  goal: string;
  generation: number;
  rendered: number;
  best?: { label: string; score: number };
  first?: number;
  trend: number[];
  leader?: string;
  idea?: string;
  elapsedMs: number;
  candidates: number;
  bestTrack?: string;
  why?: string;
}

export interface GoalStore {
  load(place: string): Promise<GoalState | undefined>;
  save(place: string, state: GoalState): Promise<void>;
  clear(place: string): Promise<void>;
}
const safePlace = (place: string) => place.replace(/[^\w.-]/g, "_").slice(0, 120) || "unsaved";
export function createGoalStore(folder: string): GoalStore {
  const file = (place: string) => join(folder, `${safePlace(place)}.json`);
  return {
    async load(place) {
      try {
        const value = JSON.parse(await readFile(file(place), "utf8")) as Partial<GoalState>;
        if (value.version !== 1 || typeof value.goal !== "string" || !value.request || !Array.isArray(value.slots)) return undefined;
        return value as GoalState;
      } catch { return undefined; }
    },
    async save(place, state) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = join(dirname(file(place)), `.goal-${randomUUID()}`);
      try { await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporary, file(place)); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
    },
    async clear(place) { await rm(file(place), { force: true }); },
  };
}

/** The model's first job in a goal: build a few genuinely different candidates and audition them once. */
export function goalSetup(goal: string): string {
  return `[Kumi goal] ${goal}\n\nThis is a goal: Kumi keeps searching until it gets there. Set the search up: listen to the reference, then build 3–4 genuinely different candidates, each on a new track named "Kumi · Goal · <idea>" (different base instruments such as Operator, Wavetable, Drift, Collision or a Simpler sample; serial chains against parallel racks), with the part on each, and audition them together against the reference once. Then stop: Kumi's own search takes over from there, trying knob settings on your candidates by the hundred, and comes back to you for bigger ideas.`;
}

/** The model's leap: new structures, when the knobs alone have stalled or every few generations. */
export function goalLeap(state: GoalState, best: { label: string; score: number } | undefined, gaps: readonly string[], stalled: boolean, structural?: { gap: string; move: string }): string {
  const trend = state.trend.slice(-8).join("% → ");
  return `[Kumi goal] ${state.goal}\nGeneration ${state.generation}, ${state.rendered} candidates rendered. Best ${best ? `${best.score}% (${best.label})` : "none yet"}; lately ${trend ? `${trend}%` : "no scores"}.${gaps.length ? ` Its biggest gaps: ${gaps.join("; ")}.` : ""}\n${structural ? `Knobs can't close this: ${structural.gap}. Change the structure: ${structural.move}.` : stalled ? "Tweaking knobs has stalled." : "Time for a bigger idea."} Make a structural leap: 1–2 new candidates on new tracks named "Kumi · Goal · <idea>" that differ from the ones in the search (${state.slots.map((slot) => slot.label).join(", ")}): another base instrument or topology, parallel against serial, resampling, or a Max for Live device via make_device when nothing native gets there. Audition them with the leader, then stop; Kumi's search picks them up. End with one line starting "Tried:" that says what you tried.`;
}
