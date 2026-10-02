/**
 * Max for Live's device file (.amxd): "ampf", the device's type, a "meta" chunk and a "ptch" chunk
 * holding the Max patcher as JSON (NUL-terminated), as Live's own device templates are laid out.
 */

export type DeviceType = "midi_effect" | "audio_effect" | "instrument";

/** The four-letter type code Live reads; the same letters, as a number, name it in the patcher's project. */
const CODES: Record<DeviceType, string> = { midi_effect: "mmmm", audio_effect: "aaaa", instrument: "iiii" };

const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };

/** A device file from its patcher. */
export function encodeAmxd(type: DeviceType, patcher: object): Buffer {
  const code = Buffer.from(CODES[type], "latin1");
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(patcher, null, "\t")}\n`, "utf8"), Buffer.from([0])]);
  return Buffer.concat([Buffer.from("ampf", "latin1"), u32(code.length), code, Buffer.from("meta", "latin1"), u32(4), u32(0), Buffer.from("ptch", "latin1"), u32(body.length), body]);
}

/** A device file's type and patcher; undefined when it isn't one. */
export function decodeAmxd(bytes: Buffer): { type: DeviceType; patcher: { patcher: Record<string, unknown> } } | undefined {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "ampf") return undefined;
  const length = bytes.readUInt32LE(4);
  const code = bytes.toString("latin1", 8, 8 + length);
  const type = (Object.keys(CODES) as DeviceType[]).find((key) => CODES[key] === code);
  let at = 8 + length;
  while (type && at + 8 <= bytes.length) {
    const tag = bytes.toString("latin1", at, at + 4); const size = bytes.readUInt32LE(at + 4);
    if (tag === "ptch") {
      try { return { type, patcher: JSON.parse(bytes.toString("utf8", at + 8, at + 8 + size).replace(/\0+$/, "")) as { patcher: Record<string, unknown> } }; }
      catch { return undefined; }
    }
    at += 8 + size;
  }
  return undefined;
}

/** Live shows a device 169 pixels tall: room for three rows of dials. */
const FACE_ROWS = 3;

/**
 * Where each of a device's `count` controls sits on its face: in one row up to eight, as Live's own
 * devices have them, then in up to three rows, as wide as it takes.
 */
export function faceLayout(count: number): { columns: number; at(index: number): { x: number; y: number } } {
  const columns = count <= 8 ? Math.max(1, count) : Math.ceil(count / FACE_ROWS);
  return { columns, at: (index) => ({ x: 8.0 + (index % columns) * 52.0, y: Math.floor(index / columns) * 52.0 }) };
}

export interface Box { box: Record<string, unknown> }
export interface Line { patchline: { source: [string, number]; destination: [string, number] } }

/**
 * A device's top-level patcher, as Live's templates have it: opened in presentation (the device's
 * face), `width` pixels wide, with `description` as its info text.
 */
export function devicePatcher(type: DeviceType, options: { title: string; description: string; width: number; boxes: Box[]; lines: Line[] }): object {
  const amxdtype = Buffer.from(CODES[type], "latin1").readUInt32BE(0);
  return {
    patcher: {
      fileversion: 1,
      appversion: { major: 9, minor: 1, revision: 5, architecture: "x64", modernui: 1 },
      classnamespace: "box",
      rect: [100.0, 100.0, 900.0, 600.0],
      openrect: [0.0, 0.0, options.width, 169.0],
      bglocked: 0,
      openinpresentation: 1,
      default_fontsize: 10.0,
      default_fontface: 0,
      default_fontname: "Arial Bold",
      gridonopen: 1,
      gridsize: [8.0, 8.0],
      gridsnaponopen: 1,
      objectsnaponopen: 1,
      statusbarvisible: 2,
      toolbarvisible: 1,
      boxanimatetime: 500,
      enablehscroll: 1,
      enablevscroll: 1,
      devicewidth: options.width,
      description: options.description,
      digest: "",
      tags: "Kumi",
      style: "",
      subpatcher_template: "",
      title: options.title,
      boxes: options.boxes,
      lines: options.lines,
      dependency_cache: [],
      latency: 0,
      project: {
        version: 1, creationdate: 3590052786, modificationdate: 3590052786, viewrect: [0.0, 0.0, 300.0, 500.0], autoorganize: 1, hideprojectwindow: 1,
        showdependencies: 1, autolocalize: 0, contents: { patchers: {} }, layout: {}, searchpath: {}, detailsvisible: 0, amxdtype, readonly: 0, devpathtype: 0, devpath: ".",
        sortmode: 0, viewmode: 0,
      },
      autosave: 0,
    },
  };
}
