/** A grid of terminal cells that components draw into; the renderer turns it into output. */
import { StyleTable, type Style } from "./style.js";
import { cellWidth, graphemes } from "./width.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A wide character (CJK, most emoji) fills its own cell plus the next one, which is
 * kept as an empty continuation cell of width 0. Overwriting either half of a wide
 * character blanks the other half, as a terminal would.
 */
export class Screen {
  readonly chars: string[];
  readonly widths: Uint8Array;
  readonly styles: Uint32Array;

  constructor(readonly width: number, readonly height: number, readonly table: StyleTable = new StyleTable()) {
    const size = Math.max(0, width * height);
    this.chars = new Array<string>(size).fill(" ");
    this.widths = new Uint8Array(size).fill(1);
    this.styles = new Uint32Array(size);
  }

  get bounds(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /** Paint a rectangle, clipped to the screen, with spaces in `style`. */
  fill(rect: Rect, style: Style): void {
    const id = this.table.id(style);
    const area = intersect(rect, this.bounds);
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) this.set(x, y, " ", 1, id);
    }
  }

  /**
   * Write text starting at (x, y), inside `clip`. A style without a background keeps
   * the background already painted underneath. Returns the column after the text.
   */
  put(x: number, y: number, text: string, style: Style, clip: Rect = this.bounds): number {
    const area = intersect(clip, this.bounds);
    const right = area.x + area.width;
    if (y < area.y || y >= area.y + area.height) return x;
    let column = x;
    for (const grapheme of graphemes(text)) {
      let character = grapheme;
      let cells = cellWidth(grapheme);
      if (CONTROL.test(grapheme)) { character = " "; cells = 1; }
      if (cells === 0) continue;
      if (column >= right) return column + cells;
      if (column + cells > right || column < area.x) {
        // Only part of a wide character is visible: show its visible cell blank.
        const visible = Math.max(column, area.x);
        if (visible < right && visible < column + cells) this.cell(visible, y, " ", 1, style);
      } else {
        this.cell(column, y, character, cells, style);
      }
      column += cells;
    }
    return column;
  }

  /** The character, width and style id at (x, y); continuation cells have width 0. */
  at(x: number, y: number): { char: string; width: number; style: Style } {
    const index = y * this.width + x;
    return { char: this.chars[index]!, width: this.widths[index]!, style: this.table.style(this.styles[index]!) };
  }

  /** The visible text of each row; for tests and debugging. */
  lines(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) if (this.widths[y * this.width + x] !== 0) row += this.chars[y * this.width + x];
      rows.push(row);
    }
    return rows;
  }

  private cell(x: number, y: number, character: string, cells: number, style: Style): void {
    const index = y * this.width + x;
    const underneath = this.table.style(this.styles[index]!).bg;
    const id = this.table.id(!style.bg && underneath ? { ...style, bg: underneath } : style);
    this.set(x, y, character, cells, id);
    if (cells === 2) this.set(x + 1, y, "", 0, id);
  }

  private set(x: number, y: number, character: string, cells: number, id: number): void {
    const index = y * this.width + x;
    if (cells !== 0 && this.widths[index] === 0 && x > 0 && this.widths[index - 1] === 2) {
      this.chars[index - 1] = " ";
      this.widths[index - 1] = 1;
    }
    if (cells !== 2 && this.widths[index] === 2 && x + 1 < this.width) {
      this.chars[index + 1] = " ";
      this.widths[index + 1] = 1;
    }
    this.chars[index] = character;
    this.widths[index] = cells;
    this.styles[index] = id;
  }
}
