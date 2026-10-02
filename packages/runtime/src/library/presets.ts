/**
 * Presets and devices the producer owns: Live's presets and racks (.adv, .adg), Max for Live devices
 * (.amxd) and plug-ins' own presets (.vstpreset, .aupreset, .fxp). Each is known by its name, its
 * folder, what kind of device it loads as and which device; only a file's first bytes are read.
 */
import { open } from "node:fs/promises";
import { deviceName } from "./sets.js";
import { attribute, scanTags, xmlHead } from "./xml.js";

export const PRESET_EXTENSIONS = new Set([".adv", ".adg", ".amxd", ".vstpreset", ".aupreset", ".fxp", ".fxb"]);
export type PresetCategory = "instrument" | "audio effect" | "midi effect" | "drum rack" | "plug-in";

export interface PresetFacts {
  /** The device it is, or loads: "Wavetable", "Instrument Rack", "Serum". */
  device?: string;
  category?: PresetCategory;
  /** A rack's devices, as far as its first kilobytes say. */
  inside?: string[];
  /** Its info text, when it has one. */
  about?: string;
}

const RACK_CATEGORY: Record<string, PresetCategory> = { InstrumentGroupDevice: "instrument", DrumGroupDevice: "drum rack", AudioEffectGroupDevice: "audio effect", MidiEffectGroupDevice: "midi effect" };
const INSTRUMENT_TAGS = new Set(["OriginalSimpler", "MultiSampler", "Operator", "UltraAnalog", "InstrumentVector", "Drift", "InstrumentMeld", "Collision", "LoungeLizard",
  "StringStudio", "InstrumentImpulse", "DrumCell", "ProxyInstrumentDevice"]);
const categoryOf = (tag: string): PresetCategory => RACK_CATEGORY[tag] ?? (INSTRUMENT_TAGS.has(tag) ? "instrument" : tag.startsWith("Midi") ? "midi effect" : "audio effect");

/** What a Live preset or rack's first kilobytes say: its device (the first one), its rack's devices, its info text. */
export async function readLivePreset(path: string): Promise<PresetFacts> {
  const text = await xmlHead(path, 24 * 1024);
  const stack: string[] = [];
  let root: { tag: string; depth: number } | undefined;
  const inside = new Set<string>(); let about: string | undefined; let plugin: string | undefined;
  scanTags(text, {
    open(name, attrs) {
      const depth = stack.length;
      // .adv: <Ableton><Eq8>; .adg: <Ableton><GroupDevicePreset><Device><InstrumentGroupDevice>.
      if (!root && depth >= 1 && stack[0] === "Ableton" && name !== "GroupDevicePreset" && name !== "Device" && !/^(OverwriteProtectionNumber|PresetRef)$/.test(name)) root = { tag: name, depth };
      else if (root && stack.at(-1) === "Devices" && name !== "MacroControls") inside.add(deviceName(name));
      if (root && depth === root.depth + 1 && name === "Annotation" && !about) { const text = attribute(attrs, "Value")?.trim(); if (text) about = text.slice(0, 200); }
      if (root && (name === "PlugName" || (name === "Name" && (stack.at(-1) === "Vst3PluginInfo" || stack.at(-1) === "AuPluginInfo"))) && !plugin) plugin = attribute(attrs, "Value") || undefined;
      stack.push(name);
    },
    close() { stack.pop(); },
  });
  if (!root) return {};
  if (root.tag === "PluginDevice" || root.tag === "AuPluginDevice") return { category: "plug-in", ...(plugin ? { device: plugin } : {}), ...(about ? { about } : {}) };
  return { device: deviceName(root.tag), category: root.tag.startsWith("MxDevice") ? root.tag === "MxDeviceInstrument" ? "instrument" : root.tag === "MxDeviceMidiEffect" ? "midi effect" : "audio effect" : categoryOf(root.tag),
    ...(inside.size ? { inside: [...inside].slice(0, 12) } : {}), ...(about ? { about } : {}) };
}

/** A Max for Live device's kind, from its header ("ampf", then "aaaa", "iiii" or "mmmm"). */
export async function readMaxDevice(path: string): Promise<PresetFacts> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    await file.read(head, 0, 12, 0);
    if (head.toString("latin1", 0, 4) !== "ampf") return { device: "Max for Live" };
    const code = head.toString("latin1", 8, 12);
    return { device: "Max for Live", category: code === "iiii" ? "instrument" : code === "mmmm" ? "midi effect" : "audio effect" };
  } finally { await file.close(); }
}

/** A plug-in preset's plug-in: presets live in <maker>/<plug-in>/… under the presets folder. */
export function pluginPresetFacts(relativePath: string): PresetFacts {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const plugin = parts.length >= 3 ? parts[1] : parts.length === 2 ? parts[0] : undefined;
  return { category: "plug-in", ...(plugin ? { device: plugin } : {}) };
}
