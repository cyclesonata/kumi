/**
 * Match runs: for "make it sound like this", the harness decides when to stop, not the model. Each
 * time the model ends its answer, the run looks at the auditions so far (auditioning the current
 * best itself when something changed since), and either ends it (the target reached, no gain after
 * trying something genuinely different, or the budget spent) or sends the model back in with the
 * score, what's left of the budget and the biggest gaps. A first draft can't end a run.
 */
import { MIX_CANDIDATE, type AuditionCandidate, type AuditionEvent, type AuditionRequest } from "./contracts.js";
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
  /** After the model's ideas run out, how long Kumi's own knob search may tune the best (none when left out). */
  polishMs?: number;
}
/** Generous: the producer cares about the result, and every round is shown. */
export const MATCH_BUDGET: MatchBudget = { rounds: 12, ms: 45 * 60_000, target: 92, plateauChecks: 2, minGain: 2, polishMs: 8 * 60_000 };

/** Something to match in a request: a reference, a file, a link, "like this", this sound or that video. */
const SOMETHING_TO_MATCH = /https?:\/\/|\.(wav|wave|aiff?|flac|mp3|ogg|m4a|mp4|mov|webm|mkv)\b|\breferences?\b|\blike (this|that)\b|\b(this|that) (sound|track|clip|sample|recording|video|tutorial|song|tune|part|loop)\b|\bthe (sound|recording|video|tutorial|song) (from|in|of|at)\b/i;
/** A request that starts a match run: asking to match something, and naming what. "Sound like a cathedral" isn't one. */
export const startsMatch = (request: string) => MATCHING.test(request) && SOMETHING_TO_MATCH.test(request);
/** "keep going" right after a run: it carries on, with a fresh budget. A message of its own, or one that starts by saying to keep trying. */
export const KEEP_GOING = /^\s*(keep going|carry on|continue|go on|keep trying|try more|more|again)\s*[.!]*\s*$|^\s*(keep going|carry on|keep trying|try more)\b/i;

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
  /** The best's track, as auditioned: what Kumi's knob search tunes at the end. */
  bestCandidate?: AuditionCandidate;
  /** Kumi's knob search has had its turn (once a run). */
  polished = false;
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
    const asked = request ?? event.request;
    this.last = { event, ...(asked ? { request: asked } : {}) };
    if (event.reference) this.reference = event.reference;
    this.changedSince = false;
    if (!event.best) return;
    this.history.push(event.best);
    this.first ??= event.best.score;
    if (!this.best || event.best.score > this.best.score) {
      this.best = event.best;
      // Its track and clip, by names that last beyond this turn (references don't).
      const where = event.takes.find((take) => take.label === event.best!.label)?.where;
      if (where) this.bestCandidate = { track: where.track, label: event.best.label, ...(where.clip ? { clip: where.clip } : {}), ...(where.track === MIX_CANDIDATE ? { mix: true } : {}) }; else delete this.bestCandidate;
    }
  }
  /** Kumi's knob search tuned the best: its score, heard at full length, is the run's new best. */
  tuned(label: string, score: number): void {
    this.polished = true;
    this.history.push({ label, score });
    if (!this.best || score > this.best.score) this.best = { label, score };
  }
  /** Whether a stop should first let Kumi's knob search tune the best (a track's knobs: never the whole mix). */
  get polishes(): boolean { return !this.polished && Boolean(this.budget.polishMs && this.bestCandidate && !this.bestCandidate.mix && this.last?.request?.reference); }
  get polishMs(): number { return this.budget.polishMs ?? 0; }
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
    const wrapUp = (why: string) => this.wrapUp(why);
    if (this.best.score >= this.budget.target) return { stop: "reached", ...(this.continuations ? { wrapUp: wrapUp(`That reaches ${this.best.score}%, close enough to stop.`) } : {}) };
    if (left.rounds <= 0 || elapsed >= this.budget.ms) return { stop: "budget", wrapUp: wrapUp("That's the run's budget spent.") };
    // A plateau: the last checks gained less than minGain over the best before them.
    const n = this.budget.plateauChecks;
    const stalled = this.checks.length > n && this.checks.at(-1)! - this.checks.at(-1 - n)! < this.budget.minGain;
    if (stalled && this.explored) return { stop: "plateau", wrapUp: wrapUp("Refining and new ideas both stopped gaining.") };
    return this.carryOn(left, stalled);
  }
  /** The last prompt of a run: tidy up and say how it went. */
  wrapUp(why: string): string {
    return `[Kumi] ${why} Tidy up, then give your final answer. Put the winner where the producer asked for it: when they asked for it on a track ("this track", one they named or had selected) and it won elsewhere, rebuild it there (the same devices, the settings you gave them, its clip) and audition it once to check it scores the same; otherwise keep it on its own. Mute every other candidate track you made (don't undo them: Live removes a track only from the last one back, and not one changed since). Then say the score before and after (${this.first}% → ${this.best!.score}%), which candidate won and why, what still differs, and which muted tracks hold the others for the producer to A/B or delete. Call it the closest you got.`;
  }
  private carryOn(left: { rounds: number; minutes: number }, stalled: boolean): MatchDecision {
    if (!this.best) return { stop: "no-audition" };
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
    // A gap no knob closes leads: the structure changes, at once.
    const structural = this.last?.event.structural;
    if (structural) return { next: `[Kumi] Score ${scores} (best: ${this.best.label}).${budget} Knobs can't close this: ${structural.gap}. Change the structure: ${structural.move}. Build it on a copy or a new track, audition it with the best, then refine.` };
    return { next: `[Kumi] Score ${scores} (best: ${this.best.label}).${budget}${gaps} Keep going: fix the biggest gaps on the best candidate, trying several values side by side on copies, and audition again. Try something different if refinement has stalled.` };
  }
}
