/**
 * Kumi's library learner: a process of its own at the lowest priority, so learning never competes
 * with Live or with Kumi's screen. It learns what's new, says how it's going, holds while Live
 * plays, and ends when it's done or when Kumi goes.
 */
import { constants, setPriority } from "node:os";
import { learn, type LearnProgress } from "./learn.js";
import { planLearning, type PlanOptions } from "./plan.js";
import { acquireLock, writeState } from "./state.js";

try { setPriority(constants.priority.PRIORITY_LOW); } catch { /* not allowed here: learning still holds while Live plays */ }

const stop = new AbortController();
let paused = false;
let wake: (() => void) | undefined;
const gate = () => (paused ? new Promise<void>((resolve) => { wake = resolve; }) : Promise.resolve());
const send = (message: object) => { try { process.send?.(message); } catch { /* Kumi went */ } };

// Kumi went away: stop, keeping what's learned.
process.on("disconnect", () => { stop.abort(); setTimeout(() => process.exit(0), 2_000).unref(); });
process.on("message", (message: { type: string; options?: PlanOptions & { paused?: boolean; rebuild?: boolean } }) => {
  if (message.type === "pause") paused = true;
  else if (message.type === "resume") { paused = false; wake?.(); wake = undefined; }
  else if (message.type === "stop") { stop.abort(); paused = false; wake?.(); }
  else if (message.type === "learn" && message.options) void run(message.options);
});

async function run(options: PlanOptions & { paused?: boolean; rebuild?: boolean }) {
  paused = options.paused === true;
  const release = await acquireLock(options.dir);
  if (!release) { send({ type: "busy" }); process.exit(0); }
  let last = 0; let latest: LearnProgress | undefined;
  const report = (progress: LearnProgress) => {
    latest = progress;
    send({ type: "progress", progress });
    if (Date.now() - last > 2_000 || progress.phase === "done") { last = Date.now(); void writeState(options.dir, progress).catch(() => {}); }
  };
  try {
    const progress = await learn({ ...await planLearning(options), ...(options.rebuild ? { rebuild: true } : {}), signal: stop.signal, gate, onProgress: report });
    latest = progress;
    await writeState(options.dir, progress).catch(() => {});
    send({ type: "done", progress });
  } catch (error) {
    if (!stop.signal.aborted) send({ type: "failed", message: error instanceof Error ? error.message.slice(0, 300) : "learning failed" });
  } finally {
    // Stopped partway: no run is under way any more; the next one carries on from what's written.
    if (latest && latest.phase !== "done") await writeState(options.dir, latest, true).catch(() => {});
    await release();
    process.exit(0);
  }
}
