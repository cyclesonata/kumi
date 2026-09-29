/**
 * Which moments of a tutorial to look at: where the narration names a device, a setting or a
 * value, or points at the screen ("like this", "about here"), a little after it's said (the
 * screen shows it then); chapter starts; and failing captions, moments spread through it.
 */
import type { Cue } from "./captions.js";

const DEVICES = [
  "operator", "wavetable", "drift", "meld", "analog", "simpler", "sampler", "drum rack", "drum sampler", "instrument rack", "audio effect rack", "midi effect rack", "rack",
  "auto filter", "eq eight", "eq three", "channel eq", "glue compressor", "compressor", "multiband", "ott", "saturator", "roar", "overdrive", "pedal", "amp", "cabinet", "redux",
  "erosion", "vinyl distortion", "dynamic tube", "drum buss", "reverb", "hybrid reverb", "delay", "echo", "grain delay", "beat repeat", "chorus", "phaser", "flanger", "shifter",
  "frequency shifter", "spectral", "corpus", "resonators", "vocoder", "utility", "limiter", "gate", "envelope follower", "lfo", "shaper", "arpeggiator", "chord", "scale", "velocity",
  "random", "note length", "pitch", "sidechain", "send", "return", "macro", "chain", "resampling", "bounce", "freeze", "automation", "clip", "warp", "serum", "vital",
];
const SETTINGS = [
  "cutoff", "frequency", "resonance", "drive", "dry/wet", "dry wet", "mix", "attack", "decay", "sustain", "release", "threshold", "ratio", "gain", "volume", "pan", "width",
  "detune", "voices", "unison", "coarse", "fine", "octave", "semitone", "algorithm", "oscillator", "osc", "waveform", "saw", "square", "sine", "envelope", "amount", "depth",
  "rate", "sync", "feedback", "time", "size", "decay time", "pre-delay", "filter", "low pass", "lowpass", "high pass", "highpass", "band pass", "shelf", "q", "slope", "mode",
  "knee", "makeup", "lookahead", "ceiling", "glide", "portamento", "transpose", "tempo", "swing", "quantize", "grid",
];
const POINTING = /\b(like (this|that|so)|this (knob|one|here|parameter|setting)|right (here|there)|over here|about (here|there)|all the way|set (it|this|that) to|turn (it|this|that)|bring (it|this|that)|drag|dial|map (it|this|that)|you can see|as you can see|looks like)\b/i;
const VALUE = /\b\d+(\.\d+)?\s?(%|db|hz|khz|ms|s\b|semitones?|cents?|bars?|beats?)|\b1\/(4|8|16|32)\b|\b\d{2,3}\s?(percent|bpm)\b/i;

function score(text: string): number {
  const lower = text.toLowerCase();
  let points = 0;
  for (const device of DEVICES) if (lower.includes(device)) points += 3;
  for (const setting of SETTINGS) if (new RegExp(`\\b${setting.replace(/[/-]/g, "\\$&")}\\b`).test(lower)) points += 2;
  if (POINTING.test(text)) points += 3;
  if (VALUE.test(text)) points += 2;
  return points;
}

export interface MomentOptions { from: number; to: number; count: number; chapters?: readonly { start: number; title: string }[] }

/** Up to `count` times (seconds), in order, between `from` and `to`. */
export function chooseMoments(cues: readonly Cue[], options: MomentOptions): number[] {
  const { from, to } = options; const count = Math.max(0, Math.min(16, Math.floor(options.count)));
  if (!count || !(to > from)) return [];
  const span = to - from;
  // A moment a little after the words (the screen shows it then), inside the range.
  const inRange = (time: number) => Math.min(to - 0.5, Math.max(from + 0.5, time));
  const candidates = cues.filter((cue) => cue.end >= from && cue.start <= to).map((cue) => ({ at: inRange(cue.start + Math.min(2.5, Math.max(1, (cue.end - cue.start) / 2))), points: score(cue.text) }))
    .filter((candidate) => candidate.points > 0);
  for (const chapter of options.chapters ?? []) if (chapter.start >= from && chapter.start < to) candidates.push({ at: inRange(chapter.start + 3), points: 4 });
  // Best first, keeping moments apart so they cover the video, not one busy minute.
  const gap = Math.max(4, span / (count * 2.5));
  const chosen: number[] = [];
  for (const candidate of candidates.sort((a, b) => b.points - a.points || a.at - b.at)) {
    if (chosen.length >= count) break;
    if (chosen.every((time) => Math.abs(time - candidate.at) >= gap)) chosen.push(candidate.at);
  }
  // Too few telling moments (or no captions): fill with moments spread through, past the intro.
  for (let index = 0; chosen.length < count && index < count * 3; index++) {
    const at = inRange(from + span * (0.08 + 0.84 * ((index + 0.5) / (count * 1.5))));
    if (chosen.every((time) => Math.abs(time - at) >= gap / 2)) chosen.push(at);
  }
  return chosen.sort((a, b) => a - b).map((time) => Math.round(time * 10) / 10);
}
