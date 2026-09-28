import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { drumSamplerPreset, findDrumSamplerTemplate } from "../src/drum-sampler-preset.js";
import { DRUM_SAMPLER_TEMPLATE as TEMPLATE, liveResources } from "./helpers/drum-sampler.js";

test("a Drum Sampler preset carries the sample, from Live's own default preset", () => {
  const folder = liveResources();
  const template = findDrumSamplerTemplate([join(folder, "missing"), folder])!;
  assert.equal(template.builtinDevicePath, join(folder, "Builtin", "Devices", "Instruments", "Drum Sampler"), "the first Live that has one");
  const path = '/staged/Kick "Big" & Sub $& 808.wav';
  const xml = gunzipSync(drumSamplerPreset(template, { path, size: 1234.5, modifiedSeconds: 1700000000.7 })).toString("utf8");
  assert.match(xml, /<SampleRef Id="0">/);
  assert.ok(xml.includes('<Path Value="/staged/Kick &quot;Big&quot; &amp; Sub $&amp; 808.wav" />'), "the path is escaped, and a $ stays a $");
  assert.match(xml, /<OriginalFileSize Value="1234" \/>/); assert.match(xml, /<LastModDate Value="1700000000" \/>/);
  assert.match(xml, /<AbletonDefaultPresetRef Id="0">[\s\S]*<DeviceId Name="DrumCell" \/>/, "it says it came from the built-in Drum Sampler");
  assert.doesNotMatch(xml, /FilePresetRef/, "not from the default preset's file");
  assert.match(xml, /<Voice_Gain Value="1" \/>/, "the rest as Live wrote it");
  assert.throws(() => drumSamplerPreset({ ...template, xml: TEMPLATE.replace("<Value />", "<Value><SampleRef /></Value>") }, { path, size: 1, modifiedSeconds: 1 }), /shape the bridge doesn't know/);
  assert.equal(findDrumSamplerTemplate([join(folder, "missing")]), undefined);
});
