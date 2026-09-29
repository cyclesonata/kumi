/**
 * FOCUS's device view: a track's devices as a tree, the path to what's selected in Live open and
 * everything else folded to a count, so the producer sees where they are, and can point at any of it.
 */
import type { ChainNode, DeviceNode, DeviceTree } from "@kumi/runtime";
import { deviceKind, type IconKind } from "./icons.js";

export interface TreeRow {
  ref: string;
  node: "device" | "chain";
  kind: IconKind;
  name: string;
  /** The tree lines before it ("│ ├ "). */
  prefix: string;
  /** What's folded inside: a rack's chains, a chain's devices. */
  count?: number;
  /** "focus": selected in Live; "path": on the way to it; "other": the rest (quieter when there's a focus). */
  role: "focus" | "path" | "other";
  /** Its racks and chains, outermost first: where it is, for the pin and the model. */
  trail: string[];
  /** Its neighbours in the same chain (or on the track), for the model. */
  siblings: string[];
}

/**
 * Where Live's selection is: the path of racks and chains to the selected device, by reference, or,
 * when that isn't on this track, to the selected chain; undefined when neither is found.
 */
export function focusPathRefs(tree: DeviceTree, device: string | undefined, chain: string | undefined, deviceRef?: string): string[] | undefined {
  // The bridge names the selected device exactly (1.0.42): its path, whatever the names.
  const exact = deviceRef ? refPath(tree.devices, deviceRef, []) : undefined;
  if (exact) return exact;
  const onDevice = device ? devicePath(tree, device, chain) : undefined;
  if (onDevice || !chain) return onDevice;
  const walk = (devices: readonly DeviceNode[], trail: string[]): string[] | undefined => {
    for (const item of devices) for (const child of item.chains ?? []) {
      if (child.name === chain) return [...trail, item.ref, child.ref];
      const deeper = walk(child.devices ?? [], [...trail, item.ref, child.ref]);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return walk(tree.devices, []);
}

function refPath(devices: readonly DeviceNode[], ref: string, trail: string[]): string[] | undefined {
  for (const item of devices) {
    if (item.ref === ref) return [...trail, item.ref];
    for (const child of item.chains ?? []) {
      const found = refPath(child.devices ?? [], ref, [...trail, item.ref, child.ref]);
      if (found) return found;
    }
  }
  return undefined;
}

function devicePath(tree: DeviceTree, device: string, chain: string | undefined): string[] | undefined {
  const found: string[][] = [];
  const walk = (devices: readonly DeviceNode[], trail: string[], parentChain?: string) => {
    for (const item of devices) {
      if (item.name === device) found.push([...trail, item.ref, ...(parentChain === chain ? ["preferred"] : [])]);
      for (const child of item.chains ?? []) walk(child.devices ?? [], [...trail, item.ref, child.ref], child.name);
    }
  };
  walk(tree.devices, []);
  // Two devices of one name: the one in the chain selected in Live.
  const best = found.find((path) => path.at(-1) === "preferred") ?? found[0];
  return best?.filter((ref) => ref !== "preferred");
}

/** The tree as rows: every device on the track, racks and chains on the path open, the rest folded with a count. */
export function treeRows(tree: DeviceTree, focus: { device?: string; chain?: string; deviceRef?: string } = {}): TreeRow[] {
  const path = focusPathRefs(tree, focus.device, focus.chain, focus.deviceRef);
  const open = new Set(path ?? []);
  const focused = path?.at(-1);
  const rows: TreeRow[] = [];
  const role = (ref: string): TreeRow["role"] => (ref === focused ? "focus" : open.has(ref) ? "path" : "other");
  const devicesAt = (devices: readonly DeviceNode[], lead: string, trail: string[]) => {
    devices.forEach((device, index) => {
      const last = index === devices.length - 1;
      const siblings = devices.filter((other) => other !== device).map((other) => other.name);
      const chains = device.chains ?? [];
      const expanded = open.has(device.ref) && chains.length > 0;
      rows.push({ ref: device.ref, node: "device", kind: deviceKind(device), name: device.name, prefix: `${lead}${last ? "└ " : "├ "}`,
        ...(chains.length && !expanded ? { count: chains.length } : {}), role: role(device.ref), trail, siblings });
      if (expanded) chainsAt(chains, `${lead}${last ? "  " : "│ "}`, [...trail, device.name], device);
    });
  };
  const chainsAt = (chains: readonly ChainNode[], lead: string, trail: string[], rack: DeviceNode) => {
    chains.forEach((chain, index) => {
      const last = index === chains.length - 1;
      const expanded = open.has(chain.ref) && (chain.devices?.length ?? 0) > 0;
      rows.push({ ref: chain.ref, node: "chain", kind: rack.canHaveDrumPads ? "drum-pad" : "chain", name: chain.name, prefix: `${lead}${last ? "└ " : "├ "}`,
        ...(!expanded && chain.devices?.length ? { count: chain.devices.length } : {}), role: role(chain.ref), trail,
        siblings: chains.filter((other) => other !== chain).map((other) => other.name) });
      if (expanded) devicesAt(chain.devices!, `${lead}${last ? "  " : "│ "}`, [...trail, chain.name]);
    });
  };
  devicesAt(tree.devices, "", []);
  return rows;
}

/** At most `height` rows, a window that keeps `keep` (the focus, or the keyboard's place) in view; how many are cut above and below. */
export function treeWindow(rows: readonly TreeRow[], height: number, keep: number): { rows: TreeRow[]; above: number; below: number } {
  if (rows.length <= height) return { rows: [...rows], above: 0, below: 0 };
  const start = Math.max(0, Math.min(rows.length - height, (keep < 0 ? 0 : keep) - Math.floor(height / 2)));
  return { rows: rows.slice(start, start + height), above: start, below: rows.length - start - height };
}
