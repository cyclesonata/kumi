/** A minimal terminal, enough of xterm to replay Kumi's renderer output in tests. */
import { styleKey, type Rgb, type Style } from "../src/tui/style.js";
import { cellWidth, graphemes } from "../src/tui/width.js";

export class VirtualTerminal {
  readonly chars: string[][];
  readonly styles: string[][];
  x = 0;
  y = 0;
  cursorVisible = true;
  private style: Style = {};

  constructor(readonly width: number, readonly height: number) {
    this.chars = Array.from({ length: height }, () => Array<string>(width).fill(" "));
    this.styles = Array.from({ length: height }, () => Array<string>(width).fill(styleKey({})));
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      if (data[index] === "\u001b" && data[index + 1] === "[") {
        let end = index + 2;
        while (end < data.length && !(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)) end++;
        this.csi(data.slice(index + 2, end), data[end] ?? "");
        index = end + 1;
        continue;
      }
      if (data[index] === "\u001b") {
        // OSC (clipboard, titles) ends at BEL or ESC \; it draws nothing. Other escapes are two characters.
        if (data[index + 1] === "]") {
          const bell = data.indexOf("\u0007", index); const st = data.indexOf("\u001b\\", index);
          const ends = [bell < 0 ? Infinity : bell + 1, st < 0 ? Infinity : st + 2];
          index = Math.min(...ends, data.length);
        } else index += 2;
        continue;
      }
      let end = index;
      while (end < data.length && data[end] !== "\u001b") end++;
      for (const grapheme of graphemes(data.slice(index, end))) this.print(grapheme);
      index = end;
    }
  }

  lines(): string[] {
    return this.chars.map((row) => row.join(""));
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?")) {
      if (params === "?25") this.cursorVisible = final === "h";
      return;
    }
    if (final === "H") {
      const [row = "1", column = "1"] = params.split(";");
      this.y = Number(row) - 1;
      this.x = Number(column) - 1;
    } else if (final === "J" && params === "2") {
      const blank = styleKey(this.style.bg ? { bg: this.style.bg } : {});
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) { this.chars[y]![x] = " "; this.styles[y]![x] = blank; }
    } else if (final === "m") {
      this.sgr(params);
    }
  }

  private sgr(params: string): void {
    const codes = params === "" ? [0] : params.split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0) this.style = {};
      else if (code === 1) this.style = { ...this.style, bold: true };
      else if (code === 2) this.style = { ...this.style, dim: true };
      else if (code === 3) this.style = { ...this.style, italic: true };
      else if (code === 4) this.style = { ...this.style, underline: true };
      else if (code === 7) this.style = { ...this.style, inverse: true };
      else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
        const rgb: Rgb = [codes[index + 2]!, codes[index + 3]!, codes[index + 4]!];
        this.style = code === 38 ? { ...this.style, fg: rgb } : { ...this.style, bg: rgb };
        index += 4;
      } else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
        index += 2;
      }
    }
  }

  private print(grapheme: string): void {
    const cells = cellWidth(grapheme);
    if (cells === 0 || this.y >= this.height) return;
    if (this.x >= this.width) this.x = this.width - 1; // autowrap is off
    const row = this.chars[this.y]!;
    // Like a real terminal, overwriting half of a wide character blanks the other half.
    if (row[this.x] === "" && this.x > 0) row[this.x - 1] = " ";
    if (cells === 1 && row[this.x + 1] === "") row[this.x + 1] = " ";
    row[this.x] = grapheme;
    this.styles[this.y]![this.x] = styleKey(this.style);
    if (cells === 2 && this.x + 1 < this.width) {
      if (row[this.x + 2] === "") row[this.x + 2] = " ";
      row[this.x + 1] = "";
      this.styles[this.y]![this.x + 1] = styleKey(this.style);
    }
    this.x += cells;
  }
}
