/** Runs an analysis off the app's main thread, so the screen keeps drawing while Kumi listens. */
import { parentPort, workerData } from "node:worker_threads";
import { analyzeFile, type AnalyzeOptions } from "./analyze.js";
import { AudioError } from "./decode.js";

const { path, options } = workerData as { path: string; options: Omit<AnalyzeOptions, "signal"> };
analyzeFile(path, options).then(
  (result) => parentPort!.postMessage({ result }),
  (error: unknown) => parentPort!.postMessage({ error: { message: error instanceof Error ? error.message : String(error), audio: error instanceof AudioError } }),
);
