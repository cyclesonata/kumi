/** A video's speech as timed lines, transcribed on this computer by whisper.cpp. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Cue } from "./captions.js";

/** The model for a video's language: English's own, or the one that knows many languages. */
export const speechModelFor = (language: string | undefined) => (!language || /^en\b/i.test(language) ? "ggml-small.en-q5_1.bin" : "ggml-small-q5_1.bin");

export interface TranscribeOptions {
  /** The spoken language's code ("en", "de"); left out, English. */
  language?: string;
  /** Words to expect (the video's title, the names of Live's devices), so they're heard right. */
  prompt?: string;
  signal?: AbortSignal;
  /** How far it is, 0–100. */
  onProgress?: (percent: number) => void;
  timeoutMs?: number;
  /**
   * How much of whisper's 30-second window to read, in its frames (50 a second, at most 1500): a
   * short recording is written down several times faster when the silence after it isn't read.
   */
  audioContext?: number;
  /** whisper.cpp's voice activity model: only stretches of speech are written down, never music or noise. */
  vad?: string;
}

/** Transcribe `wav` (16 kHz mono) with `whisper` and `model`: timed lines, as captions would be. */
export function transcribe(whisper: string, model: string, wav: string, options: TranscribeOptions = {}): Promise<Cue[]> {
  const out = join(dirname(wav), `.transcript-${randomUUID()}`);
  const language = options.language?.split(/[-_]/)[0]?.toLowerCase();
  const args = ["-m", model, "-f", wav, "-oj", "-of", out, "-pp", "-sns", "-l", model.includes(".en") ? "en" : language && /^[a-z]{2,3}$/.test(language) ? language : "auto",
    ...(options.prompt ? ["--prompt", options.prompt.slice(0, 600)] : []),
    ...(options.audioContext && options.audioContext < 1500 ? ["-ac", String(Math.max(64, Math.round(options.audioContext)))] : []),
    ...(options.vad ? ["--vad", "-vm", options.vad] : [])];
  return new Promise<Cue[]>((resolve, reject) => {
    const child = spawn(whisper, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) });
    let tail = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      for (const match of chunk.matchAll(/progress\s*=\s*(\d+)%/g)) options.onProgress?.(Number(match[1]));
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(tail.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? `whisper.cpp stopped (${code})`);
        resolve(cuesFromWhisper(await readFile(`${out}.json`, "utf8")));
      } catch (error) { reject(error); } finally { await rm(`${out}.json`, { force: true }); }
    });
  });
}

/** whisper.cpp's JSON output as timed lines. */
export function cuesFromWhisper(json: string): Cue[] {
  let result: { transcription?: { offsets?: { from?: number; to?: number }; text?: string }[] };
  try { result = JSON.parse(json) as typeof result; } catch { return []; }
  return (Array.isArray(result.transcription) ? result.transcription : []).flatMap((segment) => {
    const text = String(segment?.text ?? "").replace(/\s+/g, " ").trim();
    const start = Number(segment?.offsets?.from) / 1000; const end = Number(segment?.offsets?.to) / 1000;
    // Whisper marks music and silence in brackets; those aren't words.
    return text && !/^[[(].*[\])]$/.test(text) && Number.isFinite(start) && Number.isFinite(end) ? [{ start, end, text }] : [];
  });
}

/** What to tell whisper to expect: the title, and Live's names a tutorial is likely to say. */
export function speechPrompt(title: string): string {
  return `${title.slice(0, 200)}. Ableton Live tutorial: Operator, Wavetable, Drift, Simpler, Sampler, Drum Rack, Instrument Rack, Saturator, Dynamic Tube, EQ Eight, EQ Three, Glue Compressor, OTT, Roar, Auto Filter, Utility, reverb, delay, LFO, envelope, oscillator, detune, sidechain, dry/wet, Serum, Vital.`;
}
