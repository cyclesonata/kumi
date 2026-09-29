/** Which bridge release Kumi's tools need: some need fixes that came after the bridge a producer may have. */

/** The bridge release with the fixes the newer tools need (1.0.33 refused them in real Live). */
export const FIXED_BRIDGE = "1.0.34";

/** The bridge release that can press Live's Back to Arrangement (play's back-to-arrangement). */
export const ARRANGEMENT_BRIDGE = "1.0.35";

/** The bridge release that selects a device in Live (Song.View.select_device), and names the selected one. */
export const DEVICE_SELECT_BRIDGE = "1.0.42";

/** Whether `version` ("1.0.34", "1.0.34-beta.1") is `minimum` or later; an unknown version counts as later. */
export function atLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return true;
  const parse = (text: string) => text.split(/[-+]/, 1)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version); const need = parse(minimum);
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
