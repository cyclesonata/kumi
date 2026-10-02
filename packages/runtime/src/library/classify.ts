/**
 * What a sound is, the way a producer would file it: its instrument class (kick, snare, pad…),
 * one-shot or loop, a loop's tempo and a sound's key or note. Names say most of it ("Kick 808
 * Long", "Bass Loop 128 Fmin", a "Hats" folder); the sound itself says the rest, and checks the
 * name where a name is ambiguous ("Stab C" is a C only if it sounds like one).
 */

export const CLASSES = ["kick", "snare", "clap", "hat", "cymbal", "tom", "perc", "drums", "bass", "lead", "pad", "keys", "pluck", "stab", "synth",
  "guitar", "strings", "brass", "vocal", "fx", "noise", "texture"] as const;
export type SoundClass = typeof CLASSES[number];
export type SoundKind = "one-shot" | "loop";

/** Words in names, and the class each says; earlier classes win when a name says several. */
const WORDS: Record<SoundClass, readonly string[]> = {
  kick: ["kick", "kicks", "kik", "kck", "bd", "bassdrum", "kickdrum"],
  snare: ["snare", "snares", "snr", "sd", "rimshot", "snareroll"],
  clap: ["clap", "claps", "clp", "handclap", "handclaps", "snap", "snaps", "fingersnap"],
  hat: ["hat", "hats", "hh", "hihat", "hihats", "ohh", "chh", "ch", "oh", "openhat", "closedhat"],
  cymbal: ["cymbal", "cymbals", "crash", "crashes", "ride", "rides", "splash", "china", "cym"],
  tom: ["tom", "toms", "floortom"],
  perc: ["perc", "percs", "percussion", "conga", "congas", "bongo", "bongos", "tabla", "cowbell", "clave", "claves", "shaker", "shakers", "tamb", "tambourine",
    "woodblock", "wood", "rim", "block", "triangle", "guiro", "cabasa", "djembe", "timbale", "timbales", "agogo", "click", "eperc"],
  drums: ["drums", "drum", "break", "breaks", "breakbeat", "beat", "beats", "kit", "tops", "top", "groove", "fill", "fills"],
  bass: ["bass", "basses", "bassline", "sub", "subs", "808", "808s", "reese", "lowend"],
  lead: ["lead", "leads", "ld", "solo"],
  pad: ["pad", "pads"],
  keys: ["keys", "key", "piano", "pianos", "rhodes", "wurli", "wurlitzer", "ep", "organ", "organs", "clav", "clavinet", "harpsichord", "celesta", "marimba",
    "vibes", "vibraphone", "xylophone", "kalimba", "mallet", "mallets", "bell", "bells", "chord", "chords"],
  pluck: ["pluck", "plucks", "plk"],
  stab: ["stab", "stabs"],
  synth: ["synth", "synths", "arp", "arps", "seq", "sequence", "bleep", "bleeps", "blip"],
  guitar: ["guitar", "guitars", "gtr", "strum", "strums", "riff"],
  strings: ["strings", "string", "violin", "violins", "viola", "cello", "cellos", "orchestra", "orchestral", "pizz", "pizzicato"],
  brass: ["brass", "horn", "horns", "trumpet", "trumpets", "sax", "saxophone", "trombone", "flute", "woodwind"],
  vocal: ["vocal", "vocals", "vox", "voc", "voice", "voices", "acapella", "acappella", "adlib", "adlibs", "chant", "chants", "choir", "spoken", "phrase",
    "shout", "shouts", "scream", "speech", "hum", "bv", "bvs"],
  fx: ["fx", "sfx", "riser", "risers", "rise", "uplifter", "downlifter", "sweep", "sweeps", "impact", "impacts", "whoosh", "swoosh", "swell", "transition",
    "reverse", "reversed", "glitch", "laser", "zap", "boom", "siren", "tapestop", "buildup", "drop", "foley", "effect", "effects"],
  noise: ["noise", "noises", "hiss", "crackle", "static", "vinylnoise"],
  texture: ["texture", "textures", "atmos", "atmosphere", "atmospheres", "ambience", "ambient", "drone", "drones", "soundscape", "field", "fieldrecording", "room", "rain"],
};
const PRIORITY: readonly SoundClass[] = ["kick", "snare", "clap", "hat", "cymbal", "tom", "vocal", "bass", "perc", "drums", "lead", "pluck", "stab", "pad", "keys",
  "guitar", "strings", "brass", "fx", "noise", "texture", "synth"];
const CLASS_OF = new Map<string, SoundClass>();
for (const name of PRIORITY) for (const word of WORDS[name]) if (!CLASS_OF.has(word)) CLASS_OF.set(word, name);
/** Words that are a class only beside a drum word or in a drum folder ("open" and "ch" alone mean little). */
const WEAK = new Set(["oh", "ch", "wood", "block", "rim", "click", "top", "tops", "fill", "fills", "key", "drop", "room", "field", "hum", "rise", "boom", "beat", "beats", "kit", "riff"]);
const DRUM_ELEMENTS = new Set<SoundClass>(["kick", "snare", "clap", "hat", "cymbal", "tom", "perc"]);
/** Classes with no key to speak of. */
const UNTUNED = new Set<SoundClass>([...DRUM_ELEMENTS, "drums", "fx", "noise", "texture"]);

const LOOP_WORDS = new Set(["loop", "loops", "lp", "bpm", "groove", "grooves", "break", "breaks", "breakbeat", "beat", "beats", "phrase", "riff", "riffs", "arp", "arps", "fill", "fills", "tops"]);
const SHOT_WORDS = new Set(["oneshot", "oneshots", "shot", "shots", "hit", "hits", "single", "singles", "stab", "stabs", "multisample", "multisamples"]);

/** Words of a name or folder: "KickPunchy_01" is kick, punchy, 01; "F#m" and "808" stay whole. */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z]{2,})(\d)/g, "$1 $2").replace(/(\d)([A-Za-z]{3,})/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean);
}

/** Pairs of words that name one thing: "hi hat", "bass drum", "one shot". */
const PAIRS: Record<string, string> = { "hi hat": "hihat", "hi hats": "hihats", "bass drum": "bassdrum", "kick drum": "kickdrum", "one shot": "oneshot", "one shots": "oneshots",
  "open hat": "openhat", "closed hat": "closedhat", "white noise": "noise", "pink noise": "noise", "field recording": "fieldrecording", "tape stop": "tapestop",
  "snare roll": "snareroll", "hand clap": "handclap", "finger snap": "fingersnap", "floor tom": "floortom", "e perc": "eperc", "vinyl noise": "vinylnoise", "low end": "lowend" };
function joined(words: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const pair = index + 1 < words.length ? PAIRS[`${words[index]} ${words[index + 1]}`] : undefined;
    if (pair) { out.push(pair); index++; } else out.push(words[index]!);
  }
  return out;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E", "E#": "F", "B#": "C" };
/** "F#", "Bb" → a pitch class name with sharps ("A#"), or undefined. */
export function pitchClass(letter: string, accidental = ""): string | undefined {
  const sign = accidental.toLowerCase() === "sharp" || accidental === "♯" || accidental === "s" ? "#" : accidental.toLowerCase() === "flat" || accidental === "♭" ? "b" : accidental;
  const name = `${letter.toUpperCase()}${sign}`;
  const sharp = FLATS[name] ?? name;
  return NOTE_NAMES.includes(sharp) ? sharp : undefined;
}
/** "A minor", "F# major": what keys are called here. */
export function keyName(root: string, minor: boolean): string { return `${root} ${minor ? "minor" : "major"}`; }

/** A key said in words, the way producers write them: "A minor", "F#m", "Bbmaj", "C# min", "Dmin7". */
export function parseKey(text: string): string | undefined {
  const edge = "(?<![A-Za-z0-9#])"; const end = "(?![A-Za-z0-9#])";
  const spelled = new RegExp(`${edge}([A-Ga-g])\\s?(#|b|♯|♭|sharp|flat)?[\\s_-]?(major|minor|maj|min|m)(?:7|6|9|11|13)?${end}`).exec(text);
  if (spelled) {
    const root = pitchClass(spelled[1]!, spelled[2] ?? "");
    const quality = spelled[3]!;
    // A capital letter then "m" is minor; a small letter needs the word spelled out ("am" isn't a key).
    if (root && (spelled[1] === spelled[1]!.toUpperCase() || quality.length > 1)) return keyName(root, quality === "m" || /^min/i.test(quality));
  }
  return undefined;
}

/** A note with its octave, as sample packs name pitched sounds: "C3", "F#2", "Bb0". */
export function parseNote(text: string): { name: string; midi: number } | undefined {
  const found = /(?<![A-Za-z0-9#])([A-G])(#|b)?(-?\d)(?![A-Za-z0-9#])/.exec(text);
  if (!found) return undefined;
  const root = pitchClass(found[1]!, found[2] ?? "");
  if (!root) return undefined;
  const octave = Number(found[3]);
  return { name: `${root}${octave}`, midi: (octave + 1) * 12 + NOTE_NAMES.indexOf(root) };
}

/** A tempo a name gives ("128 BPM", "bpm90", "_128_" in a loop's name). Bare numbers need the sound's length to agree. */
export function parseTempo(text: string): { bpm: number; explicit: boolean }[] {
  const found: { bpm: number; explicit: boolean }[] = [];
  for (const match of text.matchAll(/(\d{2,3}(?:\.\d+)?)\s?bpm|bpm\s?(\d{2,3}(?:\.\d+)?)/gi)) found.push({ bpm: Number(match[1] ?? match[2]), explicit: true });
  for (const match of text.matchAll(/(?<![\d.])(\d{2,3})(?![\d.])/g)) {
    const bpm = Number(match[1]);
    if (bpm >= 60 && bpm <= 200 && !found.some((item) => item.bpm === bpm)) found.push({ bpm, explicit: false });
  }
  return found.filter((item) => item.bpm >= 40 && item.bpm <= 300);
}

export interface NameHints {
  class?: SoundClass;
  /** Where the class came from: the file's own name, or a folder it's in. */
  classFrom?: "name" | "folder";
  kind?: SoundKind;
  tempos: { bpm: number; explicit: boolean }[];
  key?: string;
  note?: { name: string; midi: number };
  /** A lone note letter ("Stab C"): believed only if the sound agrees. */
  letter?: string;
  /** The words of its name and folders. */
  words: string[];
}

/** What a sound's path says about it, from its name first and then its folders, nearest first. */
export function nameHints(relativePath: string): NameHints {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const file = (parts.pop() ?? "").replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const nameWords = joined(tokens(file));
  const folderWords = parts.reverse().map((part) => joined(tokens(part)));
  const all = [nameWords, ...folderWords].flat();
  const drumContext = all.some((word) => { const found = CLASS_OF.get(word); return found !== undefined && !WEAK.has(word) && (DRUM_ELEMENTS.has(found) || found === "drums"); });
  const classesIn = (words: string[]) => words.map((word) => (WEAK.has(word) && !drumContext ? undefined : CLASS_OF.get(word))).filter((found): found is SoundClass => found !== undefined);
  let kind: SoundKind | undefined;
  for (const words of [nameWords, ...folderWords]) {
    if (words.some((word) => SHOT_WORDS.has(word))) { kind = "one-shot"; break; }
    if (words.some((word) => LOOP_WORDS.has(word))) { kind = "loop"; break; }
  }
  let found: SoundClass | undefined; let from: NameHints["classFrom"];
  const named = classesIn(nameWords);
  if (named.length) {
    const elements = new Set(named.filter((name) => DRUM_ELEMENTS.has(name)));
    found = kind === "loop" && elements.size >= 2 ? "drums" : PRIORITY.find((name) => named.includes(name));
    from = "name";
  } else {
    for (const words of folderWords) {
      const inFolder = classesIn(words);
      if (inFolder.length) { found = PRIORITY.find((name) => inFolder.includes(name)); from = "folder"; break; }
    }
  }
  // A key ("Fmin"), else a note with its octave ("C3"), else a lone letter the sound has to agree with.
  const key = parseKey(file);
  const note = key ? undefined : parseNote(file);
  const letter = !key && !note ? /(?<![A-Za-z0-9#])([A-G])(#|b)?(?![A-Za-z0-9#'’])/.exec(file.replace(/[_-]/g, " ")) : undefined;
  const lone = letter ? pitchClass(letter[1]!, letter[2] ?? "") : undefined;
  return { ...(found ? { class: found, classFrom: from! } : {}), ...(kind ? { kind } : {}), tempos: parseTempo(file), ...(key ? { key } : {}), ...(note ? { note } : {}),
    ...(lone ? { letter: lone } : {}), words: all };
}

/** What listening measured, as classify() needs it. */
export interface Heard {
  seconds: number;
  centroidHz: number;
  flatness: number;
  attackMs: number;
  decayMs: number;
  onsetsPerSecond: number;
  lowShare: number;
  highShare: number;
  pitch?: { hz: number; confidence: number };
  /** Tempo from the onsets' rhythm, when there is one. */
  rhythmBpm?: number;
  rhythmConfidence?: number;
  key?: { name: string; confidence: number };
}

export interface Classified {
  class?: SoundClass;
  classFrom?: "name" | "folder" | "sound";
  kind: SoundKind;
  bpm?: number;
  key?: string;
  note?: string;
}

/** How well a length fits whole beats at a tempo: beats in it, and how far off (as a share of a beat). */
const beatsAt = (seconds: number, bpm: number) => { const beats = seconds * bpm / 60; return { beats: Math.round(beats), off: Math.abs(beats - Math.round(beats)) }; };
const fitsBars = (seconds: number, bpm: number) => { const { beats, off } = beatsAt(seconds, bpm); return beats >= 2 && off < 0.06 && (beats % 2 === 0 || beats === 3 || beats % 3 === 0); };

/** The name's hints and what the sound measured, made one answer. */
export function classify(hints: NameHints, heard: Heard): Classified {
  // Tempo: the name's when the length agrees (or it says BPM outright), else one the length and rhythm agree on.
  const named = hints.tempos.find((item) => item.explicit) ?? hints.tempos.find((item) => fitsBars(heard.seconds, item.bpm));
  let bpm = named?.bpm;
  if (!bpm && heard.seconds >= 1.5) bpm = tempoFromLength(heard.seconds, heard.rhythmBpm, heard.rhythmConfidence);
  // A loop by name with a tail past its bars: its rhythm's tempo, when that's clear.
  if (!bpm && hints.kind === "loop" && heard.rhythmBpm && (heard.rhythmConfidence ?? 0) >= 0.4) bpm = heard.rhythmBpm;
  const rhythmic = heard.onsetsPerSecond >= 1.2;
  // Under a second is a hit, whatever its folder says (a "Break" kit's hat is one hit).
  const kind: SoundKind = heard.seconds < 1 ? "one-shot" : hints.kind ?? (heard.seconds < 1.2 ? "one-shot" : bpm !== undefined && rhythmic && fitsBars(heard.seconds, bpm) ? "loop" : "one-shot");
  if (kind === "one-shot" && !named?.explicit) bpm = undefined;
  const pitched = heard.pitch && heard.pitch.confidence >= 0.5 ? heard.pitch : undefined;
  const midi = pitched ? Math.round(69 + 12 * Math.log2(pitched.hz / 440)) : undefined;
  const heardNote = midi !== undefined ? `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}` : undefined;
  let found = hints.class; let from: Classified["classFrom"] = hints.classFrom;
  // "808" alone is a bass in most packs; a short thump of one is the kick.
  if (found === "bass" && hints.words.includes("808") && !hints.words.some((word) => WORDS.bass.includes(word) && word !== "808" && word !== "808s") && kind === "one-shot" && heard.decayMs < 250 && heard.seconds < 0.8) found = "kick";
  if (!found) { found = classFromSound(kind, heard, pitched); from = found ? "sound" : undefined; }
  const note = hints.note?.name ?? (kind === "one-shot" ? heardNote : undefined);
  // A key is heard only in a tonal loop, and only when the sound is clear about it; a lone letter in the name must agree.
  let key = hints.key;
  const tonal = !found || !UNTUNED.has(found);
  if (!key && kind === "loop" && tonal && heard.key && heard.flatness < 0.15) {
    if (heard.key.confidence >= 0.5) key = heard.key.name;
    else if (hints.letter && heard.key.name.startsWith(`${hints.letter} `)) key = heard.key.name;
  }
  return { ...(found ? { class: found, classFrom: from! } : {}), kind, ...(bpm ? { bpm: Math.round(bpm * 10) / 10 } : {}), ...(key ? { key } : {}), ...(note ? { note } : {}) };
}

/**
 * A loop's tempo from its length: whole bars (1, 2, 4, 8 or 16 of 4/4, or 3/4) at a tempo between
 * 70 and 180, the one nearest what the rhythm says, or the most usual when the rhythm says nothing.
 */
export function tempoFromLength(seconds: number, rhythm?: number, confidence = 0): number | undefined {
  const candidates: { bpm: number; beats: number }[] = [];
  for (const beats of [4, 8, 16, 32, 64, 3, 6, 12, 24, 48]) {
    const bpm = 60 * beats / seconds;
    if (bpm >= 70 && bpm <= 180) candidates.push({ bpm, beats });
  }
  if (!candidates.length) return undefined;
  if (rhythm && confidence >= 0.2) {
    // The rhythm's tempo, or its half or double, picks among the lengths that fit.
    const near = (bpm: number) => Math.min(...[rhythm, rhythm * 2, rhythm / 2].map((value) => Math.abs(Math.log2(bpm / value))));
    const best = candidates.reduce((a, b) => (near(a.bpm) <= near(b.bpm) ? a : b));
    if (near(best.bpm) < 0.04) return best.bpm;
    return undefined;
  }
  // No clear rhythm: a 4/4 length near 120 is the likeliest reading, and only a whole-number tempo is believed.
  const whole = candidates.filter((item) => item.beats % 4 === 0 && Math.abs(item.bpm - Math.round(item.bpm)) < 0.05);
  return whole.length ? whole.reduce((a, b) => (Math.abs(a.bpm - 120) <= Math.abs(b.bpm - 120) ? a : b)).bpm : undefined;
}

/** The class a nameless sound most likely is, from how it sounds. */
function classFromSound(kind: SoundKind, heard: Heard, pitched: Heard["pitch"]): SoundClass | undefined {
  const noisy = heard.flatness >= 0.25;
  if (kind === "loop") {
    if (heard.onsetsPerSecond >= 2 && !pitched) return heard.highShare > 0.5 && heard.lowShare < 0.1 ? "hat" : "drums";
    if (pitched && pitched.hz < 160) return "bass";
    return pitched ? "synth" : noisy ? "texture" : undefined;
  }
  const short = heard.seconds < 0.8 || heard.decayMs < 400;
  if (pitched && pitched.hz < 130 && heard.lowShare > 0.5) return heard.decayMs < 400 && heard.seconds < 1.5 ? "kick" : "bass";
  if (heard.lowShare > 0.6 && heard.attackMs < 15 && short) return "kick";
  if (noisy && heard.centroidHz > 5000 && heard.lowShare < 0.1) return heard.seconds < 0.6 ? "hat" : "cymbal";
  if (heard.attackMs < 15 && short && heard.centroidHz >= 900 && heard.centroidHz < 6000 && noisy) return "snare";
  if (heard.attackMs < 15 && short) return "perc";
  if (pitched) return heard.attackMs > 80 ? "pad" : heard.decayMs < 600 ? "pluck" : "synth";
  if (noisy) return heard.seconds > 2 ? "texture" : "noise";
  return undefined;
}
