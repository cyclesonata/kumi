/**
 * The right pane's lower half: tabs in a fixed corner, each tab's rows right under its name. A tab is a
 * module that says its title, an optional count, and its rows for a width; the panel owns the strip,
 * which tab is showing, each tab's scroll and the keyboard's place, and draws the window of rows with
 * a quiet "n more" at the ends. HISTORY is the first tab; later ones only need to be registered.
 */
import type { Screen } from "./screen.js";
import { palette, type Style } from "./style.js";
import { textWidth, truncate } from "./width.js";

/** One row of a tab: its text, what's at its right edge, and what choosing it does. */
export interface TabRow {
  spans: { text: string; style: Style }[];
  right?: { text: string; style: Style };
  /** Clicking the right edge, or Enter on the row, does this. */
  action?: () => void;
  /** Rows of one thing (a change whose title takes two) share this, so "n more" counts things, not rows. */
  item?: string;
}

export interface Tab {
  readonly id: string;
  readonly title: string;
  /** A dim count beside the title, when there's something to count. */
  badge?(): number | undefined;
  /** The tab's rows at this width, first row on top. */
  rows(width: number): TabRow[];
  /** What it says when it has no rows. */
  empty?: string;
}

interface Hit { x: number; y: number; width: number; action: () => void }
interface Area { x: number; y: number; width: number; height: number }

const faint: Style = { fg: palette.faint };
const dim: Style = { fg: palette.dim };
const accent: Style = { fg: palette.accent };
const rule: Style = { fg: palette.rule };
const cursorBand: Style = { bg: palette.selected };

export class TabPanel {
  private active: string;
  private readonly scrolls = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  /** The keyboard's row in the active tab, while the keyboard is in the panel. */
  cursor: number | undefined;
  private lastRows: TabRow[] = [];
  private lastHeight = 1;

  constructor(private readonly tabs: readonly Tab[], active?: string, private readonly onSwitch?: (id: string) => void) {
    this.active = tabs.some((tab) => tab.id === active) ? active! : tabs[0]!.id;
  }

  get activeId(): string { return this.active; }
  get inside(): boolean { return this.cursor !== undefined; }

  /** Show a tab (by click on the strip, or the next one by key); with one tab, nothing changes. */
  show(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id) || id === this.active) return;
    this.active = id; this.cursor = this.cursor === undefined ? undefined : 0;
    this.onSwitch?.(id);
  }
  next(): void {
    const index = this.tabs.findIndex((tab) => tab.id === this.active);
    this.show(this.tabs[(index + 1) % this.tabs.length]!.id);
  }

  /** Rows down (positive) or up; held within the tab's rows. */
  scrollBy(rows: number): void {
    const most = Math.max(0, (this.totals.get(this.active) ?? 0) - this.lastHeight);
    this.scrolls.set(this.active, Math.max(0, Math.min(most, (this.scrolls.get(this.active) ?? 0) + rows)));
  }

  /** The keyboard comes in at the first row showing, or leaves. */
  enter(): void { const scroll = this.scrolls.get(this.active) ?? 0; this.cursor = Math.min(scroll + (scroll > 0 ? 1 : 0), Math.max(0, this.lastRows.length - 1)); }
  leave(): void { this.cursor = undefined; }

  /** Keys while the keyboard is in the panel: arrows and pages move, Enter does the row's action. True when used. */
  key(name: string): boolean {
    if (this.cursor === undefined) return false;
    const count = this.lastRows.length;
    const move = (by: number) => {
      this.cursor = Math.max(0, Math.min(Math.max(0, count - 1), this.cursor! + by));
      // Kept in view, clear of the "n more" rows at the ends.
      const scroll = this.scrolls.get(this.active) ?? 0;
      if (this.cursor < scroll + (scroll > 0 ? 1 : 0)) this.scrolls.set(this.active, Math.max(0, this.cursor - 1));
      else if (this.cursor > scroll + this.lastHeight - 2 && this.cursor < count - 1) this.scrolls.set(this.active, this.cursor - this.lastHeight + 2);
      else if (this.cursor === count - 1) this.scrolls.set(this.active, Math.max(0, count - this.lastHeight));
    };
    if (name === "up") { move(-1); return true; }
    if (name === "down") { move(1); return true; }
    if (name === "pageup") { move(-this.lastHeight); return true; }
    if (name === "pagedown") { move(this.lastHeight); return true; }
    if (name === "enter") { this.lastRows[this.cursor]?.action?.(); return true; }
    return false;
  }

  /** The strip on the area's first row, then the active tab's rows filling the rest. */
  draw(screen: Screen, area: Area, hits: Hit[]): void {
    let x = area.x;
    this.tabs.forEach((tab, index) => {
      if (index > 0) x = screen.put(x, area.y, "   ", faint);
      const title = tab.id === this.active ? accent : dim;
      const start = x;
      x = screen.put(x, area.y, tab.title, title);
      const count = tab.badge?.();
      if (count) x = screen.put(x, area.y, ` ${count}`, faint);
      hits.push({ x: start, y: area.y, width: x - start, action: () => this.show(tab.id) });
    });
    // A quiet rule to the edge: the strip reads as a heading over its rows, finished with one tab too.
    if (x + 1 < area.x + area.width) screen.put(x + 1, area.y, "─".repeat(area.x + area.width - x - 1), rule);
    const tab = this.tabs.find((item) => item.id === this.active)!;
    const rows = tab.rows(area.width);
    const height = Math.max(1, area.height - 1);
    // Rows that arrive at the top while scrolled down keep the view where it was.
    const before = this.totals.get(tab.id);
    const scrolled = this.scrolls.get(tab.id) ?? 0;
    if (before !== undefined && rows.length > before && scrolled > 0) this.scrolls.set(tab.id, scrolled + rows.length - before);
    if (before !== undefined && rows.length > before && this.cursor !== undefined && this.cursor > 0) this.cursor += rows.length - before;
    this.totals.set(tab.id, rows.length);
    this.lastRows = rows; this.lastHeight = height;
    if (!rows.length) { screen.put(area.x, area.y + 1, truncate(tab.empty ?? "Nothing here yet", area.width), faint); return; }
    const scroll = Math.max(0, Math.min(this.scrolls.get(tab.id) ?? 0, Math.max(0, rows.length - height)));
    this.scrolls.set(tab.id, scroll);
    const above = scroll; const below = Math.max(0, rows.length - scroll - height);
    // The ends say how much more there is, on a row of their own, counting things rather than rows.
    const first = above ? 1 : 0; const last = below ? 1 : 0;
    const shown = rows.slice(scroll + first, scroll + height - last);
    const things = (hidden: readonly TabRow[]) => new Set(hidden.filter((row) => row.spans.length).map((row, index) => row.item ?? `row ${index}`)).size;
    const visible = new Set(shown.map((row) => row.item).filter(Boolean));
    const hiddenAbove = rows.slice(0, scroll + first).filter((row) => !row.item || !visible.has(row.item));
    const hiddenBelow = rows.slice(scroll + height - last).filter((row) => !row.item || !visible.has(row.item));
    let y = area.y + 1;
    if (first) screen.put(area.x, y++, `↑ ${things(hiddenAbove)} more`, faint);
    shown.forEach((row, offset) => {
      const index = scroll + first + offset;
      if (this.cursor === index) screen.fill({ x: area.x - 1, y, width: area.width + 2, height: 1 }, cursorBand);
      const right = row.right ? textWidth(row.right.text) : 0;
      let column = area.x;
      for (const span of row.spans) {
        const room = area.x + area.width - column - (right ? right + 1 : 0);
        if (room <= 0) break;
        column = screen.put(column, y, truncate(span.text, room), span.style);
      }
      if (row.right) {
        const at = area.x + area.width - right;
        screen.put(at, y, row.right.text, row.right.style);
        if (row.action) hits.push({ x: at, y, width: right, action: row.action });
      }
      y++;
    });
    if (last) screen.put(area.x, y, `↓ ${things(hiddenBelow)} more`, faint);
  }
}
