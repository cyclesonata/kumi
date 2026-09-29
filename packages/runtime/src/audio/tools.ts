/** The listen tool: what the model uses to hear files, alone or against a reference. */
import type { HeardEvent, KernelTool } from "../core/contracts.js";
import { AudioError, audioPath, compare, hear, type Analysis } from "./index.js";

export const LISTEN_TOOL = "listen";

const DESCRIPTION = [
  "Hear audio the producer points you to: a reference track, a sample, a bounce or a recording, by its file path (find_samples finds audio files by words in folders the producer names, such as ~/Downloads).",
  "Measures loudness (integrated LUFS, true peak, loudness range), tonal balance in named bands, stereo width per band, dynamics, tempo, key and the energy over time as a small text spectrogram;",
  "for a single sound (a note, a hit, a short sample), also its pitch, harmonics (which waveform it's like), envelope and movement (filter opening or closing, wobble or tremolo rate, at the tempo when known).",
  "With compare_to, sets file against the reference with loudness matched and lists what differs most (bands, brightness, width, compression, loudness).",
  "Use it before matching a mix to a reference (EQ, compression, width, loudness moves) or rebuilding a sound (harmonics to oscillators and filter, envelope to the amp and filter envelopes, movement to an LFO's rate and target).",
  "Say what you heard in the producer's terms, not as a data dump.",
].join(" ");

const trimSound = (analysis: Analysis) => analysis;

/**
 * The listen tool. `resolve` turns what the model names into a file (a path, or something in the
 * Set when the integration can find its file); `onEvent` tells the app what was heard.
 */
export function listeningTools(options: { onEvent: (event: HeardEvent) => void; resolve?: (named: string, signal: AbortSignal) => Promise<string | undefined> }): KernelTool[] {
  const locate = async (named: string, signal: AbortSignal) => (await options.resolve?.(named, signal)) ?? audioPath(named);
  return [{
    name: LISTEN_TOOL, description: DESCRIPTION,
    inputSchema: { type: "object", additionalProperties: false, required: ["file"], properties: {
      file: { type: "string", minLength: 1, maxLength: 1024, description: "The audio file: an absolute path or ~/…" },
      compare_to: { type: "string", minLength: 1, maxLength: 1024, description: "A reference to set file against" },
      focus: { type: "string", enum: ["mix", "sound"], description: "mix for a song or stem, sound for one note or hit; left out, chosen by length" },
      from_seconds: { type: "number", minimum: 0, description: "Where to start listening" },
      seconds: { type: "number", exclusiveMinimum: 0, maximum: 720, description: "How long to listen" } } },
    async execute(input, signal) {
      const file = typeof input.file === "string" ? input.file : "";
      const focus: "mix" | "sound" | undefined = input.focus === "mix" || input.focus === "sound" ? input.focus : undefined;
      const common = { ...(focus ? { focus } : {}),
        ...(typeof input.from_seconds === "number" ? { start: input.from_seconds } : {}), ...(typeof input.seconds === "number" ? { seconds: input.seconds } : {}), signal };
      try {
        const mine = await hear(await locate(file, signal), common);
        if (typeof input.compare_to !== "string") {
          options.onEvent({ type: "heard", file: mine.file, summary: summary(mine), bands: mine.balance.bands.map((band) => band.db) });
          return { text: JSON.stringify(trimSound(mine)) };
        }
        const reference = await hear(await locate(input.compare_to, signal), { ...common, ...(mine.analyzed.focus ? { focus: mine.analyzed.focus } : {}) });
        const comparison = compare(mine, reference);
        options.onEvent({ type: "heard", file: mine.file, summary: summary(mine), bands: mine.balance.bands.map((band) => band.db),
          compared: { reference: reference.file, summary: summary(reference), differences: comparison.balance.map((band) => band.difference), headlines: comparison.headlines } });
        return { text: JSON.stringify({ comparison, mine: { loudness: mine.loudness, tempo: mine.tempo, key: mine.key }, reference: { loudness: reference.loudness, tempo: reference.tempo, key: reference.key } }) };
      } catch (error) {
        signal.throwIfAborted();
        return { text: error instanceof AudioError ? error.message : `Kumi couldn't listen to that: ${error instanceof Error ? error.message.slice(0, 200) : "it failed"}`, isError: true };
      }
    },
  }];
}

/** "−8.4 LUFS · 128 BPM · F minor" or, for a sound, "F1 · saw-like · attack 4 ms". */
export function summary(analysis: Analysis): string {
  const sound = analysis.sound;
  if (sound) {
    return [sound.pitch ? sound.pitch.note : "unpitched", sound.harmonics ? sound.harmonics.shape.split(" (")[0] : undefined,
      `attack ${sound.envelope.attackMs} ms`, sound.movement.lfo ? `${sound.movement.lfo.hz} Hz ${sound.movement.lfo.on.split(" ")[0]} LFO` : undefined].filter(Boolean).join(" · ");
  }
  return [analysis.loudness.integratedLufs !== null ? `${analysis.loudness.integratedLufs} LUFS` : "silent", analysis.tempo ? `${Math.round(analysis.tempo.bpm)} BPM` : undefined,
    analysis.key?.name].filter(Boolean).join(" · ");
}
