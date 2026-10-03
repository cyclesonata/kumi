import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createLibrary, KUMI } from "@kumi/runtime";
import { runLibrary } from "../src/library.js";

/** A short decaying tone as a 16-bit mono WAV. */
function tone(hz: number, seconds: number): Buffer {
  const frames = Math.round(44_100 * seconds); const data = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index++) data.writeInt16LE(Math.round(20_000 * Math.sin(2 * Math.PI * hz * index / 44_100) * Math.exp(-index / 44_100 / 0.1)), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "latin1"); header.write("fmt ", 12, "latin1"); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(44_100, 24); header.writeUInt32LE(88_200, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const put = (path: string, bytes: Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };

test("`kumi library` says what Kumi knows and where it looks; --rebuild learns it all again and says how it went", async () => {
  const home = mkdtempSync(join(tmpdir(), "kumi-library-command-"));
  const crate = join(home, "Crate");
  put(join(crate, "Kick Round.wav"), tone(55, 0.4));
  put(join(crate, "Snare Crack.wav"), tone(200, 0.2));
  put(join(crate, "Presets", "Bass.adv"), gzipSync(`<?xml version="1.0"?><Ableton><Operator Id="0"><Annotation Value="" /></Operator></Ableton>`));
  const env = { KUMI_LIBRARY_DIR: join(home, "library"), KUMI_SETTINGS_FILE: join(home, "settings.json"), KUMI_PROJECTS_DIR: join(home, "projects") };
  const make = () => createLibrary({ dir: env.KUMI_LIBRARY_DIR, folders: [crate], sources: { home, platform: "darwin", applications: join(home, "Applications") }, fork: false, workers: 0, findSets: false });
  let text = "";
  const out = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  const library = make();
  try {
    assert.equal(await runLibrary({ out, env, rebuild: false, library }), 0);
    assert.match(text, /Not learned yet\. Kumi learns it by itself in the background while it runs,/);
    assert.match(text, /Where Kumi looks\n {2}Crate +.*Crate/);
    text = "";
    assert.equal(await runLibrary({ out, env, rebuild: true, library }), 0);
    assert.match(text, /^Learning your library again, from the start\./);
    assert.match(text, /Learned 2 sounds, 1 preset and 0 Sets in \d+ seconds\./);
    assert.match(text, /Sounds {4}2\n {2}Presets {3}1\n {2}Sets {6}0\n {2}Learned {3}just now/);
    assert.match(text, new RegExp(`${KUMI} library --rebuild learns everything again\\.`));
  } finally { await library.close(); rmSync(home, { recursive: true, force: true }); }
});
