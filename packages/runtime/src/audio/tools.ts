/** The listen tool: what the model uses to hear files, alone or against a reference. */
import type { HeardEvent, HeardTake, HearRequest, JsonObject, KernelTool } from "../core/contracts.js";
import type { HeardNote } from "./analyze.js";
import { AudioError, audioPath, compare, hear, type Analysis } from "./index.js";
import { hearForm } from "./structure.js";

export const LISTEN_TOOL = "listen";

const DESCRIPTION = [
  "Hear audio the producer points you to: a reference track, a sample, a bounce or a recording, by its file path (find_samples finds audio files by words in folders the producer names, such as ~/Downloads) or, for an audio clip in the Set, its clipRef.",
  "Hear the Set itself with track (or tracks, to hear several together and what clashes between them) or mix: true. Kumi listens in Live directly, after each track's devices: while Live plays, to what's playing now (seconds, 8 by default); while it's stopped, quietly, to the loop or from the playhead (or from_beat and beats). No recording or bouncing first.",
  "Measures loudness (integrated LUFS, true peak, loudness range), tonal balance in named bands, stereo width per band, dynamics, tempo, key and the energy over time as a small text spectrogram;",
  "for a single sound (a note, a hit, a short sample), also its pitch, harmonics (which waveform it's like), envelope and movement (filter opening or closing, wobble or tremolo rate, at the tempo when known).",
  "With compare_to, sets file against the reference with loudness matched and lists what differs most (bands, brightness, width, compression, loudness).",
  "Use it before matching a mix to a reference (EQ, compression, width, loudness moves) or rebuilding a sound (harmonics to oscillators and filter, envelope to the amp and filter envelopes, movement to an LFO's rate and target).",
  "With form, hears a song's sections instead (in bars, with their energy and which are alike), to arrange like it.",
  "Say what you heard in the producer's terms, not as a data dump.",
].join(" ");

/** What the model reads of an analysis: everything but the fine timeline (for scoring), and the notes as compact rows. */
const trimSound = (analysis: Analysis, tempo?: number) => {
  const { timeline: _timeline, notes, ...rest } = analysis;
  return { ...rest, ...(notes ? { notes: transcription(notes, tempo) } : {}) };
};

/**
 * Transcribed notes as the model writes MIDI: rows of [start, pitch, velocity, length], in beats at the Set's
 * tempo when given, else seconds; a hit with no clear pitch has pitch null. Starts are as played, not snapped
 * to a grid: a reference that isn't on the grid (or whose tempo is a guess) drifts when every note is rounded.
 */
export function transcription(notes: readonly HeardNote[], tempo?: number): JsonObject {
  const unit = tempo ? tempo / 60 : 1;
  const at = (seconds: number) => (tempo ? Math.round(seconds * unit * 100) / 100 : Math.round(seconds * 1000) / 1000);
  const rows = notes.slice(0, 400).map((note) => [at(note.time), note.midi, note.velocity, Math.max(tempo ? 0.1 : 0.02, at(note.duration))]);
  const pitched = notes.filter((note) => note.midi !== null);
  const counts = new Map<number, number>(); for (const note of pitched) counts.set(note.midi!, (counts.get(note.midi!) ?? 0) + 1);
  return { unit: tempo ? `beats at ${tempo} BPM (a 16th is 0.25; starts as played, not on the grid)` : "seconds", columns: ["start", "pitch (MIDI; null: a hit with no clear pitch)", "velocity", "length"], rows,
    ...(notes.length > 400 ? { more: notes.length - 400 } : {}), pitched: pitched.length, unpitched: notes.length - pitched.length,
    mostPlayed: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([midi, count]) => ({ midi, count })),
    note: `Monophonic: the strongest line. Write it with write_midi_clip at these starts as they are${tempo ? `, with the Set at ${tempo} BPM` : ""} (rounding them to the grid moves the rhythm away from the reference's), unpitched hits as a drum or percussive voice; then audition it against the reference.` };
}

/**
 * The listen tool. `resolve` turns what the model names into a file (a path, or something in the
 * Set when the integration can find its file); `onEvent` tells the app what was heard.
 */
export function listeningTools(options: { onEvent: (event: HeardEvent) => void; resolve?: (named: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Hear tracks or the mix in the Set (Kumi's listening devices, or a quiet pass); a file each, or why not. */
  hear?: (request: HearRequest, signal: AbortSignal) => Promise<HeardTake[] | string> }): KernelTool[] {
  const locate = async (named: string, signal: AbortSignal) => (await options.resolve?.(named, signal)) ?? audioPath(named);
  return [{
    name: LISTEN_TOOL, description: DESCRIPTION,
    inputSchema: { type: "object", additionalProperties: false, properties: {
      file: { type: "string", minLength: 1, maxLength: 1024, description: "The audio: a file's absolute path or ~/…, or an audio clip's clipRef from discovery" },
      track: { type: "string", minLength: 1, maxLength: 256, description: "A track in the Set to hear (its reference from this turn, or its name), after its devices" },
      tracks: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 256 }, description: "Several tracks heard together: each one's sound, and where they clash" },
      mix: { type: "boolean", description: "true: hear the whole mix, as Main plays it" },
      from_beat: { type: "number", minimum: 0, description: "For the Set: where in the Arrangement to hear, in beats (left out: what's playing now, or the loop or the playhead)" },
      beats: { type: "number", exclusiveMinimum: 0, maximum: 64, description: "For the Set: how much to hear, in beats" },
      compare_to: { type: "string", minLength: 1, maxLength: 1024, description: "A reference to set file against, the same ways" },
      focus: { type: "string", enum: ["mix", "sound"], description: "mix for a song or stem, sound for one note or hit; left out, chosen by length" },
      from_seconds: { type: "number", minimum: 0, description: "Where to start listening in file" },
      compare_from_seconds: { type: "number", minimum: 0, description: "Where to start listening in the reference; left out, its start" },
      seconds: { type: "number", exclusiveMinimum: 0, maximum: 720, description: "How long to listen" },
      transcribe: { type: "boolean", description: "Transcribe file's notes (its first minute): when each starts, its pitch, velocity and length, to write the sequence as MIDI" },
      form: { type: "boolean", description: "Hear file's form instead: its sections in bars (where each starts, how long), each one's energy, density and low end, which are alike, and its part (intro, build, peak, break, outro), to arrange like it" },
      tempo: { type: "number", minimum: 20, maximum: 999, description: "The Set's tempo, so transcribed notes come in beats and a form's bars are counted in the Set's octave" },
      beats_per_bar: { type: "integer", minimum: 1, maximum: 16, description: "Beats in the Set's bar, for a form (4 when left out)" } } },
    async execute(input, signal) {
      if (input.form === true) {
        const file = typeof input.file === "string" ? input.file : "";
        try {
          const form = await hearForm(await locate(file, signal), { ...(typeof input.tempo === "number" ? { tempo: input.tempo } : {}), ...(typeof input.beats_per_bar === "number" ? { beatsPerBar: input.beats_per_bar } : {}), signal });
          return { text: JSON.stringify({ form, note: "Bars are the reference's own, counted at its tempo. To mirror it, arrange with these sections (their bars, names fitting the genre) and pick which tracks play in each by its energy, density and low end." }) };
        } catch (error) {
          signal.throwIfAborted();
          return { text: error instanceof AudioError ? error.message : `Kumi couldn't hear its form: ${error instanceof Error ? error.message.slice(0, 200) : "it failed"}`, isError: true };
        }
      }
      const focus: "mix" | "sound" | undefined = input.focus === "mix" || input.focus === "sound" ? input.focus : undefined;
      const tempo = typeof input.tempo === "number" ? input.tempo : undefined;
      const named = [...(typeof input.track === "string" ? [input.track] : []), ...(Array.isArray(input.tracks) ? input.tracks.filter((item): item is string => typeof item === "string") : [])];
      // The Set itself: Kumi hears the tracks (or the mix) in Live, then listens to what it heard.
      let file = typeof input.file === "string" ? input.file : "";
      let span: { start?: number; seconds?: number } = {};
      if (named.length || input.mix === true) {
        if (!options.hear) return { text: "Kumi isn't connected to Live, so it can't hear the Set.", isError: true };
        const request: HearRequest = { tracks: [...new Set(named)], ...(input.mix === true ? { mix: true } : {}),
          ...(typeof input.from_beat === "number" ? { fromBeat: input.from_beat } : {}), ...(typeof input.beats === "number" ? { beats: input.beats } : {}),
          ...(typeof input.seconds === "number" ? { seconds: input.seconds } : {}) };
        const takes = await options.hear(request, signal);
        if (typeof takes === "string") return { text: takes, isError: true };
        if (takes.length > 1) return heardTogether(takes, focus, options.onEvent, signal);
        const take = takes[0];
        if (!take) return { text: "Nothing came through to hear.", isError: true };
        file = take.file;
        span = { start: take.start, ...(take.seconds !== undefined ? { seconds: take.seconds } : {}) };
      }
      if (!file) return { text: "Name what to hear: a file, an audio clip's clipRef, a track (or tracks), or mix: true.", isError: true };
      const fromSet = span.start !== undefined;
      const common = { ...(focus ? { focus } : {}), ...(input.transcribe === true ? { transcribe: true } : {}),
        ...(fromSet ? span : { ...(typeof input.from_seconds === "number" ? { start: input.from_seconds } : {}), ...(typeof input.seconds === "number" ? { seconds: input.seconds } : {}) }), signal };
      try {
        const mine = await hear(await locate(file, signal), common);
        if (typeof input.compare_to !== "string") {
          options.onEvent({ type: "heard", file: mine.file, summary: summary(mine), bands: mine.balance.bands.map((band) => band.db) });
          return { text: JSON.stringify(trimSound(mine, tempo)) };
        }
        // The reference's own place: the same seconds into another song are rarely the same part of it.
        const { start: _mine, ...rest } = common;
        const { transcribe: _transcribe, ...restNoNotes } = rest as typeof rest & { transcribe?: boolean };
        const reference = await hear(await locate(input.compare_to, signal), { ...restNoNotes, ...(typeof input.compare_from_seconds === "number" ? { start: input.compare_from_seconds } : {}), ...(mine.analyzed.focus ? { focus: mine.analyzed.focus } : {}) });
        const comparison = compare(mine, reference);
        options.onEvent({ type: "heard", file: mine.file, summary: summary(mine), bands: mine.balance.bands.map((band) => band.db),
          compared: { reference: reference.file, summary: summary(reference), differences: comparison.balance.map((band) => band.difference), headlines: comparison.headlines } });
        return { text: JSON.stringify({ comparison, mine: { loudness: mine.loudness, tempo: mine.tempo, key: mine.key, ...(mine.notes ? { notes: transcription(mine.notes, tempo) } : {}) }, reference: { loudness: reference.loudness, tempo: reference.tempo, key: reference.key } }) };
      } catch (error) {
        signal.throwIfAborted();
        return { text: error instanceof AudioError ? error.message : `Kumi couldn't listen to that: ${error instanceof Error ? error.message.slice(0, 200) : "it failed"}`, isError: true };
      }
    },
  }];
}

/**
 * Several tracks heard together: each one's loudness, balance and character, and where two sit in the same
 * band at similar levels (each loud there for itself, within 6 dB of the other), the usual cause of mud.
 */
async function heardTogether(takes: readonly HeardTake[], focus: "mix" | "sound" | undefined, onEvent: (event: HeardEvent) => void, signal: AbortSignal) {
  const heard = await Promise.all(takes.map(async (take) => ({ take, analysis: await hear(take.file, { start: take.start, ...(take.seconds !== undefined ? { seconds: take.seconds } : {}), ...(focus ? { focus } : { focus: "mix" as const }), signal }) })));
  for (const { analysis } of heard) onEvent({ type: "heard", file: analysis.file, summary: summary(analysis), bands: analysis.balance.bands.map((band) => band.db) });
  const level = (analysis: Analysis, index: number) => analysis.loudness.integratedLufs === null ? -Infinity : analysis.loudness.integratedLufs + analysis.balance.bands[index]!.db;
  const strong = (analysis: Analysis, index: number) => { const top = Math.max(...analysis.balance.bands.map((band) => band.db)); return analysis.balance.bands[index]!.db >= top - 6; };
  const clashes: { tracks: [string, string]; band: string; hz: string; db: [number, number] }[] = [];
  for (let a = 0; a < heard.length; a++) for (let b = a + 1; b < heard.length; b++) {
    const first = heard[a]!; const second = heard[b]!;
    first.analysis.balance.bands.forEach((band, index) => {
      const x = level(first.analysis, index); const y = level(second.analysis, index);
      if (Number.isFinite(x) && Number.isFinite(y) && strong(first.analysis, index) && strong(second.analysis, index) && Math.abs(x - y) <= 6) {
        clashes.push({ tracks: [first.take.label, second.take.label], band: band.name, hz: band.hz, db: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] });
      }
    });
  }
  clashes.sort((a, b) => Math.max(...b.db) - Math.max(...a.db));
  return { text: JSON.stringify({
    tracks: heard.map(({ take, analysis }) => ({ track: take.label, heard: take.live ? "as it played" : "quietly", summary: summary(analysis), loudness: analysis.loudness,
      balance: analysis.balance.bands.map((band) => `${band.name} ${band.db} dB`), width: analysis.balance.bands.map((band) => band.width), dynamics: analysis.dynamics })),
    clashes: clashes.slice(0, 8).map((clash) => `${clash.tracks[0]} and ${clash.tracks[1]} both sit in the ${clash.band} (${clash.hz} Hz), at ${clash.db[0]} and ${clash.db[1]} dB`),
    note: "A clash is two sounds strong in the same band at similar levels: carve one (EQ Eight), sidechain it (a compressor keyed from the other), or move one up or down an octave." }) };
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
