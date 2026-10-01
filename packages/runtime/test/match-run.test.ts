import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AuditionEvent, AuditionRequest, ChangeRecord, KernelEvent, Observation, SessionController, SessionEvent, TurnResult } from "../src/core/contracts.js";
import { KEEP_GOING, MATCH_BUDGET, MatchRun, startsMatch, type MatchBudget, type MatchStatus } from "../src/core/match-run.js";
import { MIX_CANDIDATE } from "../src/core/contracts.js";
import { createSession } from "../src/core/session.js";
import { createPlaybookStore, matchedFrom, playbookBrief, type Lesson, type PlaybookStore } from "../src/core/playbook.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const request: AuditionRequest = { candidates: [{ track: "track:1", label: "Drift" }], fromBeat: 16, beats: 4, reference: "~/ref.wav" };
const heard = (score: number, label = "Drift"): AuditionEvent => ({ type: "auditioned", round: 1, best: { label, score }, takes: [{ label, score }, { label: "Other", score: score - 10 }], gaps: ["attack too slow"], request });
const change = (id: string): ChangeRecord => ({ id, family: "parameter", title: "Filter 800 Hz", state: "applied", at: 1 });
const done: TurnResult = { stopReason: "completed", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };

/**
 * A session whose model, each time it's asked, runs `rounds[n]`: it may audition (the score given)
 * and change something after; the integration's own audition scores `harnessScore`.
 */
function memoryPlaybook(lessons: Lesson[] = []): PlaybookStore & { lessons: Lesson[] } {
  return { lessons, async list() { return structuredClone(this.lessons); }, async save(next) { this.lessons = structuredClone([...next]); } };
}
function rig(rounds: ((session: SessionController, signal: AbortSignal) => Promise<void> | void)[], options: { budget?: Partial<MatchBudget>; harnessScore?: () => number; playbook?: PlaybookStore } = {}) {
  const events: SessionEvent[] = []; const asked: string[] = []; const auditioned: AuditionRequest[] = [];
  const observation: Observation = { key: "set", label: "Set", context: "context", instructions: "instructions", tools: [] };
  let session!: SessionController;
  session = createSession({
    onEvent: (event) => events.push(event), timeoutMs: 5_000, cancelGraceMs: 10, closeTimeoutMs: 25, match: { ...options.budget }, ...(options.playbook ? { playbook: options.playbook } : {}),
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
  assert.match(r.asked[4]!, /That reaches 93%.*rebuild it there.*Mute every other candidate track.*the score before and after \(50% → 93%\)/);
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

test("the budget bounds a run that keeps creeping up; keep going right after carries it on; a request that isn't matching runs once and ends it", async () => {
  const r = rig([listens(50), listens(54), listens(58), () => {}, listens(70), () => {}, () => {}, () => {}, () => {}, () => {}], { budget: { rounds: 2 } });
  await r.session.start();
  await r.session.submit("match this reference");
  assert.equal(r.status().at(-1)!.stop, "budget");
  assert.match(r.asked[3]!, /That's the run's budget spent/);
  await r.session.submit("keep going");
  assert.match(r.asked[5]!, /^\[Kumi\] Score 70% \(best: Drift\)/, "the run carried on from where it got to");
  assert.equal(r.status().at(-1)!.first, 50);
  const before = r.asked.length;
  await r.session.submit("make a bass");
  assert.equal(r.asked.length, before + 1, "one call, no run");
  await r.session.submit("keep going");
  assert.equal(r.asked.length, before + 2, "after another request, keep going is just a request");
  await r.session.close();
});

test("only a request with something to match starts a run: a reference, a file, a link, \"like this\"", () => {
  for (const request of ["match this reference", "recreate the sound from https://youtu.be/x", "make it sound like this", "make my pad sound like ~/ref.wav", "recreate this sound"]) assert.ok(startsMatch(request), request);
  for (const request of ["match the kick level to the snare", "make it sound like a cathedral", "recreate the chorus with more energy"]) assert.ok(!startsMatch(request), request);
  for (const request of ["keep going", "Carry on.", "keep trying with a wavetable"]) assert.ok(KEEP_GOING.test(request), request);
  for (const request of ["more reverb", "again, but darker", "continue the bassline into bar 9"]) assert.ok(!KEEP_GOING.test(request), request);
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

const heardAs = (label: string, score: number) => (session: SessionController) => { session.watch!(heard(score, label)); };

test("each run leaves a lesson with its evidence; the next run reads it first; keep going updates it; the producer's words judge it; it can be forgotten", async () => {
  const playbook = memoryPlaybook();
  const r = rig([heardAs("Operator FM", 52), heardAs("Collision", 64), heardAs("Collision + parallel delays", 73), heardAs("Collision + parallel delays", 73), heardAs("Collision + parallel delays", 74), heardAs("Collision + parallel delays", 74), heardAs("Collision + parallel delays", 74), () => {},
    // "keep going": two more rounds, then the next run.
    heardAs("Collision, brighter", 93), () => {}, () => {}], { playbook });
  await r.session.start();
  await r.session.submit("make my plucked metallic percussion sound like this reference");
  await delay(10);
  assert.equal(playbook.lessons.length, 1);
  const lesson = playbook.lessons[0]!;
  assert.deepEqual([lesson.matched, lesson.winner, lesson.from, lesson.to], ["plucked metallic percussion", "Collision + parallel delays", 52, 74]);
  assert.deepEqual(lesson.moves.map((move) => move.score), [52, 64, 73, 74], "only the rounds that raised the best");
  assert.ok(r.events.some((event) => event.type === "lesson" && event.action === "learned" && /plucked metallic percussion: Collision \+ parallel delays won, 52% → 74%; Operator FM 52% → Collision 64%/.test(event.line)));
  // Carried on: the same lesson, updated.
  await r.session.submit("keep going");
  await delay(10);
  assert.equal(playbook.lessons.length, 1);
  assert.equal(playbook.lessons[0]!.to, 93);
  assert.ok(r.events.some((event) => event.type === "lesson" && event.action === "updated"));
  // The producer's next words: they liked it.
  await r.session.submit("love it, thanks");
  await delay(10);
  assert.equal(playbook.lessons[0]!.reaction, "liked");
  // A new matching run reads it before anything else.
  const r2 = rig([() => {}], { playbook, budget: { rounds: 0 } });
  await r2.session.start();
  await r2.session.submit("make this metallic percussion hit sound like the reference");
  assert.match(r2.asked[0]!, /<kumi_playbook_untrusted>[\s\S]*plucked metallic percussion: Collision, brighter won, 52% → 93%.*\(the producer liked it\)/);
  // Forgotten from /memory.
  const [listed] = await r2.session.lessons!();
  assert.equal(await r2.session.forgetLesson!(listed!.id), true);
  assert.equal(playbook.lessons.length, 0);
  await r.session.close(); await r2.session.close();
});

test("lessons are kept in a file only this user can read, checked on the way in; the brief picks those that share words", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-playbook-"));
  try {
    const store = createPlaybookStore(join(directory, "playbook.json"));
    const lesson = (id: string, matched: string, winner: string): Lesson => ({ id, at: 1, matched, winner, from: 40, to: 70, moves: [] });
    await store.save([lesson("l00000001", "a wobbly reese bass", "Operator + LFO filter"), lesson("l00000002", "an airy pad", "Wavetable + reverb"), { ...lesson("bad", "x", "y") }]);
    if (process.platform !== "win32") assert.equal(statSync(join(directory, "playbook.json")).mode & 0o777, 0o600);
    assert.deepEqual((await store.list()).map((item) => item.id), ["l00000001", "l00000002"], "an entry that isn't a lesson is left out");
    const brief = playbookBrief(await store.list(), "recreate this reese bass", 1);
    assert.match(brief, /a wobbly reese bass: Operator \+ LFO filter won/);
    assert.ok(!brief.includes("airy pad"));
    assert.equal(playbookBrief([], "anything"), "");
    assert.equal(matchedFrom("Make my pad sound like this reference: ~/ref.wav"), "pad");
    assert.equal(matchedFrom("recreate this sound"), "sound");
    assert.equal(matchedFrom("Make a new MIDI track with a sound that sounds like this reference: ~/ref.wav. It's a chord."), "sound");
    assert.equal(matchedFrom("build me a warm pad that sounds like the intro"), "warm pad");
    assert.equal(matchedFrom("https://www.youtube.com/watch?v=abc Listen to 0:05 - 0:25 of this track. Recreate the sound and the sequence on this track using native devices."), "sound and the sequence", "a link isn't what was matched");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the best's track and clip are kept by name and scene, which last from turn to turn, for Kumi's knob search at the end", () => {
  const run = new MatchRun("make it sound like this", undefined, () => 0);
  run.auditioned({ type: "auditioned", round: 1, best: { label: "Drift", score: 60 }, takes: [{ label: "Drift", score: 60, where: { track: "Cand Drift", clip: "scene:2" } }, { label: "Other", score: 50, where: { track: "Cand Other" } }], gaps: [], request });
  assert.deepEqual(run.bestCandidate, { track: "Cand Drift", label: "Drift", clip: "scene:2" });
  assert.equal(run.polishes, true);
  run.auditioned({ type: "auditioned", round: 2, best: { label: "Other", score: 55 }, takes: [{ label: "Other", score: 55, where: { track: "Cand Other" } }], gaps: [], request });
  assert.equal(run.bestCandidate!.track, "Cand Drift", "a lower score doesn't move it");
  run.tuned("Drift, tuned", 66);
  assert.deepEqual(run.best, { label: "Drift, tuned", score: 66 });
  assert.equal(run.polishes, false, "once a run");
});

test("a first round of a single candidate is sent back to start wide, once", () => {
  const run = new MatchRun("make it sound like this", undefined, () => 0);
  run.auditioned({ type: "auditioned", round: 1, best: { label: "Operator", score: 58 }, takes: [{ label: "Operator", score: 58 }], gaps: [], request });
  assert.match(String((run.decide() as { next: string }).next), /with a single candidate\..*build 2–3 more genuinely different candidates/);
  run.auditioned({ type: "auditioned", round: 2, best: { label: "Operator", score: 60 }, takes: [{ label: "Operator", score: 60 }], gaps: [], request });
  assert.match(String((run.decide() as { next: string }).next), /Keep going/, "only once");
});

test("a gap no knob closes leads the next round: change the structure, not the knobs", () => {
  const run = new MatchRun("make it sound like this", undefined, () => 0);
  run.auditioned({ type: "auditioned", round: 1, best: { label: "Saw", score: 60 }, takes: [{ label: "Saw", score: 60 }, { label: "Sine", score: 50 }], gaps: ["sub −20 dB"], request,
    structural: { gap: "sub −20.0 dB against the reference", move: "add a sub layer (an Operator sine …)" } });
  const next = String((run.decide() as { next: string }).next);
  assert.match(next, /Knobs can't close this: sub −20\.0 dB against the reference\. Change the structure: add a sub layer/);
  assert.doesNotMatch(next, /Keep going/);
});

test("a run whose best is the whole mix knows it's the mix, and never hands it to the knob search", () => {
  const run = new MatchRun("match my mix to the reference", { ...MATCH_BUDGET, polishMs: 60_000 });
  const request = { candidates: [{ track: MIX_CANDIDATE, mix: true }], fromBeat: 0, beats: 16, reference: "/ref.wav" };
  run.auditioned({ type: "auditioned", round: 1, best: { label: "The whole mix", score: 71 }, takes: [{ label: "The whole mix", score: 71, where: { track: MIX_CANDIDATE } }], gaps: [], request }, request);
  assert.deepEqual(run.bestCandidate, { track: MIX_CANDIDATE, label: "The whole mix", mix: true });
  assert.equal(run.polishes, false, "a goal turns one track's knobs, not Main's");
});
