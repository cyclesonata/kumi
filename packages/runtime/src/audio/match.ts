/**
 * How close a render is to a reference, as one number to watch rise while matching a sound, and the
 * differences behind it, biggest first, in words the model can act on ("brighter above 4 kHz by
 * ~3 dB", "attack too slow", "too dense"). Each feature is a similarity from 0 to 1; the score is
 * their weighted mean, weighted for a single sound (timbre, envelope, pitch) or a section (balance,
 * density and rhythm too). The target is a similar character: a patch rarely matches a finished mix.
 */
import type { Analysis } from "./analyze.js";

export interface Feature {
  name: "balance" | "tilt" | "brightness" | "movement" | "envelope" | "pitch" | "density" | "width";
  /** 0 to 100. */
  similarity: number;
  weight: number;
  /** What to change, when it's far enough off to matter. */
  gap?: string;
}

export interface Closeness {
  /** 0 to 100: the weighted mean of the features both sides have. */
  score: number;
  focus: "sound" | "section";
  features: Feature[];
  /** The biggest gaps, in words, biggest first. */
  gaps: string[];
}

/** Weights: a single sound is its timbre, envelope and pitch; a section adds balance, density and rhythm. */
const WEIGHTS: Record<Closeness["focus"], Record<Feature["name"], number>> = {
  sound: { balance: 0.22, tilt: 0.1, brightness: 0.14, movement: 0.06, envelope: 0.24, pitch: 0.16, density: 0.03, width: 0.05 },
  section: { balance: 0.24, tilt: 0.1, brightness: 0.1, movement: 0.1, envelope: 0.1, pitch: 0.06, density: 0.2, width: 0.1 },
};

const near = (distance: number, scale: number) => Math.exp(-Math.abs(distance) / scale);
const ratio = (a: number, b: number) => Math.log2(Math.max(a, 1e-6) / Math.max(b, 1e-6));
const std = (values: readonly number[]) => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};
const signed = (value: number) => `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;

/** Mine against the reference. `focus` defaults to what the analyses say (a sound, or a mix: a section). */
export function closeness(mine: Analysis, reference: Analysis, focus?: Closeness["focus"]): Closeness {
  const kind = focus ?? (mine.analyzed.focus === "sound" && reference.analyzed.focus === "sound" ? "sound" : "section");
  const features: Omit<Feature, "weight">[] = [];

  // Band balance, loudness-matched (each band is a share of its own file's total). Bands both leave
  // nearly empty don't count, so a bass patch isn't judged by its air band.
  const bands = mine.balance.bands.map((band, index) => ({ name: band.name, hz: band.hz, mine: band.db, reference: reference.balance.bands[index]!.db }))
    .filter((band) => Math.max(band.mine, band.reference) > -45);
  if (bands.length) {
    const differences = bands.map((band) => band.mine - band.reference);
    // One empty band (an air band 40 dB down) mustn't outweigh the rest: each counts up to 15 dB.
    const mean = differences.reduce((sum, value) => sum + Math.min(15, Math.abs(value)), 0) / differences.length;
    const worst = bands.map((band, index) => ({ ...band, difference: differences[index]! })).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))[0]!;
    features.push({ name: "balance", similarity: near(mean, 5),
      ...(Math.abs(worst.difference) >= 2 ? { gap: `${worst.name} (${worst.hz} Hz) ${signed(worst.difference)} dB against the reference` } : {}) });
  }
  const tilt = mine.balance.tiltDbPerOctave - reference.balance.tiltDbPerOctave;
  features.push({ name: "tilt", similarity: near(tilt, 1.5), ...(Math.abs(tilt) >= 0.7 ? { gap: `${tilt > 0 ? "brighter" : "darker"} overall (${signed(tilt)} dB/octave)` } : {}) });
  const bright = ratio(mine.balance.centroidHz, reference.balance.centroidHz);
  features.push({ name: "brightness", similarity: near(bright, 0.6),
    ...(Math.abs(bright) >= 0.25 ? { gap: `centre of brightness ${Math.round(mine.balance.centroidHz)} Hz against ${Math.round(reference.balance.centroidHz)} Hz: ${bright > 0 ? "darken it" : "brighten it"}` } : {}) });
  // Movement: how much the loudness moves over time (a pumping or evolving part against a steady one).
  const moving = (analysis: Analysis) => std(analysis.overTime.lufs.filter((value): value is number => value !== null));
  const movement = moving(mine) - moving(reference);
  features.push({ name: "movement", similarity: near(movement, 3), ...(Math.abs(movement) >= 2 ? { gap: `${movement > 0 ? "moves more" : "steadier"} over time than the reference` } : {}) });
  // Envelope: attack and length for a sound; how punchy (crest) for a section.
  if (kind === "sound" && mine.sound && reference.sound) {
    const attack = ratio(mine.sound.envelope.attackMs + 1, reference.sound.envelope.attackMs + 1);
    const length = ratio(mine.sound.envelope.lengthMs + 1, reference.sound.envelope.lengthMs + 1);
    features.push({ name: "envelope", similarity: near(attack, 1.5) * 0.6 + near(length, 1) * 0.4,
      ...(Math.abs(attack) >= 1 ? { gap: `attack ${attack > 0 ? "too slow" : "too fast"} (${mine.sound.envelope.attackMs} ms against ${reference.sound.envelope.attackMs} ms)` }
        : Math.abs(length) >= 0.8 ? { gap: `${length > 0 ? "too long" : "too short"} (${mine.sound.envelope.lengthMs} ms against ${reference.sound.envelope.lengthMs} ms)` } : {}) });
  } else {
    const crest = mine.dynamics.crestDb - reference.dynamics.crestDb;
    features.push({ name: "envelope", similarity: near(crest, 4), ...(Math.abs(crest) >= 2.5 ? { gap: crest > 0 ? "punchier, with sharper peaks, than the reference" : "flatter, more compressed, than the reference" } : {}) });
  }
  // Pitch: the note for a sound, the key for a section, when both have one.
  if (mine.sound?.pitch && reference.sound?.pitch) {
    const semitones = 12 * Math.log2(mine.sound.pitch.hz / reference.sound.pitch.hz);
    features.push({ name: "pitch", similarity: near(semitones, 2), ...(Math.abs(semitones) >= 0.5 ? { gap: `pitch ${mine.sound.pitch.note} against ${reference.sound.pitch.note} (${signed(semitones)} semitones)` } : {}) });
  } else if (kind === "sound" && Boolean(mine.sound?.pitch) !== Boolean(reference.sound?.pitch)) {
    // One has a note and the other none (a tone against noise, say): a different kind of sound.
    features.push({ name: "pitch", similarity: 0.15, gap: reference.sound?.pitch ? `the reference is pitched (${reference.sound.pitch.note}); this has no clear note` : "the reference has no clear note; this is pitched" });
  } else if (mine.key && reference.key) {
    features.push({ name: "pitch", similarity: mine.key.name === reference.key.name ? 1 : 0.5, ...(mine.key.name !== reference.key.name ? { gap: `key ${mine.key.name} against ${reference.key.name}` } : {}) });
  }
  // Density and rhythm: how many onsets a second.
  const onsets = [mine.dynamics.onsetsPerSecond, reference.dynamics.onsetsPerSecond];
  if (onsets[0]! > 0.05 || onsets[1]! > 0.05) {
    const dense = ratio(onsets[0]! + 0.1, onsets[1]! + 0.1);
    features.push({ name: "density", similarity: near(dense, 0.8),
      ...(Math.abs(dense) >= 0.5 ? { gap: `${dense > 0 ? "too dense" : "too sparse"} (${onsets[0]} against ${onsets[1]} onsets a second)` } : {}) });
  }
  if (mine.stereo && reference.stereo) {
    const width = mine.stereo.width - reference.stereo.width;
    features.push({ name: "width", similarity: near(width, 0.25), ...(Math.abs(width) >= 0.15 ? { gap: `${width > 0 ? "wider" : "narrower"} than the reference` } : {}) });
  }

  const weights = WEIGHTS[kind];
  const weighted = features.map((feature) => ({ ...feature, weight: weights[feature.name] }));
  const total = weighted.reduce((sum, feature) => sum + feature.weight, 0);
  const score = total > 0 ? weighted.reduce((sum, feature) => sum + feature.similarity * feature.weight, 0) / total : 0;
  return {
    score: Math.round(score * 100), focus: kind,
    features: weighted.map((feature) => ({ ...feature, similarity: Math.round(feature.similarity * 100) })),
    // Biggest gaps first: what each would add to the score if closed.
    gaps: weighted.filter((feature) => feature.gap).sort((a, b) => (1 - b.similarity) * b.weight - (1 - a.similarity) * a.weight).map((feature) => feature.gap!).slice(0, 5),
  };
}
