/** Runs an analysis off the app's main thread, so the screen keeps drawing while Kumi listens. */
import { parentPort, workerData } from "node:worker_threads";
import { analyzeFile, type AnalyzeOptions } from "./analyze.js";
import { AudioError } from "./decode.js";

const { path, options, as } = workerData as { path: string; options: Omit<AnalyzeOptions, "signal">; as?: { name: string; format?: string } };
analyzeFile(path, options).then(
  // Named as the producer's file (not a converted copy), in its own format.
  (result) => parentPort!.postMessage({ result: { ...result, ...(as ? { file: as.name.split(/[\\/]/).at(-1) ?? as.name } : {}), ...(as?.format ? { format: as.format } : {}) } }),
  (error: unknown) => parentPort!.postMessage({ error: { message: error instanceof Error ? error.message : String(error), audio: error instanceof AudioError } }),
);
