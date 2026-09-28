#!/usr/bin/env node
// Opt-in acceptance run on real Live: every change Kumi can make, each undone through Kumi's
// undo, on the Set you name; plus how long the reads a big Set depends on take. It changes the
// open Set and then puts it back, so run it on a disposable copy. No model and no sign-in.
//   npm run accept:live --workspace @kumi/app -- --set "Kumi Focus Demo"
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbletonIntegration, createProjectStore } from "@kumi/runtime";
import { findBridgeConfig } from "../dist/src/config.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--set");
const wanted = at >= 0 ? argv[at + 1]?.trim() : undefined;
if (!wanted) {
  process.stderr.write('Name the Set to change, as Live shows it: npm run accept:live --workspace @kumi/app -- --set "<Set name>"\nIt changes that Set and undoes every change, so use a disposable copy.\n');
  process.exit(2);
}
const bridgeConfig = findBridgeConfig(process.env);
if (!bridgeConfig) { process.stderr.write("The Ableton bridge isn't installed; run: npm run kumi -- doctor\n"); process.exit(2); }

const rows = [];
const say = (ok, ms, what) => { rows.push(ok); process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${ms === undefined ? "".padStart(8) : `${seconds(ms)}`.padStart(8)}  ${what}\n`); };
const seconds = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const records = new Map();
const signal = () => AbortSignal.timeout(120_000);
let stopping = false;
process.once("SIGINT", () => { stopping = true; process.stdout.write("\nStopping: undoing what was changed so far…\n"); });

// Catch-up runs against a throwaway folder, so ~/.kumi isn't touched; its first save is the Set's snapshot export.
const scratch = await mkdtemp(join(tmpdir(), "kumi-accept-"));
const store = createProjectStore(scratch);
let exported; let looked = 0;
const timedStore = { load: (path) => store.load(path), save: async (baseline) => { exported ??= { ms: performance.now() - looked, pages: baseline.pages.length, bytes: Buffer.byteLength(JSON.stringify(baseline.pages)) }; return store.save(baseline); } };
const integration = createAbletonIntegration({ bridgeConfig, projectStore: timedStore, onConnection: () => {}, onChange: (change) => records.set(change.id, change) });

let observation;
const tool = (name) => observation.tools.find((item) => item.name === name);
async function run(name, input) {
  const found = tool(name);
  if (!found) return { ok: false, ms: 0, error: "not offered for this Set" };
  const t0 = performance.now();
  try {
    const result = await found.execute(input, signal());
    let body; try { body = JSON.parse(result.text); } catch { body = undefined; }
    return { ok: !result.isError, ms: performance.now() - t0, body, error: result.isError ? result.text.replace(/\s+/g, " ").slice(0, 240) : undefined };
  } catch (error) { return { ok: false, ms: performance.now() - t0, error: String(error?.message ?? error).slice(0, 240) }; }
}
/** A read's payload: structured when the bridge sends it that way, otherwise its text. */
const contentOf = (body) => body?.mcp?.structuredContent ?? (() => { try { return JSON.parse(body?.mcp?.content?.[0]?.text ?? "null") ?? {}; } catch { return {}; } })();
/** Every row of one kind, page by page. */
async function all(kind, extra = {}) {
  const items = []; let cursor; let pages = 0; let ms = 0;
  do {
    const read = await run("live_discover", { kind, limit: 100, ...extra, ...(cursor ? { cursor } : {}) });
    ms += read.ms; pages++;
    if (!read.ok) return { items, pages, ms, error: read.error };
    const content = contentOf(read.body);
    items.push(...(content.items ?? []));
    cursor = content.nextCursor;
  } while (cursor && pages < 64);
  return { items, pages, ms };
}
async function state() {
  const set = await all("set", { fields: ["tempo"] });
  const tracks = await all("track", { fields: ["name"] });
  const scenes = await all("scene", { fields: ["name"] });
  const locators = await all("locator", { fields: ["name", "position"] });
  return { tempo: set.items[0]?.tempo, tracks: tracks.items.map((row) => row.name), scenes: scenes.items.length, locators: locators.items.map((row) => `${row.name}@${row.position}`), reads: { tracks } };
}

let exitCode = 1;
try {
  process.stdout.write("Reads\n");
  let t0 = performance.now();
  await integration.start(signal());
  say(true, performance.now() - t0, "connect to the bridge and Live");
  t0 = looked = performance.now();
  observation = await integration.observe(signal());
  const context = JSON.parse(observation.context);
  say(observation.tools.length > 0, performance.now() - t0, `first look at the Set: “${context.set?.name ?? "?"}”${context.liveVersion ? `, Live ${context.liveVersion}` : ""}, ${observation.tools.length} tools`);
  if (context.set?.name !== wanted) {
    process.stdout.write(`\nThe open Set is “${context.set?.name ?? "unknown"}”, not “${wanted}”; nothing was changed.\n`);
    exitCode = 2;
  } else {
    const before = await state();
    const trackRead = before.reads.tracks;
    say(!trackRead.error, trackRead.ms, `${before.tracks.length} tracks in ${trackRead.pages} ${trackRead.pages === 1 ? "page" : "pages"}${trackRead.error ? `: ${trackRead.error}` : ""}`);
    for (let waited = 0; !exported && waited < 60_000; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
    say(Boolean(exported), exported?.ms, exported ? `Set snapshot for catching up: ${exported.pages} ${exported.pages === 1 ? "page" : "pages"}, ${Math.round(exported.bytes / 1024)} KB (ready this long after the first look)` : "no Set snapshot for catching up within 60 s (an unsaved Set, or one too big for the bridge)");

    process.stdout.write("\nChanges\n");
    const change = async (name, input) => {
      if (stopping) return undefined;
      const outcome = await run(name, input);
      say(outcome.ok, outcome.ms, outcome.body?.changed ?? `${name}: ${outcome.error ?? "no title"}`);
      return outcome;
    };
    try {
      const target = before.reads.tracks.items[0];
      if (!target) say(false, undefined, "the Set has no track to change");
      else {
        await change("set_tempo", { tempo: before.tempo === 124 ? 125 : 124 });
        await change("set_mixer", { trackRef: target.ref, volume: 0.7, pan: -0.25 });
        await change("rename", { kind: "track", ref: target.ref, name: `${String(target.name).slice(0, 110)} (Kumi)` });
        await change("set_track_color", { ref: target.ref, colorIndex: 12 });
        await change("set_locators", { start: 4096, end: 4112, startName: "Kumi Start", endName: "Kumi End" });
        const added = await change("add_tracks_and_scenes", { tracks: [{ name: "Kumi Pad", kind: "midi" }], scenes: [] });
        const pad = added?.body?.live?.created?.find((item) => item.kind === "track");
        if (pad && !stopping) {
          await change("write_midi_clip", { trackRef: pad.ref, sceneIndex: 0, name: "Kumi Chord", length: 4, notes: [60, 64, 67].map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 96 })) });
          const found = await run("live_browser_search", { category: "instruments", query: "Drift", limit: 1 });
          const item = contentOf(found.body).items?.[0];
          const loaded = item ? await change("load_device", { itemId: item.id, trackRef: pad.ref }) : (say(false, found.ms, "Drift not found in the browser"), undefined);
          if (loaded?.ok && !stopping) {
            // A device brings its parameter tools; a new look retires earlier references, so find the pad again.
            observation = await integration.observe(signal());
            const padRow = (await all("track", { fields: ["name"] })).items.filter((row) => row.name === "Kumi Pad").at(-1);
            const device = padRow ? (await all("device", { parent: padRow.ref, fields: ["name"] })).items[0] : undefined;
            const parameters = device ? (await all("parameter", { parent: device.ref, fields: ["name", "value", "min", "max", "displayValue"] })).items : [];
            const knob = parameters.find((row) => row.name === "LP Freq" || row.name === "Filter Freq") ?? parameters.find((row) => row.max > row.min && row.name !== "Device On");
            if (knob) await change("set_device_parameter", { deviceRef: device.ref, parameterRef: knob.ref, value: knob.min + (knob.max - knob.min) * 0.3 });
            else say(false, undefined, "no Drift parameter to change");
          }
        }
      }
    } catch (error) { say(false, undefined, `stopped making changes: ${String(error?.message ?? error).slice(0, 200)}`); }

    // Whatever stopped the changes, what was changed goes back.
    process.stdout.write("\nUndo, newest first\n");
    for (const record of [...records.values()].reverse()) {
      if (record.state !== "applied") continue;
      const t1 = performance.now();
      try {
        const after = await integration.undo(record.id, signal());
        say(after.state === "undone", performance.now() - t1, `${after.state} · ${record.title}${after.note ? ` (${after.note})` : ""}`);
      } catch (error) { say(false, performance.now() - t1, `${record.title}: ${String(error?.message ?? error).slice(0, 200)}`); }
    }
    for (const record of records.values()) if (record.state === "unsure") say(false, undefined, `unsure, check Live: ${record.title}`);

    process.stdout.write("\n");
    try {
      observation = await integration.observe(signal());
      const after = await state();
      const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const restored = same(before.tempo, after.tempo) && same(before.tracks, after.tracks) && before.scenes === after.scenes && same(before.locators, after.locators);
      say(restored, undefined, restored ? `Set as it was: tempo ${after.tempo}, ${after.tracks.length} tracks, ${after.scenes} scenes, ${after.locators.length} locators`
        : `Set differs from before: ${JSON.stringify({ before: { ...before, reads: undefined }, after: { ...after, reads: undefined } }).slice(0, 600)}`);
    } catch (error) { say(false, undefined, `couldn't read the Set afterwards to check it: ${String(error?.message ?? error).slice(0, 200)}`); }
    const passed = rows.filter(Boolean).length;
    process.stdout.write(`\n${passed} of ${rows.length} passed${stopping ? " (stopped early)" : ""}.\n`);
    exitCode = passed === rows.length && !stopping ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(`accept-live: ${String(error?.message ?? error).slice(0, 300)}\n`);
} finally {
  await integration.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
