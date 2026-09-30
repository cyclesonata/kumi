/**
 * Match runs: for "make it sound like this", the harness decides when to stop, not the model. Each
 * time the model ends its answer, the run looks at the auditions so far (auditioning the current
 * best itself when something changed since), and either ends it (the target reached, no gain after
 * trying something genuinely different, or the budget spent) or sends the model back in with the
 * score, what's left of the budget and the biggest gaps. A first draft can't end a run.
 */
import type { AuditionEvent, AuditionRequest } from "./contracts.js";
import { MATCHING } from "./techniques.js";

export interface MatchBudget {
  /** How many times the model may be sent back in. */
  rounds: number;
  /** How long the run may take in all. */
  ms: number;
  /** The score that ends the run as reached. */
  target: number;
  /** Checks in a row without this much gain make a plateau. */
  plateauChecks: number;
  minGain: number;
}
/** Generous: the producer cares about the result, and every round is shown. */
export const MATCH_BUDGET: MatchBudget = { rounds: 12, ms: 45 * 60_000, target: 92, plateauChecks: 2, minGain: 2 };

/** A request that starts a match run. */
export const startsMatch = (request: string) => MATCHING.test(request);
/** "keep going" after a run: it carries on, with a fresh budget. */
export const KEEP_GOING = /^\s*(keep going|carry on|continue|go on|more|keep trying|try more|again)\b/i;

export type MatchStop = "reached" | "plateau" | "budget" | "no-audition";
export type MatchDecision = { stop: MatchStop; wrapUp?: string } | { next: string };

/** What the app shows while a run works: its check, the best so far and where it started, and how long it's been. */
export interface MatchStatus { type: "match"; state: "running" | "done"; check: number; first?: number; best?: { label: string; score: number }; elapsedMs: number; roundsLeft: number; stop?: MatchStop }

export class MatchRun {
  /** The best score at each of the harness's checks. */
  readonly checks: number[] = [];
  private readonly started: number;
  private continuations = 0;
  private explored = false;
  private nudged = 0;
  private widened = false;
  /** The last audition's request and result, and whether the Set changed since. */
  last?: { request?: AuditionRequest; event: AuditionEvent };
  best?: { label: string; score: number };
  first?: number;
  changedSince = false;
  /** The reference as heard, for the lesson. */
  reference?: string;
  /** Every audition's best, in order: what moved the score. */
  readonly history: { label: string; score: number }[] = [];

  constructor(readonly request: string, private readonly budget: MatchBudget = MATCH_BUDGET, private readonly now: () => number = Date.now) { this.started = now(); }

  /** "Keep going" after a run: the same goal, where it got to, with a fresh budget. */
  static carryOn(previous: MatchRun, budget: MatchBudget = MATCH_BUDGET, now: () => number = Date.now): MatchRun {
    const run = new MatchRun(previous.request, budget, now);
    run.history.push(...previous.history);
    if (previous.first !== undefined) run.first = previous.first;
    if (previous.best) run.best = previous.best;
    if (previous.last) run.last = previous.last;
    if (previous.reference) run.reference = previous.reference;
    run.changedSince = previous.changedSince;
    return run;
  }

  /** An audition happened (the model's or the harness's own). */
  auditioned(event: AuditionEvent, request?: AuditionRequest): void {
    this.last = { event, ...(request ? { request } : {}) };
    if (event.reference) this.reference = event.reference;
    this.changedSince = false;
    if (!event.best) return;
    this.history.push(event.best);
    this.first ??= event.best.score;
    if (!this.best || event.best.score > this.best.score) this.best = event.best;
  }
  /** Kumi changed the Set: the last audition no longer says how it sounds. */
  changed(): void { this.changedSince = true; }

  /** Whether the harness should audition before deciding: something changed since the last one. */
  get needsAudition(): boolean { return Boolean(this.last?.request && this.changedSince); }

  status(state: MatchStatus["state"], stop?: MatchStop): MatchStatus {
    return { type: "match", state, check: this.checks.length, ...(this.first !== undefined ? { first: this.first } : {}), ...(this.best ? { best: this.best } : {}),
      elapsedMs: this.now() - this.started, roundsLeft: Math.max(0, this.budget.rounds - this.continuations), ...(stop ? { stop } : {}) };
  }

  /** The model ended its answer (and any audition the harness ran is in): stop, or go on. */
  decide(): MatchDecision {
    const elapsed = this.now() - this.started;
    const left = { rounds: this.budget.rounds - this.continuations, minutes: Math.max(0, Math.round((this.budget.ms - elapsed) / 60_000)) };
    if (!this.best) {
      // Nothing heard against the reference yet: ask for it, twice at most (there may be no reference).
      if (this.nudged >= 2 || left.rounds <= 0) return { stop: "no-audition" };
      this.nudged++; this.continuations++;
      return { next: "[Kumi] Before finishing, audition what you built against the reference (the audition tool; several candidates on their own tracks render together). If the producer gave no reference, listen to what they pointed at, or ask them for one and stop." };
    }
    this.checks.push(this.best.score);
    const wrapUp = (why: string) => `[Kumi] ${why} Tidy up, then give your final answer. Keep the winner on its track, mute the runner-up for the producer to A/B, and remove the other candidate tracks you made (undo_change on the change that added each). Then say the score before and after (${this.first}% → ${this.best!.score}%), which candidate won and why, what still differs, and which track holds the runner-up. Call it the closest you got.`;
    if (this.best.score >= this.budget.target) return { stop: "reached", ...(this.continuations ? { wrapUp: wrapUp(`That reaches ${this.best.score}%, close enough to stop.`) } : {}) };
    if (left.rounds <= 0 || elapsed >= this.budget.ms) return { stop: "budget", wrapUp: wrapUp("That's the run's budget spent.") };
    // A plateau: the last checks gained less than minGain over the best before them.
    const n = this.budget.plateauChecks;
    const stalled = this.checks.length > n && this.checks.at(-1)! - this.checks.at(-1 - n)! < this.budget.minGain;
    if (stalled && this.explored) return { stop: "plateau", wrapUp: wrapUp("Refining and new ideas both stopped gaining.") };
    const gaps = this.last?.event.gaps.length ? ` Biggest gaps: ${this.last.event.gaps.join("; ")}.` : "";
    const scores = this.checks.length > 1 ? `${this.checks.at(-2)}% → ${this.best.score}%` : `${this.best.score}%`;
    // A first round of one idea is a guess: the search starts wide.
    if (this.checks.length === 1 && !this.widened && (this.last?.event.takes.length ?? 0) < 2) {
      this.widened = true; this.continuations++;
      return { next: `[Kumi] Score ${scores} with a single candidate.${` Budget left: ${left.rounds - 1} rounds, about ${left.minutes} minutes.`} Start wide: build 2–3 more genuinely different candidates on new tracks (other base instruments, serial against parallel), audition them all together with this one, then refine the best.` };
    }
    const budget = ` Budget left: ${left.rounds} rounds, about ${left.minutes} minutes.`;
    this.continuations++;
    if (stalled) {
      this.explored = true;
      this.checks.length = 0; this.checks.push(this.best.score);
      return { next: `[Kumi] Score ${scores}, and refining has stalled.${budget}${gaps} Try something genuinely different now: 2–4 new candidates on new tracks with other base instruments or another topology (parallel against serial, a rack of layers, resampling), audition them with the best so far, then refine the winner.` };
    }
    return { next: `[Kumi] Score ${scores} (best: ${this.best.label}).${budget}${gaps} Keep going: fix the biggest gaps on the best candidate, trying several values side by side on copies, and audition again. Try something different if refinement has stalled.` };
  }
}
