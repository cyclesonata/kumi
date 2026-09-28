/** Turns screens into terminal output, writing only the cells that changed since the last frame. */
import type { Screen } from "./screen.js";
import { sgr, type ColorDepth, type StyleTable } from "./style.js";

export const cursorTo = (x: number, y: number) => `\u001b[${y + 1};${x + 1}H`;
const SYNC_START = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const RESET = "\u001b[0m";

export interface Cursor {
  x: number;
  y: number;
}

interface Frame {
  width: number;
  height: number;
  table: StyleTable;
  chars: string[];
  widths: Uint8Array;
  styles: Uint32Array;
  cursor: string;
}

export class Renderer {
  private previous: Frame | undefined;

  constructor(private depth: ColorDepth) {}

  /** Forget what the terminal shows, so the next frame redraws everything (after a resize, say). */
  invalidate(): void {
    this.previous = undefined;
  }

  /**
   * Output that turns the last frame into `screen`, inside one synchronized update so the
   * terminal never shows half a frame. The hardware cursor is shown at `cursor` (where
   * input methods for Japanese and Chinese open), or hidden. Empty when nothing changed.
   */
  frame(screen: Screen, cursor?: Cursor): string {
    const previous = this.previous;
    const full = !previous || previous.width !== screen.width || previous.height !== screen.height || previous.table !== screen.table;
    const cursorKey = cursor ? `${cursor.x},${cursor.y}` : "";
    let body = "";
    let x0 = -1;
    let y0 = -1;
    let style = -1;
    for (let y = 0; y < screen.height; y++) {
      for (let x = 0; x < screen.width; x++) {
        const index = y * screen.width + x;
        const cells = screen.widths[index]!;
        if (cells === 0) continue;
        if (!full && previous.chars[index] === screen.chars[index] && previous.widths[index] === cells && previous.styles[index] === screen.styles[index]) continue;
        if (x !== x0 || y !== y0) body += cursorTo(x, y);
        const id = screen.styles[index]!;
        if (id !== style) {
          body += sgr(screen.table.style(id), this.depth);
          style = id;
        }
        body += screen.chars[index];
        x0 = x + cells;
        y0 = y;
      }
    }
    this.previous = {
      width: screen.width, height: screen.height, table: screen.table, cursor: cursorKey,
      chars: screen.chars.slice(), widths: screen.widths.slice(), styles: screen.styles.slice(),
    };
    if (!full && !body && previous.cursor === cursorKey) return "";
    return SYNC_START + HIDE_CURSOR + (full ? `${RESET}\u001b[2J` : "") + body + RESET
      + (cursor ? cursorTo(cursor.x, cursor.y) + SHOW_CURSOR : "") + SYNC_END;
  }
}
