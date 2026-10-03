/**
 * A parameter's value from the text the producer (or the model) would use: "800 Hz", "-6 dB", "35 %",
 * "1.2 s", "4:1", "Saw". Live's own text for values across the parameter's range (its str_for_value,
 * read once) is the map: the target is found between two of them and the value interpolated, in the
 * scale its unit moves on (frequencies and times by ratio, the rest evenly).
 */

/** A display text read as a number in base units (Hz, s, dB, %, ratio), with its unit; undefined when it isn't one. */
export function parseDisplay(text: string): { value: number; unit: string } | undefined {
  const cleaned = text.trim().replace(/−/g, "-").replace(/,/g, "").toLowerCase();
  if (/^-?\s*inf/.test(cleaned)) return { value: -Infinity, unit: cleaned.includes("db") ? "db" : "" };
  const ratio = /^(-?\d+(?:\.\d+)?)\s*:\s*1$/.exec(cleaned);
  if (ratio) return { value: Number(ratio[1]), unit: "ratio" };
  const match = /^(-?\d*\.?\d+(?:e-?\d+)?)\s*(khz|hz|ms|s|sec|db|%|st|semi|cents?|ct|bpm|x|°|deg|k)?(?![a-z])/.exec(cleaned);
  if (!match) return undefined;
  let value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  let unit = match[2] ?? "";
  if (unit === "khz") { value *= 1000; unit = "hz"; }
  else if (unit === "k") { value *= 1000; unit = "hz"; }
  else if (unit === "ms") { value /= 1000; unit = "s"; }
  else if (unit === "sec") unit = "s";
  else if (unit === "semi") unit = "st";
  else if (unit === "cent" || unit === "ct") unit = "cents";
  else if (unit === "deg") unit = "°";
  return { value, unit };
}

/** Live's text across a parameter's range: [value, text] pairs (min to max), or a stepped parameter's named items. */
export interface DisplayMap { min: number; max: number; grid: [number, string][]; items?: string[] }

/**
 * The value that shows `target`, or why not. A number in the parameter's own range is taken as it is; a
 * name ("Saw") picks the step that shows it; a quantity ("800 Hz") is placed between the two grid points
 * around it.
 */
export function valueForDisplay(map: DisplayMap, target: string | number): number | string {
  if (typeof target === "number") return target;
  const text = target.trim();
  if (text !== "" && Number.isFinite(Number(text))) return Number(text);
  // A stepped parameter (a menu, a switch): the item by its name, or the grid point that shows it.
  const wanted = text.toLowerCase();
  if (map.items?.length) {
    const index = map.items.findIndex((item) => item.toLowerCase() === wanted) >= 0 ? map.items.findIndex((item) => item.toLowerCase() === wanted)
      : map.items.findIndex((item) => item.toLowerCase().startsWith(wanted));
    if (index >= 0) return map.min + index * (map.items.length > 1 ? (map.max - map.min) / (map.items.length - 1) : 0);
  }
  const shown = map.grid.find(([, label]) => label.trim().toLowerCase() === wanted);
  if (shown) return shown[0];
  const goal = parseDisplay(text);
  if (!goal) return `“${text}” isn't a value Kumi can place on this parameter; give a number between ${map.min} and ${map.max}${map.items?.length ? `, or one of ${map.items.slice(0, 12).join(", ")}` : ""}.`;
  // The grid read as numbers in the target's unit (a grid in kHz and Hz is one scale).
  const points = map.grid.map(([value, label]) => ({ value, read: parseDisplay(label) })).filter((point) => point.read && (point.read.unit === goal.unit || !goal.unit || !point.read.unit))
    .map((point) => ({ value: point.value, shown: point.read!.value }));
  if (points.length < 2) return `This parameter doesn't show values in ${goal.unit || "plain numbers"}; give a number between ${map.min} and ${map.max}.`;
  const logScale = (goal.unit === "hz" || goal.unit === "s") && points.every((point) => point.shown > 0) && goal.value > 0;
  const scale = (shown: number) => (logScale ? Math.log(shown) : shown);
  const at = scale(goal.value);
  // The first stretch of the grid the target falls in (the grid may rise or fall).
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!; const b = points[index]!;
    const lo = Math.min(scale(a.shown), scale(b.shown)); const hi = Math.max(scale(a.shown), scale(b.shown));
    if (at < lo || at > hi) continue;
    const span = scale(b.shown) - scale(a.shown);
    return span === 0 ? a.value : a.value + (b.value - a.value) * ((at - scale(a.shown)) / span);
  }
  // Past either end: the nearest end, said as such by the caller's readback.
  const ends = [points[0]!, points.at(-1)!];
  const nearest = Math.abs(scale(ends[0]!.shown) - at) <= Math.abs(scale(ends[1]!.shown) - at) ? ends[0]! : ends[1]!;
  return nearest.value;
}

/** The Python that reads a parameter's map in Live (obj is the parameter): its range, named steps, and its text at 129 points. */
export const DISPLAY_MAP_SCRIPT = [
  "p = obj",
  "lo, hi = float(p.min), float(p.max)",
  "items = [str(item) for item in p.value_items] if getattr(p, 'is_quantized', False) else []",
  "count = 129",
  "grid = [[lo + (hi - lo) * i / (count - 1), str(p.str_for_value(lo + (hi - lo) * i / (count - 1)))] for i in range(count)]",
  "result = {'min': lo, 'max': hi, 'items': items, 'grid': grid}",
].join("\n");
