import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { KernelTool, SessionEvent } from "../src/core/contracts.js";
import { createSession } from "../src/core/session.js";
import { seeded } from "../src/core/evolve.js";
import type { GoalState, GoalStatus, GoalStore } from "../src/core/goal.js";
import type { Lesson, PlaybookStore } from "../src/core/playbook.js";
import { bridge, type FixtureDevice } from "./fixtures/synthetic-bridge.js";
import { saw, silence, wav } from "./fixtures/synthetic-audio.js";

// The sound to reach: a saw filtered at 2.6 kHz. A candidate's Filter Freq (0–1) sets its cutoff from 200 Hz to 8.2 kHz.
const reference = wav("goal-reference.wav", saw(1.6, 110, 2600));
const cutoff = (value: number) => Math.round(200 + value * 8000);
const renders = new Map<number, string>();
const render = (_source: string, devices: readonly FixtureDevice[]) => {
  const hz = cutoff(devices[0]?.params.find((param) => param.name === "Filter Freq")?.value ?? 0.5);
  const bucket = Math.round(hz / 50) * 50;
  if (!renders.has(bucket)) renders.set(bucket, wav(`goal-${bucket}.wav`, saw(1.6, 110, bucket)));
  return renders.get(bucket)!;
};
const operator = (filter: number): FixtureDevice[] => [{ name: "Operator", className: "Operator", params: [
  { name: "Device On", value: 1, min: 0, max: 1 }, { name: "Filter Freq", value: filter, min: 0, max: 1 }, { name: "Volume", value: 0.8, min: 0, max: 1 },
  // A knob Live won't set: it leaves the search instead of stopping it.
  { name: "Stuck Tone", value: 0.5, min: 0, max: 1 } ] }];

function memoryGoals(): GoalStore & { kept: Map<string, GoalState> } {
  const kept = new Map<string, GoalState>();
  return { kept, async load(place) { return structuredClone(kept.get(place)); }, async save(place, state) { kept.set(place, structuredClone(state)); }, async clear(place) { kept.delete(place); } };
}

/** A session over the synthetic bridge whose model, asked to set a goal up or leap, auditions tracks named "Kumi · Goal · …". */
function rig(goals = memoryGoals(), renderWith: typeof render = render, playbook?: PlaybookStore, idleTimeoutMs?: number) {
  const events: SessionEvent[] = [];
  const asked: string[] = [];
  let connection: ((state: "connected" | "connecting" | "disconnected" | "error") => void) | undefined;
  let session!: ReturnType<typeof createSession>;
  const b = bridge({ transport: true, version: "1.0.49", tempo: 480, renders: renderWith,
    extraTracks: [{ name: "Kumi · Goal · Dark", devices: operator(0.05) }, { name: "Kumi · Goal · Bright", devices: operator(0.95) }, { name: "Kumi · Goal · Wide", devices: operator(0.6) }],
    onConnection: (state) => connection?.(state), onAudition: (event) => session.watch?.(event) });
  const call = async (tools: readonly KernelTool[], name: string, input: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute(input, AbortSignal.timeout(60_000));
  session = createSession({
    onEvent: (event) => events.push(event), timeoutMs: 10_000, cancelGraceMs: 10, closeTimeoutMs: 100, goals, goalRandom: seeded(5), ...(playbook ? { playbook } : {}), ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    goalBudget: { target: 99, leapEvery: 3, stallGenerations: 99 },
    kernelFactory: async ({ tools }) => ({
      async run(input, _signal, emit) {
        asked.push(input.split("<current_observation")[0]!);
        const tracks = JSON.parse((await call(tools, "live_discover", { kind: "track", fields: ["name"] })).text).live.items as { ref: string; name: string }[];
        const ref = (name: string) => tracks.find((track) => track.name === name)!.ref;
        const span = { from_beat: 8, beats: 4, reference, focus: "sound" };
        if (input.includes("Set the search up")) await call(tools, "audition", { candidates: [{ track: ref("Kumi · Goal · Dark"), label: "Dark Operator" }, { track: ref("Kumi · Goal · Bright"), label: "Bright Operator" }], ...span });
        else if (input.includes("structural leap")) { emit({ type: "text", text: "A third Operator, wider open." }); await call(tools, "audition", { candidates: [{ track: ref("Kumi · Goal · Wide"), label: "Wide Operator" }], ...span }); }
        return { stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
      async close() {},
    }),
    integrationFactory: (listener) => { connection = listener; return b.integration; },
  });
  const statuses = () => events.filter((event): event is GoalStatus => event.type === "goal");
  return { b, session, events, asked, goals, statuses };
}

test("a goal: the model sets up candidates, the search renders a generation at a time and climbs, the model leaps, and stop leaves the best on a track of its own", async () => {
  const lessons: Lesson[] = [];
  const playbook: PlaybookStore = { async list() { return structuredClone(lessons); }, async save(next) { lessons.splice(0, lessons.length, ...structuredClone([...next])); } };
  const r = rig(memoryGoals(), render, playbook);
  await r.session.start();
  const running = r.session.goal!("make my pad sound like the reference");
  // Let it search a few generations, past a leap.
  while ((r.statuses().at(-1)?.generation ?? 0) < 7) await delay(50);
  assert.equal(await r.session.stopGoal!(), true);
  await running;
  const last = r.statuses().at(-1)!;
  assert.equal(last.state, "done", last.why);
  assert.equal(last.why, "stopped");
  assert.equal(last.candidates, 3, "the leap's candidate joined the search");
  assert.ok(last.best!.score > (last.first ?? 0), `it climbed: ${last.first} → ${last.best!.score}`);
  assert.ok(last.rendered >= 14, "every slot rendered each generation");
  assert.equal(last.idea, "A third Operator, wider open.");
  assert.match(r.asked[0]!, /^\[Kumi goal\] make my pad sound like the reference[\s\S]*Set the search up/);
  assert.ok(r.asked.some((prompt) => /Make a structural leap/.test(prompt)), "the model was asked to leap");
  // The best, on a track of its own, with the leader's values; every candidate chain ends in a limiter; the scratch tracks are gone; Main is back.
  const names = r.b.trackNames();
  assert.ok(names.includes("Kumi · Goal best"), names.join(", "));
  assert.equal(names.filter((name) => name.startsWith("Kumi · Goal best")).length, 1, "one best: a better one replaces the last");
  const best = r.b.devicesOf("Kumi · Goal best")!;
  assert.equal(best.at(-1)!.className, "Limiter");
  assert.equal(best.at(-1)!.params[0]!.value, 0.25, "its input at -12 dB, where it only catches a runaway");
  assert.ok(Math.abs(cutoff(best[0]!.params[1]!.value) - 2600) < 1400, `the best's cutoff ${cutoff(best[0]!.params[1]!.value)} Hz is near the reference's`);
  assert.ok(!names.some((name) => name.startsWith("Kumi · render")), `no scratch tracks left: ${names.join(", ")}`);
  assert.equal(r.b.main.volume, 0.85);
  assert.equal(r.b.devicesOf("Kumi · Goal · Dark")![0]!.params[0]!.value, 1, "the search never switches a device off");
  // Done: the top two stay (muted, to A/B); one the model didn't make this session can't be removed, so it's muted and said.
  const muted = r.b.requests.filter((request) => request.name === "live_mixer_preview" && request.args.mute === true).length;
  assert.equal(muted, 3);
  assert.ok(r.events.some((event) => event.type === "notice" && /stays, muted/.test(event.message)));
  // A lesson for the next match or goal: what led, and the generations that raised it.
  await delay(20);
  assert.equal(lessons.length, 1);
  assert.match(lessons[0]!.winner, /Operator \(Operator → Limiter\)/);
  assert.ok(lessons[0]!.to > lessons[0]!.from);
  // Kept on disk as done.
  assert.equal([...r.goals.kept.values()][0]!.status, "done");
  assert.ok(r.events.some((event) => event.type === "notice" && /^Goal done: .*% \(.*\) · \d+ generations · \d+ candidates · the best is on “Kumi · Goal best”/.test(event.message)));
  await r.session.close();
});

test("Esc pauses a goal (kept, the best copied, Live as it was); /goal picks it up where it was, and a new session can too", async () => {
  const goals = memoryGoals();
  const r = rig(goals);
  await r.session.start();
  const running = r.session.goal!("make my pad sound like the reference");
  while ((r.statuses().at(-1)?.generation ?? 0) < 2) await delay(50);
  await r.session.cancel();
  await running.catch(() => {});
  const paused = r.statuses().at(-1)!;
  assert.equal(paused.state, "paused");
  assert.equal(r.b.main.volume, 0.85);
  assert.ok(!r.b.trackNames().some((name) => name.startsWith("Kumi · render")));
  const kept = [...goals.kept.values()][0]!;
  assert.equal(kept.status, "paused");
  const generation = kept.generation;
  await r.session.close();
  // Kumi restarted: the goal is picked up from its file, its slots found by their tracks' names.
  const again = rig(goals);
  await again.session.start();
  const resumed = again.session.goal!();
  while ((again.statuses().at(-1)?.generation ?? 0) < generation + 2) await delay(50);
  assert.equal(again.asked.filter((prompt) => /Set the search up/.test(prompt)).length, 0, "no setup again");
  assert.ok((again.statuses().at(-1)!.best?.score ?? 0) >= (paused.best?.score ?? 0), "it carries on from its best");
  await again.session.stopGoal!();
  await resumed;
  await again.session.close();
});

test("a goal whose renders stop coming through pauses and says so, rather than searching blind", async () => {
  let silent = false;
  const quiet = wav("goal-silent.wav", silence(1.6));
  const r = rig(memoryGoals(), (source, devices) => (silent ? quiet : render(source, devices)));
  await r.session.start();
  const running = r.session.goal!("make my pad sound like the reference");
  while ((r.statuses().at(-1)?.generation ?? 0) < 1) await delay(50);
  silent = true;
  await running;
  const last = r.statuses().at(-1)!;
  assert.equal(last.state, "paused");
  assert.match(last.why ?? "", /nothing came through the last renders/);
  assert.equal(r.b.main.volume, 0.85);
  await r.session.close();
});

test("a goal is at work the whole time: an answer's quiet timer doesn't call it stuck", async () => {
  // Each generation takes over a second here; the quiet timer is 0.4 s.
  const r = rig(memoryGoals(), render, undefined, 400);
  await r.session.start();
  const running = r.session.goal!("make my pad sound like the reference");
  while ((r.statuses().at(-1)?.generation ?? 0) < 3) await delay(50);
  await r.session.stopGoal!();
  await running;
  assert.equal(r.statuses().at(-1)!.why, "stopped", "stopped by /goal stop, not as stuck");
  assert.ok(!r.events.some((event) => event.type === "error" && /without progress/.test(event.message)), JSON.stringify(r.events.filter((event) => event.type === "error")));
  await r.session.close();
});
