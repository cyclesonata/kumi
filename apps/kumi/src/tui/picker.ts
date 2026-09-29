/**
 * A list to choose from in a panel above the input box: models grouped by provider, effort
 * levels, providers to sign in to. Typing filters it; headings stay with what they head.
 */
export interface PickerItem {
  label: string;
  /** Beside the label, dimmer: a model's description, where a key comes from. */
  detail?: string;
  /** At the right edge: "current", "signed in", "sign in". */
  note?: string;
  noteTone?: "accent" | "faint" | "warn";
  /** A heading groups the items under it and can't be chosen. */
  heading?: boolean;
  /** Shown but not choosable (a list still loading). */
  inert?: boolean;
  value?: string;
}

export class Picker {
  filter = "";
  private index = 0;
  constructor(readonly title: string, private items: PickerItem[], readonly options: { filterable?: boolean; hint?: string } = {}) {
    this.index = Math.max(0, this.choosable().findIndex((item) => item.note === "current"));
  }

  /** Swap the items (a list finished loading), keeping the chosen one when it's still there. */
  setItems(items: PickerItem[]): void {
    const chosen = this.selected()?.value;
    this.items = items;
    const at = chosen === undefined ? -1 : this.choosable().findIndex((item) => item.value === chosen);
    this.index = at >= 0 ? at : Math.min(this.index, Math.max(0, this.choosable().length - 1));
  }

  /** What's shown: every item matching the filter, under its heading. */
  visible(): PickerItem[] {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.items;
    const shown: PickerItem[] = [];
    let heading: PickerItem | undefined;
    for (const item of this.items) {
      if (item.heading) { heading = item; continue; }
      const haystack = `${heading?.label ?? ""} ${item.label} ${item.detail ?? ""} ${item.value ?? ""}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      if (heading && shown.at(-1) !== heading && !shown.includes(heading)) shown.push(heading);
      shown.push(item);
    }
    return shown;
  }

  private choosable(): PickerItem[] { return this.visible().filter((item) => !item.heading && !item.inert); }

  selected(): PickerItem | undefined { return this.choosable()[this.index]; }

  /** Put the selection on the item with `value`, when it's there. */
  select(value: string | undefined): void {
    const at = value === undefined ? -1 : this.choosable().findIndex((item) => item.value === value);
    if (at >= 0) this.index = at;
  }

  move(delta: number): void {
    const count = this.choosable().length;
    if (count) this.index = (this.index + delta + count) % count;
  }

  type(text: string): void {
    if (!this.options.filterable) return;
    this.filter = (this.filter + text.replace(/[\r\n\t]/g, "")).slice(0, 40);
    this.index = 0;
  }

  erase(): void {
    this.filter = this.filter.slice(0, -1);
    this.index = 0;
  }
}
