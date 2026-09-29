/**
 * Listening, for the model: an analysis runs in a worker thread (the screen keeps drawing), and a
 * mix is set against a reference with the loudness matched, as an engineer would A/B them.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Analysis, AnalyzeOptions } from "./analyze.js";
import { AudioError, prepareAudio } from "./decode.js";

export { ANALYSIS_VERSION, BANDS, analyzeFile, type Analysis, type AnalyzeOptions, type SoundAnalysis } from "./analyze.js";
export { AUDIO_EXTENSIONS, AudioError, openAudio } from "./decode.js";

/** Analyze a file in a worker thread; `signal` stops it, and anything it started. */
export async function hear(path: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  const { signal, ...rest } = options;
  signal?.throwIfAborted();
  // Other formats are converted here, where stopping stops the converter too; the worker reads the
  // WAV, and the converted copy is deleted however the listening ends.
  const prepared = await prepareAudio(path, signal ? { signal } : {});
  try { return await inWorker(prepared.path, { ...rest }, { name: path, ...(prepared.format ? { format: prepared.format } : {}) }, signal); }
  finally { await prepared.cleanup(); }
}

function inWorker(path: string, options: Omit<AnalyzeOptions, "signal">, as: { name: string; format?: string }, signal: AbortSignal | undefined): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { path, options, as } });
    const stop = () => { void worker.terminate(); reject(signal!.reason ?? new Error("Listening was stopped.")); };
    signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (message: { result?: Analysis; error?: { message: string; audio: boolean } }) => {
      signal?.removeEventListener("abort", stop);
      void worker.terminate();
      if (message.result) resolve(message.result);
      else reject(message.error?.audio ? new AudioError(message.error.message) : new Error(message.error?.message ?? "Listening failed."));
    });
    worker.once("error", (error) => { signal?.removeEventListener("abort", stop); reject(error); });
  });
}

/** "~/Music/ref.wav" and absolute paths; a relative path is taken from the home folder. */
export function audioPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(1));
  return isAbsolute(trimmed) ? trimmed : join(homedir(), trimmed);
}

export interface Comparison {
  kumiAudioComparison: 1;
  mine: string;
  reference: string;
  /** Plain-language differences, biggest first. */
  headlines: string[];
  loudness: { mineLufs: number | null; referenceLufs: number | null; differenceLu: number | null; truePeak: [number, number]; range: [number | null, number | null] };
  /** Mine minus reference, per band, with the overall loudness matched (dB). */
  balance: { band: string; hz: string; difference: number }[];
  tilt: [number, number];
  width: { band: string; mine: number; reference: number }[];
  stereo: { correlation: [number, number]; lowEndMono: [boolean, boolean] } | null;
  dynamics: { crestDb: [number, number]; peakToLoudnessDb: [number | null, number | null]; onsetsPerSecond: [number, number] };
  tempo: [number | null, number | null];
  key: [string | null, string | null];
}

const pair = <T>(a: T, b: T): [T, T] => [a, b];
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toFixed(1)}`;

/** Set one analysis against a reference: what's louder, brighter, wider, more compressed. */
export function compare(mine: Analysis, reference: Analysis): Comparison {
  // Band levels are shares of each file's own total, so the comparison is loudness-matched already.
  const balance = mine.balance.bands.map((band, index) => ({ band: band.name, hz: band.hz, difference: Math.round((band.db - reference.balance.bands[index]!.db) * 10) / 10 }));
  const width = mine.balance.bands.map((band, index) => ({ band: band.name, mine: band.width, reference: reference.balance.bands[index]!.width }))
    .filter((band) => Math.abs(band.mine - band.reference) >= 0.08);
  const headlines: { text: string; weight: number }[] = [];
  const loudnessDifference = mine.loudness.integratedLufs !== null && reference.loudness.integratedLufs !== null
    ? Math.round((mine.loudness.integratedLufs - reference.loudness.integratedLufs) * 10) / 10 : null;
  if (loudnessDifference !== null && Math.abs(loudnessDifference) >= 1) headlines.push({ text: `${Math.abs(loudnessDifference).toFixed(1)} LU ${loudnessDifference < 0 ? "quieter" : "louder"} overall (${mine.loudness.integratedLufs} vs ${reference.loudness.integratedLufs} LUFS)`, weight: Math.abs(loudnessDifference) });
  for (const band of balance) if (Math.abs(band.difference) >= 1.5) headlines.push({ text: `${band.band} (${band.hz} Hz) ${signed(band.difference)} dB ${band.difference > 0 ? "over" : "under"} the reference`, weight: Math.abs(band.difference) });
  const tiltDifference = mine.balance.tiltDbPerOctave - reference.balance.tiltDbPerOctave;
  if (Math.abs(tiltDifference) >= 0.7) headlines.push({ text: `${tiltDifference > 0 ? "brighter" : "darker"} overall (tilt ${mine.balance.tiltDbPerOctave} vs ${reference.balance.tiltDbPerOctave} dB/octave)`, weight: Math.abs(tiltDifference) * 2 });
  for (const band of width) headlines.push({ text: `${band.band} ${band.mine > band.reference ? "wider" : "narrower"} (width ${band.mine} vs ${band.reference})`, weight: Math.abs(band.mine - band.reference) * 8 });
  const crest = mine.dynamics.crestDb - reference.dynamics.crestDb;
  if (Math.abs(crest) >= 2) headlines.push({ text: `${crest > 0 ? "more dynamic, less compressed" : "more compressed"} (crest ${mine.dynamics.crestDb} vs ${reference.dynamics.crestDb} dB)`, weight: Math.abs(crest) });
  if (mine.stereo && reference.stereo && mine.stereo.lowEndMono !== reference.stereo.lowEndMono) headlines.push({ text: `low end ${mine.stereo.lowEndMono ? "mono, the reference's isn't" : "not mono, the reference's is"}`, weight: 2 });
  return {
    kumiAudioComparison: 1, mine: mine.file, reference: reference.file,
    headlines: headlines.sort((a, b) => b.weight - a.weight).slice(0, 8).map((headline) => headline.text),
    loudness: { mineLufs: mine.loudness.integratedLufs, referenceLufs: reference.loudness.integratedLufs, differenceLu: loudnessDifference,
      truePeak: pair(mine.loudness.truePeakDbtp, reference.loudness.truePeakDbtp), range: pair(mine.loudness.rangeLu, reference.loudness.rangeLu) },
    balance, tilt: pair(mine.balance.tiltDbPerOctave, reference.balance.tiltDbPerOctave), width,
    stereo: mine.stereo && reference.stereo ? { correlation: pair(mine.stereo.correlation, reference.stereo.correlation), lowEndMono: pair(mine.stereo.lowEndMono, reference.stereo.lowEndMono) } : null,
    dynamics: { crestDb: pair(mine.dynamics.crestDb, reference.dynamics.crestDb), peakToLoudnessDb: pair(mine.dynamics.peakToLoudnessDb, reference.dynamics.peakToLoudnessDb),
      onsetsPerSecond: pair(mine.dynamics.onsetsPerSecond, reference.dynamics.onsetsPerSecond) },
    tempo: pair(mine.tempo?.bpm ?? null, reference.tempo?.bpm ?? null), key: pair(mine.key?.name ?? null, reference.key?.name ?? null),
  };
}
