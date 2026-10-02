import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginAdapter } from "../src/plugins/adapter.js";
import { ADAPTERS } from "../src/plugins/adapters/index.js";
import { adapterFor } from "../src/plugins/registry.js";

/** The names Live shows for each plug-in's device. */
const LIVE_NAMES: Record<string, string[]> = {
  serum2: ["Serum 2", "Serum2"],
  vital: ["Vital"],
  ozone12: ["Ozone 12", "Ozone 12 Advanced", "iZotope Ozone 12", "Ozone 12 Maximizer"],
  proq4: ["FabFilter Pro-Q 4", "Pro-Q 4"],
  prol2: ["FabFilter Pro-L 2", "Pro-L 2"],
  saturn2: ["FabFilter Saturn 2", "Saturn 2"],
  ott: ["OTT"],
  supermassive: ["ValhallaSupermassive", "Valhalla Supermassive"],
  decapitator: ["Decapitator"],
  pigments: ["Pigments", "Pigments 6"],
};
/** Other versions, and devices with names close to these, that no adapter is for. */
const NOT_THESE = ["Serum", "SerumFX", "Serum 2 FX", "Ozone 11", "Ozone Imager", "Pro-Q 3", "Pro-L", "Saturn", "Vitalizer", "Operator", "EQ Eight", "Multiband Dynamics"];

/** Parameter names in the forms each adapter's patterns are written for (each file says how sure those forms are). */
const SAMPLE_NAMES: Record<string, string[]> = {
  serum2: ["A Vol", "Osc B Level", "A Pan", "A Octave", "A CoarsePit", "A Unison", "A UniDet", "B Uni Detune", "A UniBlend", "A WTPos", "Osc C WT Pos", "A Warp", "B Warp 2",
    "A RandPhase", "Sub Osc Level", "SubOscShape", "Noise Level", "Noise Pitch", "Fil Cutoff", "Filter 2 Cutoff", "Fil Reso", "Fil Driv", "Fil Var", "Fil Mix", "Fil Pan",
    "Env1 Atk", "Env 1 Release", "Env2 Dec", "LFO1 Rate", "LFO 10 Rate", "Macro 8", "MasterVol", "Porta Time", "Hyp Wet", "Dly Wet", "Main Reverb Mix", "Dist Drv",
    "Dly Feed", "Dly TimL", "Dly BPM_Sync", "VerbSize", "VerbLoCt", "Cmp Thr", "CmpGain", "Compressor Ratio"],
  vital: ["Oscillator 1 Level", "Osc 2 Pan", "Oscillator 1 Transpose", "Oscillator 1 Wave Frame", "Oscillator 1 Unison Voices", "Oscillator 2 Stereo Spread",
    "Oscillator 1 Spectral Morph Amount", "Oscillator 1 Distortion Amount", "Oscillator 1 Phase Randomization", "Sample Level", "Filter 1 Cutoff", "Filter FX Cutoff",
    "Filter 2 Resonance", "Filter 1 Drive", "Filter 1 Blend", "Filter 1 Key Track", "Filter 1 Formant X", "Envelope 1 Attack", "Envelope 2 Decay", "Envelope 2 Decay Power",
    "LFO 1 Frequency", "LFO 1 Tempo", "Macro 1", "Modulation 1 Amount", "Chorus Switch", "Reverb Mix", "Distortion Drive", "Compressor Low Gain", "Delay Feedback",
    "Reverb Decay Time", "Volume", "Polyphony", "Portamento Time"],
  ozone12: ["Maximizer: Threshold", "Maximizer: Ceiling", "Maximizer: Character", "Maximizer: IRC Mode", "Maximizer: Transient Emphasis", "Maximizer: True Peak",
    "Equalizer 1: Band 1 Gain", "EQ Band 2 Frequency", "Equalizer 1: Band 1 Q", "Dynamic EQ: Band 1 Threshold", "Dynamics: Band 1 Threshold", "Dynamics: Crossover 1",
    "Imager: Band 1 Width", "Exciter: Band 1 Amount", "Low End Focus: Contrast", "Stabilizer: Amount", "Master Rebalance: Vocal Gain", "Unlimiter: Amount", "Global: Output Gain"],
  proq4: ["Band 1 Used", "Band 1 Enabled", "Band 1 Frequency", "Band 12 Gain", "Band 1 Q", "Band 1 Shape", "Band 1 Slope", "Band 1 Stereo Placement", "Band 1 Dynamics Enabled",
    "Band 1 Dynamic Range", "Band 1 Threshold", "Band 1 Attack", "Band 1 Side Chain", "Band 1 Spectral Enabled", "Processing Mode", "Character", "Output Level", "Gain Scale"],
  prol2: ["Gain", "Output Level", "Style", "Lookahead", "Release", "Channel Link Transients", "True Peak Limiting", "Oversampling", "Unity Gain", "Dithering", "DC Offset Filter"],
  saturn2: ["Band 1 Style", "Band 1 Drive", "Band 1 Dynamics", "Band 1 Tone", "Band 1 Feedback Frequency", "Band 1 Mix", "Band 1 Mute", "Crossover 1 Frequency", "Mix",
    "Output Level", "High Quality", "XLFO 1 Rate"],
  ott: ["Depth", "Time", "In Gain", "Out Gain", "Upwd %", "Downwd %", "H Gain", "L Gain"],
  supermassive: ["Mix", "Delay_Ms", "Delay_Note", "Warp", "Feedback", "Density", "Width", "LowCut", "HighCut", "ModRate", "ModDepth", "Mode"],
  decapitator: ["Drive", "Style", "Low Cut", "HighCut", "Thump", "Steep", "Tone", "Punish", "Mix", "Output", "Auto"],
  pigments: ["Engine 1 Volume", "Engine 1 Coarse Tune", "Engine 1 Wavetable Position", "Engine 2 Unison Detune", "Engine 1 Filter Mix", "Filter 1 Cutoff", "Filter 2 Resonance",
    "Filter 1 Drive", "Filter Routing", "VCA Env Release", "Env 2 Decay", "LFO 1 Rate", "Macro 1", "Aux Send", "Master Volume"],
};

/** What the model reads of an adapter. */
const reading = (adapter: PluginAdapter) => [adapter.name, adapter.vendor, adapter.overview, adapter.beyond,
  ...adapter.sections.flatMap((section) => [section.name, section.about, ...section.parameters.flatMap((hint) => [hint.role, hint.about])]),
  ...adapter.recipes.flatMap((recipe) => [recipe.name, recipe.how])].join("\n");
const patterns = (adapter: PluginAdapter) => [adapter.match, ...adapter.sections.flatMap((section) => section.parameters.map((hint) => hint.names))];

test("ten adapters in their order, each with its own id", () => {
  assert.deepEqual(ADAPTERS.map((adapter) => adapter.id), Object.keys(LIVE_NAMES));
  assert.equal(new Set(ADAPTERS.map((adapter) => adapter.id)).size, ADAPTERS.length);
});

test("each adapter is picked by its plug-in's names in Live, and by no other's", () => {
  for (const [id, names] of Object.entries(LIVE_NAMES)) {
    for (const name of names) {
      assert.deepEqual(ADAPTERS.filter((adapter) => adapter.match.test(name)).map((adapter) => adapter.id), [id], name);
      assert.equal(adapterFor(name)?.id, id, name);
    }
  }
  for (const name of NOT_THESE) assert.equal(adapterFor(name), undefined, name);
});

test("every section has parameters, each described, and no pattern keeps state between names", () => {
  for (const adapter of ADAPTERS) {
    assert.ok(adapter.sections.length > 0 && adapter.overview && adapter.beyond, adapter.id);
    for (const section of adapter.sections) {
      assert.ok(section.parameters.length > 0, `${adapter.id}: ${section.name}`);
      for (const hint of section.parameters) assert.ok(hint.role && hint.about, `${adapter.id}: ${hint.role}`);
    }
    for (const pattern of patterns(adapter)) {
      assert.ok(!pattern.global && !pattern.sticky, `${adapter.id}: ${pattern}`);
      assert.ok(!pattern.test(""), `${adapter.id}: ${pattern} takes any name`);
    }
  }
});

test("every hint takes names in the forms it's written for, and each of those names lands under one hint", () => {
  for (const adapter of ADAPTERS) {
    const names = SAMPLE_NAMES[adapter.id]!;
    const hints = adapter.sections.flatMap((section) => section.parameters);
    for (const hint of hints) assert.ok(names.some((name) => hint.names.test(name)), `${adapter.id}: ${hint.role} takes none of its sample names`);
    for (const name of names) assert.equal(hints.filter((hint) => hint.names.test(name)).length, 1, `${adapter.id}: ${name}`);
  }
  const eq = (role: string) => ADAPTERS.find((adapter) => adapter.id === "ozone12")!.sections.flatMap((section) => section.parameters).find((hint) => hint.role === role)!.names;
  for (const name of ["Dynamic EQ: Band 1 Gain", "Match EQ: Band 1 Gain", "Stem EQ: Band 1 Gain"]) assert.ok(!eq("eq gain").test(name), name);
});

test("each adapter reads in well under 8 KB, with 4–8 recipes for a synth and 3–6 for an effect, and folders under the home folder", () => {
  for (const adapter of ADAPTERS) {
    assert.ok(Buffer.byteLength(reading(adapter)) < 7 * 1024, `${adapter.id}: ${Buffer.byteLength(reading(adapter))} bytes`);
    const [least, most] = adapter.kind === "instrument" ? [4, 8] : [3, 6];
    assert.ok(adapter.recipes.length >= least && adapter.recipes.length <= most, `${adapter.id}: ${adapter.recipes.length} recipes`);
    for (const paths of [adapter.folders?.presets, adapter.folders?.wavetables]) {
      for (const path of Object.values(paths ?? {})) assert.match(path, /^~\/[^\\]+$/, `${adapter.id}: ${path}`);
    }
  }
});
