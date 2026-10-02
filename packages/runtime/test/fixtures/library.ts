/** Made-up libraries for the library's tests: sounds synthesised as WAV, Live's presets and Sets as gzipped XML. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeAmxd } from "../../src/devices/amxd.js";

export const RATE = 44_100;

/** 16-bit WAV of one or two channels. */
export function wav(channels: Float32Array | readonly Float32Array[], rate = RATE): Buffer {
  const list = channels instanceof Float32Array ? [channels] : [...channels];
  const frames = list[0]!.length; const count = list.length;
  const data = Buffer.alloc(frames * count * 2);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < count; channel++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(list[channel]![frame]! * 32767))), (frame * count + channel) * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(count, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * count * 2, 28); header.writeUInt16LE(count * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The same noise every run. */
function noiseSource(seed = 7) { let state = seed; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 31 - 1; }; }

/** A kick: a sine falling from twice its pitch to it, dying away. */
export function kick(hz = 50, seconds = 0.5): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds)); let phase = 0;
  for (let index = 0; index < out.length; index++) {
    const t = index / RATE; const pitch = hz * (1 + Math.exp(-t / 0.02));
    phase += 2 * Math.PI * pitch / RATE;
    out[index] = 0.9 * Math.sin(phase) * Math.exp(-t / 0.12);
  }
  return out;
}

/** A hat: bright noise (each sample less the one before), gone in a few dozen milliseconds. */
export function hat(seconds = 0.12, seed = 3): Float32Array {
  const random = noiseSource(seed); const out = new Float32Array(Math.round(RATE * seconds)); let previous = 0;
  for (let index = 0; index < out.length; index++) { const value = random(); out[index] = 0.6 * (value - previous) * Math.exp(-index / RATE / 0.03); previous = value; }
  return out;
}

/** A snare: a tone and noise together. */
export function snare(seconds = 0.25): Float32Array {
  const random = noiseSource(11); const out = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < out.length; index++) { const t = index / RATE; out[index] = (0.4 * Math.sin(2 * Math.PI * 190 * t) + 0.5 * random()) * Math.exp(-t / 0.06); }
  return out;
}

/** Bars of four-to-the-floor at a tempo: a kick on each beat, a hat between. */
export function beat(bpm: number, bars: number): Float32Array {
  const beatFrames = Math.round(RATE * 60 / bpm); const out = new Float32Array(beatFrames * 4 * bars);
  const one = kick(55, 0.3); const tick = hat(0.08);
  for (let at = 0; at < bars * 4; at++) {
    out.set(one.subarray(0, Math.min(one.length, out.length - at * beatFrames)), at * beatFrames);
    const off = at * beatFrames + Math.round(beatFrames / 2);
    for (let index = 0; index < tick.length && off + index < out.length; index++) out[off + index]! += tick[index]!;
  }
  return out;
}

/** A pad: a chord of sines, fading in. */
export function pad(frequencies: readonly number[], seconds = 3): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < out.length; index++) {
    const t = index / RATE; let sum = 0;
    for (const hz of frequencies) sum += Math.sin(2 * Math.PI * hz * t);
    out[index] = 0.25 * sum / frequencies.length * Math.min(1, t / 0.4);
  }
  return out;
}

export function put(path: string, bytes: Buffer | string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Ableton MajorVersion="5" MinorVersion="12.0_12049" Creator="Ableton Live 12.1.5">\n${body}\n</Ableton>\n`;

/** A Live preset (.adv) for one device. */
export const livePreset = (tag: string, about = "") => gzipSync(xml(`\t<${tag} Id="0">\n\t\t<UserName Value="" />\n\t\t<Annotation Value="${about}" />\n\t</${tag}>`));
/** A rack (.adg) of `rack` holding `devices`. */
export const liveRack = (rack: string, devices: readonly string[]) => gzipSync(xml(`\t<GroupDevicePreset>\n\t\t<OverwriteProtectionNumber Value="3077" />\n\t\t<Device>\n\t\t\t<${rack} Id="0">\n\t\t\t\t<Branches><AudioEffectBranch Id="0"><DeviceChain><AudioToAudioDeviceChain Id="0"><Devices>${devices.map((tag, index) => `<${tag} Id="${index}" />`).join("")}</Devices></AudioToAudioDeviceChain></DeviceChain></AudioEffectBranch></Branches>\n\t\t\t</${rack}>\n\t\t</Device>\n\t</GroupDevicePreset>`));
export const maxDevice = (type: "instrument" | "audio_effect" | "midi_effect") => encodeAmxd(type, { patcher: { boxes: [] } });

export interface FakeTrack { kind: "AudioTrack" | "MidiTrack" | "GroupTrack" | "ReturnTrack"; name: string; id?: number; color?: number; group?: number; devices?: readonly string[]; samples?: readonly string[]; session?: number; arrangement?: readonly [number, number][] }
/** A device's XML: a tag, a plug-in ("plugin:Serum"), or written out. */
const deviceXml = (device: string, index: number) => device.startsWith("plugin:") ? `<PluginDevice Id="${index}"><UserName Value="" /><PluginDesc><Vst3PluginInfo Id="0"><Preset><Vst3Preset Id="0"><Name Value="Init" /></Vst3Preset></Preset><Name Value="${device.slice(7)}" /></Vst3PluginInfo></PluginDesc></PluginDevice>`
  : device.startsWith("<") ? device : `<${device} Id="${index}"><UserName Value="" /></${device}>`;
function trackXml(track: FakeTrack): string {
  const clips = Array.from({ length: track.session ?? 0 }, (_, index) => `<ClipSlot Id="${index}"><ClipSlot><Value><${track.kind === "AudioTrack" ? "AudioClip" : "MidiClip"} Id="0" Time="0"><CurrentEnd Value="16" />${track.kind === "AudioTrack" && track.samples?.[index] ? `<SampleRef><FileRef><RelativePath Value="x" /><Path Value="${track.samples[index]}" /></FileRef></SampleRef>` : ""}</${track.kind === "AudioTrack" ? "AudioClip" : "MidiClip"}></Value></ClipSlot></ClipSlot>`).join("");
  const timeline = (track.arrangement ?? []).map(([start, end], index) => `<${track.kind === "AudioTrack" ? "AudioClip" : "MidiClip"} Id="${index}" Time="${start}"><CurrentEnd Value="${end}" /></${track.kind === "AudioTrack" ? "AudioClip" : "MidiClip"}>`).join("");
  return `\t\t\t<${track.kind} Id="${track.id ?? 0}">\n\t\t\t\t<Name><EffectiveName Value="${track.name}" /><UserName Value="${track.name}" /></Name>\n\t\t\t\t<Color Value="${track.color ?? 0}" />\n\t\t\t\t<TrackGroupId Value="${track.group ?? -1}" />\n`
    + `\t\t\t\t<DeviceChain><Mixer><Volume><Manual Value="1" /></Volume></Mixer><MainSequencer><ClipSlotList>${clips}</ClipSlotList><${track.kind === "AudioTrack" ? "Sample" : "ClipTimeable"}><ArrangerAutomation><Events>${timeline}</Events></ArrangerAutomation></${track.kind === "AudioTrack" ? "Sample" : "ClipTimeable"}></MainSequencer>`
    + `<FreezeSequencer><ClipSlotList><ClipSlot Id="0"><ClipSlot><Value><AudioClip Id="0" Time="0"><CurrentEnd Value="999" /></AudioClip></Value></ClipSlot></ClipSlot></ClipSlotList></FreezeSequencer>`
    + `<DeviceChain><Devices>${(track.devices ?? []).map(deviceXml).join("")}</Devices></DeviceChain></DeviceChain>\n\t\t\t</${track.kind}>`;
}
/** A Live Set (.als): tempo, scale, tracks (returns among them, as Live keeps them) and the main track's devices. */
export function liveSet(options: { tempo: number; root?: number; scale?: number; tracks: readonly FakeTrack[]; main?: readonly string[]; scenes?: number }): Buffer {
  return gzipSync(xml(`\t<LiveSet>\n\t\t<Tracks>\n${options.tracks.map(trackXml).join("\n")}\n\t\t</Tracks>\n`
    + `\t\t<MainTrack><Name><EffectiveName Value="Main" /></Name><Color Value="4" /><DeviceChain><Mixer><Tempo><Manual Value="${options.tempo}" /></Tempo><TimeSignature><Manual Value="201" /></TimeSignature></Mixer>`
    + `<DeviceChain><Devices>${(options.main ?? []).map(deviceXml).join("")}</Devices></DeviceChain></DeviceChain></MainTrack>\n`
    + `\t\t<Scenes>${Array.from({ length: options.scenes ?? 2 }, (_, index) => `<Scene Id="${index}" />`).join("")}</Scenes>\n`
    + (options.root !== undefined ? `\t\t<ScaleInformation><Root Value="${options.root}" /><Name Value="${options.scale ?? 0}" /></ScaleInformation>\n\t\t<InKey Value="true" />\n` : "")
    + `\t</LiveSet>`));
}
