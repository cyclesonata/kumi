/**
 * Kumi's wordmark: lowercase letters in half blocks over a dithered rule. The same pixels make the
 * README's logo (docs/assets/kumi-logo.svg).
 */

/** The letters, four rows of half blocks. */
export const LOGO_LETTERS: readonly string[] = [
  "██                          ▀▀",
  "██ ▄█▀  ██  ██  ██▀▀██▀▀█▄  ██",
  "██▀█▄   ██  ██  ██  ██  ██  ██",
  "▀▀  ▀▀   ▀▀▀▀▀  ▀▀  ▀▀  ▀▀  ▀▀",
];

/** The rule under the letters: solid in the middle, dithering out at both ends. */
export const LOGO_RULE = "░▒▓████████████████████████▓▒░";

/** How wide the wordmark is, in cells. */
export const LOGO_WIDTH = Math.max(...LOGO_LETTERS.map((line) => [...line].length), [...LOGO_RULE].length);

/** Rows the whole wordmark takes: the letters, a gap and the rule. */
export const LOGO_HEIGHT = LOGO_LETTERS.length + 2;
