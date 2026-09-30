import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AuditionEvent, AuditionRequest, ChangeRecord, KernelEvent, Observation, SessionController, SessionEvent, TurnResult } from "../src/core/contracts.js";
import { MatchRun, type MatchBudget, type MatchStatus } from "../src/core/match-run.js";
import { createSession } from "../src/core/session.js";

const request: AuditionRequest = { candidates: [{ track: "track:1", label: "Drift" }], fromBeat: 16, beats: 4, reference: "~/ref.wav" };
const heard = (score: number, label = "Drift"): AuditionEvent => ({ type: "auditioned", round: 1, best: { label, score }, takes: [{ label, score }], gaps: ["attack too slow"], request });
const change = (id: string): ChangeRecord => ({ id, family: "parameter", title: "Filter 800 Hz", state: "applied", at: 1 });
const done: TurnResult = { stopReason: "completed", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };

/**
 * A session whose model, each time it's asked, runs `rounds[n]`: it may audition (the score given)
 * and change something after; the integration's own audition scores `harnessScore`.
 */
function rig(rounds: ((session: SessionController, signal: AbortSignal) => Promise<void> | void)[], options: { budget?: Partial<MatchBudget>; harnessScore?: () => number } = {}) {
  const events: SessionEvent[] = []; const asked: string[] = []; const auditioned: AuditionRequest[] = [];
  const observation: Observation = { key: "set", label: "Set", context: "context", instructions: "instructions", tools: [] };
  let session!: SessionController;
  session = createSession({
    onEvent: (event) => events.push(event), timeoutMs: 5_000, cancelGraceMs: 10, closeTimeoutMs: 25, match: { ...options.budget },
    kernelFactory: async () => ({
      async run(input, signal, emit: (event: KernelEvent) => void) {
        asked.push(input.split("<current_observation")[0]!);
        const round = rounds[asked.length - 1];
        await round?.(session, signal);
        signal.throwIfAborted();
        emit({ type: "text", text: `answer ${asked.length}` });
        return done;
      },
      async close() {},
    }),
    integrationFactory: (listener) => ({
      async start() { listener("connected"); },
      async observe() { return observation; },
      async close() {},
      async audition(given) {
        auditioned.push(given);
        session.watch!(heard(options.harnessScore?.() ?? 0));
        return { takes: [], seconds: 1, notes: [] };
      },
    }),
  });
  const status = () => events.filter((event): event is MatchStatus => event.type === "match");
  return { get session() { return session; }, events, asked, auditioned, status };
}
const listens = (score: number, thenChange = false) => (session: SessionController) => { session.watch!(heard(score)); if (thenChange) session.watch!({ type: "change", change: change(`c${score}`) }); };

test("a model that stops at a first draft is sent back in with the score and its gaps, until the target; then it wraps up", async () => {
  const r = rig([listens(50), listens(60), listens(75), listens(93), () => {}]);
  await r.session.start();
  await r.session.submit("make my pad sound like this reference");
  assert.equal(r.asked.length, 5, "four rounds and the wrap-up");
  assert.match(r.asked[1]!, /^\[Kumi\] Score 50% \(best: Drift\)\. Budget left: 12 rounds, about 45 minutes\. Biggest gaps: attack too slow\. Keep going/);
  assert.match(r.asked[2]!, /^\[Kumi\] Score 50% → 60%/);
  assert.match(r.asked[4]!, /That reaches 93%.*final answer: the score before and after \(50% → 93%\)/);
  const last = r.status().at(-1)!;
  assert.deepEqual([last.state, last.stop, last.first, last.best?.score], ["done", "reached", 50, 93]);
  const complete = r.events.filter((event) => event.type === "turn-complete");
  assert.equal(complete.length, 1, "one answer, however many rounds");
  assert.equal((complete[0] as { result: TurnResult }).result.usage?.inputTokens, 50, "its tokens are the rounds' together");
  await r.session.close();
});

test("a plateau is accepted only after something genuinely different was tried; then the run ends", async () => {
  const r = rig([listens(50), listens(51), listens(51), listens(51), listens(52), listens(52), () => {}]);
  await r.session.start();
  await r.session.submit("recreate this sound");
  assert.match(r.asked[3]!, /refining has stalled.*Try something genuinely different now/);
  assert.match(r.asked.at(-1)!, /Refining and new ideas both stopped gaining/);
  assert.equal(r.status().at(-1)!.stop, "plateau");
  await r.session.close();
});

test("the budget bounds a run that keeps creeping up; a request that isn't matching runs once; keep going carries a run on", async () => {
  const r = rig([listens(50), listens(54), listens(58), () => {}, () => {}, listens(70), () => {}], { budget: { rounds: 2 } });
  await r.session.start();
  await r.session.submit("match this reference");
  assert.equal(r.status().at(-1)!.stop, "budget");
  assert.match(r.asked[3]!, /That's the run's budget spent/);
  await r.session.submit("make a bass");
  assert.equal(r.asked.length, 5, "one call, no run");
  await r.session.submit("keep going");
  assert.match(r.asked[6]!, /^\[Kumi\] Score 70% \(best: Drift\)/, "the run carried on from where it got to");
  assert.equal(r.status().at(-1)!.first, 50);
  await r.session.close();
});

test("when something changed since the last audition, the harness auditions it itself before deciding", async () => {
  let score = 80;
  const r = rig([listens(50, true), () => {}], { harnessScore: () => score, budget: { target: 80 } });
  await r.session.start();
  await r.session.submit("make it sound like this");
  assert.deepEqual(r.auditioned, [request], "the last audition again, after the change");
  assert.equal(r.status().at(-1)!.stop, "reached");
  assert.equal(r.asked.length, 1, "reached on the first check: the answer stands");
  score = 0;
  await r.session.close();
});

test("Esc ends a run like any answer", async () => {
  const r = rig([listens(50), async (_session, signal) => { await delay(5_000, undefined, { signal }); }]);
  await r.session.start();
  const running = r.session.submit("make it sound like the reference");
  while (r.asked.length < 2) await delay(5);
  r.session.cancel();
  await running;
  await delay(20);
  assert.equal(r.asked.length, 2, "no more rounds");
  assert.equal(r.session.status().state, "idle");
  await r.session.close();
});

test("a run with nothing to compare asks for an audition twice, then stops", () => {
  const run = new MatchRun("recreate this", undefined, () => 0);
  assert.match(String((run.decide() as { next: string }).next), /audition what you built/);
  assert.ok("next" in run.decide());
  assert.deepEqual(run.decide(), { stop: "no-audition" });
});
