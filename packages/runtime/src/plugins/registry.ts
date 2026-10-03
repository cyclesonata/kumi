/**
 * Kumi's knowledge of popular plug-ins, matched to a plug-in device by its name, and set against the
 * plug-in's real parameters in Live: which of its knobs are which, which Live lets Kumi turn (the ones
 * configured in the device), and the rest of its thousands, grouped so the model reads them at a glance.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginAdapter } from "./adapter.js";
import { ADAPTERS } from "./adapters/index.js";

export type { PluginAdapter } from "./adapter.js";

/** The adapter for a plug-in device, by the name Live shows for it. */
export function adapterFor(deviceName: string, adapters: readonly PluginAdapter[] = ADAPTERS): PluginAdapter | undefined {
  const name = deviceName.trim();
  return adapters.find((adapter) => adapter.match.test(name));
}

/** A parameter as Live has it configured in the device: Kumi can turn these. */
export interface ExposedParameter { name: string; ref: string; display?: string }

/**
 * Names grouped by how they start ("A Level", "A Pan" … into "A …"), each group with its count and first
 * few names, so thousands read in a few lines.
 */
export function groupNames(names: readonly string[], maxGroups = 60): { group: string; count: number; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const words = name.trim().split(/\s+/);
    const key = words.length > 1 ? words.slice(0, words.length > 2 ? 2 : 1).join(" ") : name.replace(/\d+$/, "");
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups].slice(0, maxGroups).map(([group, members]) => ({ group, count: members.length, names: members.slice(0, 6) }));
}

/**
 * The guide the model reads: the adapter's knowledge (or none, for a plug-in Kumi doesn't know), each hint
 * matched to the plug-in's real parameter names (marked when Live exposes them), what Kumi can turn now,
 * and the rest of the names, grouped.
 */
export function pluginGuide(device: string, adapter: PluginAdapter | undefined, all: readonly string[], exposed: readonly ExposedParameter[]): Record<string, unknown> {
  const exposedNames = new Set(exposed.map((parameter) => parameter.name.toLowerCase()));
  const mark = (name: string) => (exposedNames.has(name.toLowerCase()) ? `${name} (Kumi can turn it)` : name);
  const sections = adapter?.sections.map((section) => ({ name: section.name, about: section.about,
    parameters: section.parameters.map((hint) => {
      const live = all.filter((name) => hint.names.test(name)).slice(0, 8);
      return { role: hint.role, about: hint.about, ...(live.length ? { live: live.map(mark) } : { live: "not among this plug-in's names (look in the grouped list)" }) };
    }) }));
  const hidden = all.filter((name) => !exposedNames.has(name.toLowerCase()));
  return {
    plugin: adapter ? `${adapter.name} (${adapter.vendor})` : device,
    ...(adapter ? { overview: adapter.overview } : { note: "Kumi has no notes on this plug-in: go by its parameter names, its manual (read_web), and listening." }),
    canTurn: exposed.map((parameter) => ({ name: parameter.name, ref: parameter.ref, ...(parameter.display ? { now: parameter.display } : {}) })),
    parameters: { total: all.length, canTurn: exposed.length, notConfigured: hidden.length, groups: groupNames(hidden) },
    ...(sections ? { sections } : {}),
    ...(adapter ? { recipes: adapter.recipes, beyond: adapter.beyond } : {}),
    ...(hidden.length ? { toTurnMore: "Live lets Kumi turn only the parameters configured in the device. To add some: the producer clicks Configure in the plug-in's title bar and moves those knobs in its window once (Live keeps them with the Set; Save as Default Configuration in the title bar's menu keeps them for every new one). Kumi can open the plug-in's window with set_device_details (isEditorOpen)." } : {}),
    ...(adapter?.wavetable ? { wavetables: `${adapter.name} reads wavetables (${adapter.wavetable.frame} samples a frame, up to ${adapter.wavetable.maxFrames} frames): plugin with action wavetable makes one into its folder.` } : {}),
  };
}

/** A folder from an adapter's "~/…" path, for this computer; undefined when the adapter has none for this OS. */
export function folderFor(paths: { mac?: string; windows?: string } | undefined): string | undefined {
  const path = process.platform === "win32" ? paths?.windows : process.platform === "darwin" ? paths?.mac : undefined;
  if (!path) return undefined;
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}
