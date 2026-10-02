/** Measures sounds for the library off the learner's main thread, one at a time, as they're sent. */
import { parentPort } from "node:worker_threads";
import { learnSound } from "./learn.js";

parentPort!.on("message", (job: { id: number; path: string; relative: string; size: number; mtime: number; start?: number; seconds?: number }) => {
  learnSound(job.path, job.relative, job.size, job.mtime, { ...(job.start !== undefined ? { start: job.start } : {}), ...(job.seconds !== undefined ? { seconds: job.seconds } : {}) }).then(
    (entry) => parentPort!.postMessage({ id: job.id, entry }),
    (error: unknown) => parentPort!.postMessage({ id: job.id, entry: { path: job.path, size: job.size, mtime: job.mtime, error: error instanceof Error ? error.message.slice(0, 160) : "unreadable" } }),
  );
});
