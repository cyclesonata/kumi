/** The input box: text and cursor. Positions count graphemes, so the cursor never splits a character. */
import { cellWidth, graphemes } from "./width.js";

export interface EditorLayout {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

export class Editor {
  private chars: string[] = [];
  private position = 0;

  get text(): string {
    return this.chars.join("");
  }

  get cursor(): number {
    return this.position;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  set(text: string): void {
    this.chars = graphemes(text);
    this.position = this.chars.length;
  }

  clear(): void {
    this.chars = [];
    this.position = 0;
  }

  insert(text: string): void {
    const before = this.chars.slice(0, this.position).join("") + text;
    // Re-segment, so a combining mark typed after a letter joins it.
    this.chars = graphemes(before + this.chars.slice(this.position).join(""));
    this.position = graphemes(before).length;
  }

  backspace(): void {
    if (this.position === 0) return;
    this.chars.splice(this.position - 1, 1);
    this.position--;
  }

  delete(): void {
    if (this.position < this.chars.length) this.chars.splice(this.position, 1);
  }

  left(): void {
    this.position = Math.max(0, this.position - 1);
  }

  right(): void {
    this.position = Math.min(this.chars.length, this.position + 1);
  }

  wordLeft(): void {
    while (this.position > 0 && /\s/.test(this.chars[this.position - 1]!)) this.position--;
    while (this.position > 0 && !/\s/.test(this.chars[this.position - 1]!)) this.position--;
  }

  wordRight(): void {
    while (this.position < this.chars.length && /\s/.test(this.chars[this.position]!)) this.position++;
    while (this.position < this.chars.length && !/\s/.test(this.chars[this.position]!)) this.position++;
  }

  deleteWordLeft(): void {
    const end = this.position;
    this.wordLeft();
    this.chars.splice(this.position, end - this.position);
  }

  home(): void {
    while (this.position > 0 && this.chars[this.position - 1] !== "\n") this.position--;
  }

  end(): void {
    while (this.position < this.chars.length && this.chars[this.position] !== "\n") this.position++;
  }

  killToEnd(): void {
    let end = this.position;
    while (end < this.chars.length && this.chars[end] !== "\n") end++;
    this.chars.splice(this.position, end - this.position);
  }

  killToStart(): void {
    const end = this.position;
    this.home();
    this.chars.splice(this.position, end - this.position);
  }

  /** Rows as displayed at `width` cells (wrapping between characters), with the cursor's place. */
  layout(width: number): EditorLayout {
    return this.measure(Math.max(1, width)).layout;
  }

  /** Move to the row above or below, keeping the column where possible. */
  vertical(width: number, direction: -1 | 1): boolean {
    const { layout, places } = this.measure(Math.max(1, width));
    const row = layout.cursorRow + direction;
    if (row < 0 || row >= layout.rows.length) return false;
    let best = -1;
    for (let index = 0; index <= this.chars.length; index++) {
      const place = places[index]!;
      if (place.row === row && place.column <= layout.cursorColumn) best = index;
    }
    if (best < 0) best = places.findIndex((place) => place.row === row);
    this.position = best;
    return true;
  }

  private measure(width: number): { layout: EditorLayout; places: { row: number; column: number }[] } {
    const rows: string[] = [""];
    const places: { row: number; column: number }[] = [];
    let column = 0;
    for (const character of this.chars) {
      if (character === "\n") {
        places.push({ row: rows.length - 1, column });
        rows.push("");
        column = 0;
        continue;
      }
      const cells = cellWidth(character);
      if (column + cells > width) {
        rows.push("");
        column = 0;
      }
      places.push({ row: rows.length - 1, column });
      rows[rows.length - 1] += character;
      column += cells;
    }
    if (column >= width) {
      rows.push("");
      column = 0;
    }
    places.push({ row: rows.length - 1, column });
    const at = places[this.position]!;
    return { layout: { rows, cursorRow: at.row, cursorColumn: at.column }, places };
  }
}
