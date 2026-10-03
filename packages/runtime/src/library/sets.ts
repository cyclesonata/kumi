/**
 * The producer's own Live Sets, read from their files (gzipped XML) without opening Live: tempo,
 * time signature and key, each track's name, kind, colour and device chain (Live's devices by the
 * names Live shows, plug-ins by their own), its clips and the samples it plays, the returns and the
 * main chain, and how long the Arrangement runs.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { attribute, scanXmlFile } from "./xml.js";

export type TrackKind = "audio" | "midi" | "group" | "return" | "main";
export type DeviceRole = "instrument" | "audio" | "midi" | "rack";

export interface SetDevice {
  /** As Live shows it ("EQ Eight", "Wavetable") or the plug-in's own name ("Serum"). */
  name: string;
  role: DeviceRole;
  /** A plug-in's format and maker ("VST3", "AU · FabFilter"); a Max for Live device says "Max for Live". */
  plugin?: string;
  /** The name the producer gave it, or its preset's (a rack called "Vox Chain"). */
  preset?: string;
  /** What a rack holds, by name, once each. */
  inside?: string[];
}

export interface SetTrack {
  name: string;
  kind: TrackKind;
  /** Live's colour, as its index (0–69) in Live's palette. */
  color?: number;
  /** The group it's in, by name. */
  group?: string;
  devices: SetDevice[];
  clips: { session: number; arrangement: number };
  /** Audio files it plays (clips, Simpler and Sampler), up to a few dozen. */
  samples: string[];
  /** Plug-ins anywhere in its chain, racks included, by name. */
  plugins?: string[];
  frozen?: boolean;
}

export interface SetSummary {
  name: string;
  tempo?: number;
  /** "4/4". */
  signature?: string;
  /** "A minor", from the Set's scale when it's set. */
  key?: string;
  tracks: SetTrack[];
  returns: SetTrack[];
  main?: SetTrack;
  scenes: number;
  /** Where the Arrangement's last clip ends, in beats. */
  arrangementBeats?: number;
  /** "Ableton Live 12.1.5". */
  live?: string;
}

/** Live's devices by their file tag, as Live names them. */
const DEVICE_NAMES: Record<string, string> = {
  OriginalSimpler: "Simpler", MultiSampler: "Sampler", Operator: "Operator", UltraAnalog: "Analog", InstrumentVector: "Wavetable", Drift: "Drift",
  InstrumentMeld: "Meld", Collision: "Collision", LoungeLizard: "Electric", StringStudio: "Tension", InstrumentImpulse: "Impulse", DrumCell: "Drum Sampler",
  ProxyInstrumentDevice: "External Instrument", DrumGroupDevice: "Drum Rack", InstrumentGroupDevice: "Instrument Rack",
  AudioEffectGroupDevice: "Audio Effect Rack", MidiEffectGroupDevice: "MIDI Effect Rack",
  Eq8: "EQ Eight", FilterEQ3: "EQ Three", ChannelEq: "Channel EQ", Compressor2: "Compressor", GlueCompressor: "Glue Compressor", MultibandDynamics: "Multiband Dynamics",
  Limiter: "Limiter", Gate: "Gate", AutoFilter: "Auto Filter", AutoFilter2: "Auto Filter", AutoPan: "Auto Pan", AutoPan2: "Auto Pan-Tremolo", Chorus2: "Chorus-Ensemble",
  PhaserNew: "Phaser-Flanger", Delay: "Delay", PingPongDelay: "Ping Pong Delay", FilterDelay: "Filter Delay", CrossDelay: "Simple Delay", GrainDelay: "Grain Delay",
  Echo: "Echo", Reverb: "Reverb", Hybrid: "Hybrid Reverb", Saturator: "Saturator", Overdrive: "Overdrive", Pedal: "Pedal", Tube: "Dynamic Tube", Roar: "Roar",
  Erosion: "Erosion", Redux2: "Redux", Vinyl: "Vinyl Distortion", DrumBuss: "Drum Buss", StereoGain: "Utility", Spectral: "Spectral Time", Transmute: "Spectral Resonator",
  Resonator: "Resonators", FrequencyShifter: "Frequency Shifter", BeatRepeat: "Beat Repeat", SpectrumAnalyzer: "Spectrum", ProxyAudioEffectDevice: "External Audio Effect",
  MidiArpeggiator: "Arpeggiator", MidiChord: "Chord", MidiNoteLength: "Note Length", MidiPitcher: "Pitch", MidiRandom: "Random", MidiScale: "Scale", MidiVelocity: "Velocity",
};
const INSTRUMENTS = new Set(["OriginalSimpler", "MultiSampler", "Operator", "UltraAnalog", "InstrumentVector", "Drift", "InstrumentMeld", "Collision", "LoungeLizard", "StringStudio",
  "InstrumentImpulse", "DrumCell", "ProxyInstrumentDevice", "MxDeviceInstrument"]);
const RACKS = new Set(["DrumGroupDevice", "InstrumentGroupDevice", "AudioEffectGroupDevice", "MidiEffectGroupDevice"]);
const PLUGINS = new Set(["PluginDevice", "AuPluginDevice"]);

/** A device's name from its tag: Live's own name, or the tag's words ("FrequencyShifter" → "Frequency Shifter"). */
export function deviceName(tag: string): string {
  return DEVICE_NAMES[tag] ?? tag.replace(/^Mx(Device)?/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(\D)(\d+)$/, "$1");
}

/** Live 12's scales, by their index in its Scale chooser. */
const SCALES = ["Major", "Minor", "Dorian", "Mixolydian", "Lydian", "Phrygian", "Locrian", "Whole Tone", "Half-whole Dim.", "Whole-half Dim.", "Minor Blues",
  "Minor Pentatonic", "Major Pentatonic", "Harmonic Minor", "Harmonic Major", "Dorian #4", "Phrygian Dominant", "Melodic Minor", "Lydian Augmented", "Lydian Dominant",
  "Super Locrian", "8-Tone Spanish", "Bhairav", "Hungarian Minor", "Hirajoshi", "In-Sen", "Iwato", "Kumoi", "Pelog Selisir", "Pelog Tembung", "Messiaen 3", "Messiaen 4",
  "Messiaen 5", "Messiaen 6", "Messiaen 7"];
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Live's packed time signature (201 is 4/4): the numerator less one, plus 99 for each power of two in the denominator. */
export function timeSignature(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0) return undefined;
  const numerator = (value % 99) + 1; const denominator = 2 ** Math.floor(value / 99);
  return denominator <= 64 ? `${numerator}/${denominator}` : undefined;
}

const MAX_SAMPLES = 32;
const TRACK_TAGS: Record<string, TrackKind> = { AudioTrack: "audio", MidiTrack: "midi", GroupTrack: "group", ReturnTrack: "return", MainTrack: "main", MasterTrack: "main" };

interface OpenDevice { tag: string; depth: number; device: SetDevice; top: boolean; names: Set<string> }
interface OpenTrack { depth: number; track: SetTrack; id?: string; groupId?: string; name?: string }

/** Read a Set's file. Throws for what isn't a Live Set. */
export async function readSet(path: string, options: { signal?: AbortSignal } = {}): Promise<SetSummary> {
  const stack: string[] = [];
  const set: SetSummary = { name: path.split(/[\\/]/).at(-1)!.replace(/\.als$/i, ""), tracks: [], returns: [], scenes: 0 };
  let sawSet = false;
  let current: OpenTrack | undefined;
  const devices: OpenDevice[] = [];
  const groups = new Map<string, string>();
  const members: OpenTrack[] = [];
  let clip: { arrangement: boolean; depth: number } | undefined;
  /** The sample reference being read: its absolute path, or one relative to the Set's folder. */
  let sample: { path?: string; relative?: string } | undefined;
  let scale: { root?: number; name?: string; on?: boolean } = {};
  const folder = dirname(path);
  const parentIs = (name: string, depth = stack.length - 1) => stack[depth] === name;
  await scanXmlFile(path, {
    open(name, attrs) {
      const depth = stack.length;
      if (depth === 0 && name === "Ableton") { const creator = attribute(attrs, "Creator"); if (creator) set.live = creator; }
      if (depth === 1 && name === "LiveSet") sawSet = true;
      const value = () => attribute(attrs, "Value");
      // The Set's own settings, outside any track.
      if (!current && stack[1] === "LiveSet") {
        if (depth === 3 && parentIs("Scenes")) set.scenes++;
        if (depth === 3 && parentIs("ScaleInformation")) {
          if (name === "Root" || name === "RootNote") scale.root = Number(value());
          if (name === "Name") scale.name = value() ?? "";
        }
        if (depth === 2 && name === "InKey") scale.on = value() === "true";
      }
      if (!current && TRACK_TAGS[name] && stack[1] === "LiveSet" && (parentIs("Tracks") || depth === 2)) {
        const kind = TRACK_TAGS[name]!;
        current = { depth, track: { name: "", kind, devices: [], clips: { session: 0, arrangement: 0 }, samples: [] }, ...(attribute(attrs, "Id") ? { id: attribute(attrs, "Id")! } : {}) };
      } else if (current) {
        const at = depth - current.depth;
        if (at === 2 && name === "EffectiveName" && parentIs("Name")) current.name = value() ?? "";
        if (at === 1 && (name === "Color" || name === "ColorIndex")) { const color = Number(value()); if (Number.isInteger(color) && color >= 0) current.track.color = color; }
        if (at === 1 && name === "TrackGroupId") { const id = value(); if (id && id !== "-1") current.groupId = id; }
        if (at === 1 && name === "Freeze" && value() === "true") current.track.frozen = true;
        // The main track's tempo and time signature.
        if (current.track.kind === "main" && stack[current.depth + 2] === "Mixer" && name === "Manual" && at === 4) {
          if (parentIs("Tempo")) { const tempo = Number(value()); if (tempo > 0) set.tempo = Math.round(tempo * 100) / 100; }
          if (parentIs("TimeSignature")) { const signature = timeSignature(Number(value())); if (signature) set.signature = signature; }
        }
        // A device: anything directly in a chain's device list.
        if (parentIs("Devices")) {
          const top = at === 4 && stack[current.depth + 1] === "DeviceChain" && stack[current.depth + 2] === "DeviceChain";
          const role: DeviceRole = RACKS.has(name) ? "rack" : name.startsWith("Midi") || name === "MxDeviceMidiEffect" ? "midi" : INSTRUMENTS.has(name) ? "instrument" : "audio";
          const device: SetDevice = { name: deviceName(name), role, ...(name.startsWith("MxDevice") ? { plugin: "Max for Live" } : {}) };
          devices.push({ tag: name, depth, device, top, names: new Set() });
        }
        const inner = devices.at(-1);
        if (inner) {
          const within = depth - inner.depth;
          if (within === 1 && name === "UserName") { const named = value(); if (named && named !== inner.device.name) inner.device.preset = named; }
          // A plug-in's own name, from its description.
          if (PLUGINS.has(inner.tag) && stack[inner.depth + 1] === "PluginDesc") {
            const info = stack[inner.depth + 2];
            if (within === 3 && ((name === "PlugName" && info === "VstPluginInfo") || (name === "Name" && (info === "Vst3PluginInfo" || info === "AuPluginInfo")))) {
              const plugin = value(); if (plugin) { inner.device.name = plugin; inner.device.plugin = info === "VstPluginInfo" ? "VST" : info === "Vst3PluginInfo" ? "VST3" : "AU"; }
            }
            if (within === 3 && name === "Manufacturer" && info === "AuPluginInfo") { const maker = value(); if (maker) inner.device.plugin = `AU · ${maker}`; }
            // An Audio Unit says whether it's an instrument ('aumu') or an effect.
            if (within === 3 && name === "ComponentType" && info === "AuPluginInfo" && value() === "1635085685") inner.device.role = "instrument";
          }
          // A Max for Live device is named by its file.
          if (inner.tag.startsWith("MxDevice") && (name === "Path" || name === "RelativePath") && inner.device.name === deviceName(inner.tag)) {
            const file = value() ?? "";
            if (/\.amxd$/i.test(file)) inner.device.name = file.split(/[\\/]/).at(-1)!.replace(/\.amxd$/i, "");
          }
        }
        // Clips: in Session slots, or on the Arrangement's timeline (not a take lane's, not a frozen copy).
        if ((name === "AudioClip" || name === "MidiClip") && !clip && !stack.includes("FreezeSequencer")) {
          const arrangement = stack.includes("ArrangerAutomation") && stack.includes("MainSequencer");
          const session = stack.includes("ClipSlotList");
          if (arrangement || session) { clip = { arrangement, depth }; current.track.clips[arrangement ? "arrangement" : "session"]++; }
        }
        if (clip?.arrangement && depth === clip.depth + 1 && name === "CurrentEnd") {
          const end = Number(value());
          if (Number.isFinite(end) && end > (set.arrangementBeats ?? 0)) set.arrangementBeats = Math.round(end * 100) / 100;
        }
        // The samples it plays: each sample reference's file, by its absolute path or relative to the Set.
        if (name === "SampleRef") sample = {};
        if (sample && stack.at(-1) === "FileRef" && stack.at(-2) === "SampleRef") {
          const file = value();
          if (name === "Path" && file && isAbsolute(file)) sample.path = file;
          if (name === "RelativePath" && file && !isAbsolute(file)) sample.relative = join(folder, file);
        }
      }
      // A tag that closes itself is closed at once (close() follows), so it goes on the stack too.
      stack.push(name);
    },
    close(name) {
      const depth = stack.length - 1;
      if (depth < 0) return;
      stack.pop();
      if (clip && depth === clip.depth) clip = undefined;
      const inner = devices.at(-1);
      if (inner && depth === inner.depth) {
        devices.pop();
        // Named once read whole (a plug-in's or Max device's own name comes inside it), for the racks around it.
        for (const open of devices) open.names.add(inner.device.name);
        if (current && inner.device.plugin && inner.device.plugin !== "Max for Live" && !(current.track.plugins ??= []).includes(inner.device.name)) current.track.plugins.push(inner.device.name);
        if (inner.names.size) inner.device.inside = [...inner.names].slice(0, 16);
        if (inner.top && current) current.track.devices.push(inner.device);
      }
      if (current && sample && name === "SampleRef") {
        // A path relative to somewhere other than the Set (a pack's, the Core Library's) isn't kept.
        const file = sample.path ?? (sample.relative && existsSync(sample.relative) ? sample.relative : undefined);
        if (file && current.track.samples.length < MAX_SAMPLES && !current.track.samples.includes(file)) current.track.samples.push(file);
        sample = undefined;
      }
      if (current && depth === current.depth) {
        const track = current.track;
        track.name = current.name ?? "";
        if (track.kind === "group" && current.id) groups.set(current.id, track.name);
        if (current.groupId) members.push(current);
        if (track.kind === "return") set.returns.push(track);
        else if (track.kind === "main") set.main = track;
        else set.tracks.push(track);
        current = undefined;
      }
    },
  }, options);
  if (!sawSet) throw new Error("That isn't a Live Set.");
  for (const member of members) { const group = groups.get(member.groupId!); if (group) member.track.group = group; }
  // C major is what every new Set starts in, so it says nothing about the song; any other scale was chosen.
  const chosen = !(scale.root === 0 && (scale.name === "0" || scale.name === "Major"));
  if (chosen && scale.on !== false && scale.root !== undefined && Number.isInteger(scale.root) && scale.root >= 0 && scale.root < 12 && scale.name !== undefined) {
    const named = /^\d+$/.test(scale.name) ? SCALES[Number(scale.name)] : scale.name;
    if (named) set.key = `${NOTES[scale.root]} ${named === "Major" || named === "Minor" ? named.toLowerCase() : named}`;
  }
  return set;
}
