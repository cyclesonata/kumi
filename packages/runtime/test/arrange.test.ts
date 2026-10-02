import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { compile, type Material } from "../src/integrations/ableton/arrange.js";
import { arranged, signal, tool, type FixtureTrack } from "./fixtures/arrangement-bridge.js";

// A loop in scene 1, the drop's parts in scene 2, a fill and a riser in scene 3; an empty fourth scene.
const SET: FixtureTrack[] = [
  { name: "Drums", clips: { 0: { name: "Beat A", beats: 16 }, 1: { name: "Beat B", beats: 16 }, 2: { name: "Drum Fill", beats: 4 } } },
  { name: "Bass", clips: { 0: { name: "Sub", beats: 16 }, 1: { name: "Sub B", beats: 16 } } },
  { name: "Pad", audio: true, clips: { 0: { name: "Pad", beats: 32 } } },
  { name: "Lead", clips: { 1: { name: "Hook", beats: 16 } } },
  { name: "FX", audio: true, clips: { 2: { name: "Riser", beats: 8 } } },
];
const FORM = [
  { name: "Intro", bars: 8, tracks: ["Pad", "Drums"] },
  { name: "Build", bars: 8, tracks: ["Pad", "Drums", "Bass"], gap: { beats: 4, tracks: ["Drums"] }, riser: { track: "FX", scene: 2 } },
  { name: "Drop", bars: 16, scene: 1, fill: [{ track: "Drums", scene: 2 }] },
  { name: "Outro", bars: 8, tracks: ["Pad"] },
];

test("without sections, arrange changes nothing and gives the material: each scene's clips by track, with their lengths", async () => {
  const b = await arranged({ tracks: SET, scenes: 4 });
  try {
    const result = await tool(b.tools, "arrange").execute({}, signal());
    assert.equal(result.isError ?? false, false, result.text);
    const material = (JSON.parse(result.text) as { material: JsonObject }).material;
    assert.deepEqual(material.scenes, [
      { scene: 0, name: "Scene 1", clips: ["Drums: “Beat A”, 4 bars", "Bass: “Sub”, 4 bars", "Pad: “Pad”, 8 bars, audio"] },
      { scene: 1, name: "Scene 2", clips: ["Drums: “Beat B”, 4 bars", "Bass: “Sub B”, 4 bars", "Lead: “Hook”, 4 bars"] },
      { scene: 2, name: "Scene 3", clips: ["Drums: “Drum Fill”, 1 bar", "FX: “Riser”, 2 bars, audio"] }]);
    assert.deepEqual(material.arrangement, { empty: true });
    assert.equal(b.requests.some((request) => request.name.endsWith("_apply")), false, "nothing changed");
  } finally { await b.integration.close(); }
});

test("a form becomes the arrangement: loops repeated through each section, a gap, a fill, a riser, locators, the playhead at the start", async () => {
  const b = await arranged({ tracks: SET, scenes: 4 });
  try {
    const result = await tool(b.tools, "arrange").execute({ sections: FORM, scene: 0, final: true }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    assert.deepEqual(b.arrangement(), {
      // The drums stop a bar before the drop, and the drop's last bar is the fill: a loop's first three bars before each.
      Drums: ["Beat A 1–5", "Beat A 5–9", "Beat A 9–13", "Beat A 13–16", "Beat B 17–21", "Beat B 21–25", "Beat B 25–29", "Beat B 29–32", "Drum Fill 32–33"],
      Bass: ["Sub 9–13", "Sub 13–17", "Sub B 17–21", "Sub B 21–25", "Sub B 25–29", "Sub B 29–33"],
      Pad: ["Pad 1–9", "Pad 9–17", "Pad 33–41"],
      Lead: ["Hook 17–21", "Hook 21–25", "Hook 25–29", "Hook 29–33"],
      // The riser ends where the build does.
      FX: ["Riser 15–17"],
    });
    assert.deepEqual(b.locators(), ["Intro@1", "Build@9", "Drop@17", "Outro@33"]);
    assert.equal(b.state.playhead, 0, "the playhead is at the start");
    // The Session is as it was: the shortened copies a part came from are gone.
    assert.deepEqual(b.session().map((slots) => slots.filter(Boolean)), [["Beat A:16", "Beat B:16", "Drum Fill:4"], ["Sub:16", "Sub B:16"], ["Pad:32"], ["Hook:16"], ["Riser:8"]]);
    assert.equal(b.scenes().length, 4, "an empty slot held the working copy: no scene was added");
    // One line in HISTORY for the whole of it, and Kumi says what it built.
    assert.deepEqual(b.records.map((record) => [record.title, record.state]), [["Arrangement · 4 sections, bars 1–40", "applied"]]);
    assert.match(result.reply ?? "", /^Arranged 40 bars from bar 1 \(1:17 at 124 BPM\):\n- Intro, bars 1–8: Pad, Drums\n- Build, bars 9–16: Pad, Drums, Bass; Drums out for the last bar; FX rises into what follows\n- Drop, bars 17–32: everything; Drums fill at the end\n- Outro, bars 33–40: Pad\n/);
    assert.match(result.reply ?? "", /Locators mark the sections, and the playhead is at bar 1\. Undo in HISTORY takes it all back \(or one Cmd-Z in Live\)\./);
    // NOW follows it section by section.
    assert.ok(["Arranging · Intro, bar 1", "Arranging · Build, bar 9", "Arranging · Drop, bar 17", "Arranging · naming the sections"].every((title) => b.actions.includes(title)), b.actions.join(" | "));
  } finally { await b.integration.close(); }
});

test("the arrangement is one Cmd-Z in Live and one undo in HISTORY, which takes every part of it back", async () => {
  const b = await arranged({ tracks: SET, scenes: 4 });
  try {
    await tool(b.tools, "arrange").execute({ sections: FORM, scene: 0 }, signal());
    const changes = b.requests.map((request) => request.name).filter((name) => /^live_undo_step_|_apply$/.test(name));
    assert.equal(changes[0], "live_undo_step_begin"); assert.equal(changes.at(-1), "live_undo_step_end");
    assert.equal(changes.filter((name) => /^live_undo_step_/.test(name)).length, 2, "one step around all of it");
    // The model sees one change of Kumi's, not dozens.
    const next = await b.integration.observe(signal());
    const listed = (JSON.parse(next.context) as { kumiChanges: JsonObject[] }).kumiChanges;
    assert.deepEqual(listed.map((item) => [item.what, item.state]), [["Arrangement · 4 sections, bars 1–40", "applied"]]);
    const undone = await b.integration.undo!(String(listed[0]!.change), signal());
    assert.equal(undone.state, "undone");
    assert.deepEqual(Object.values(b.arrangement()).flat(), [], "every clip it placed is gone");
    assert.deepEqual(b.locators(), []);
    assert.equal(b.state.playhead, 0);
    // HISTORY's one line changed to undone; none of the parts showed up as lines of their own.
    assert.deepEqual(b.records.map((record) => [record.title, record.state]), [["Arrangement · 4 sections, bars 1–40", "applied"], ["Arrangement · 4 sections, bars 1–40", "undone"]]);
    assert.equal(new Set(b.records.map((record) => record.id)).size, 1);
  } finally { await b.integration.close(); }
});

test("a part needs an empty slot on its track: with none, Kumi adds a scene for its working copy and takes it away again", async () => {
  const b = await arranged({ tracks: SET, scenes: 3 });
  try {
    const result = await tool(b.tools, "arrange").execute({ sections: FORM, scene: 0 }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    assert.deepEqual(b.arrangement().Drums, ["Beat A 1–5", "Beat A 5–9", "Beat A 9–13", "Beat A 13–16", "Beat B 17–21", "Beat B 21–25", "Beat B 25–29", "Beat B 29–32", "Drum Fill 32–33"]);
    assert.deepEqual(b.scenes(), ["Scene 1", "Scene 2", "Scene 3"]);
    assert.ok(b.requests.some((request) => request.name === "live_session_structure_preview"), "a scene was added for the parts");
  } finally { await b.integration.close(); }
});

test("it starts after what's in the Arrangement already; asked to start on top of it, it refuses before changing anything", async () => {
  const b = await arranged({ tracks: [{ ...SET[0]!, arrangement: [{ start: 0, end: 32 }] }, ...SET.slice(1)], scenes: 4 });
  try {
    const refused = await tool(b.tools, "arrange").execute({ sections: FORM, scene: 0, start_bar: 1 }, signal());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^Drums already has a clip in the Arrangement at bar 1, where this arrangement would go: start it after what's there \(start_bar 9\)/);
    assert.equal(b.requests.some((request) => request.name.endsWith("_preview")), false);
    const result = await tool(b.tools, "arrange").execute({ sections: FORM.slice(0, 1), scene: 0 }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    assert.deepEqual(b.arrangement().Drums, ["Earlier 1–9", "Beat A 9–13", "Beat A 13–17"]);
    assert.match(JSON.parse(result.text).arranged.from, /^bar 9$/);
  } finally { await b.integration.close(); }
});

test("while Live plays, the clips go in but the locators and the playhead wait, and Kumi says so", async () => {
  const b = await arranged({ tracks: SET, scenes: 4, playing: true });
  try {
    const result = await tool(b.tools, "arrange").execute({ sections: FORM, scene: 0 }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    assert.equal(b.arrangement().Lead!.length, 4);
    assert.deepEqual(b.locators(), []);
    assert.equal(b.requests.some((request) => request.name === "live_arrangement_section_preview" || request.name === "live_transport_preview"), false);
    assert.match(JSON.stringify(JSON.parse(result.text).notes), /Live was playing, so the sections aren't marked with locators/);
  } finally { await b.integration.close(); }
});

test("names are made new: two drops are Drop and Drop 2, and a locator name already in the Set isn't taken again", async () => {
  const b = await arranged({ tracks: SET, scenes: 4 });
  try {
    const result = await tool(b.tools, "arrange").execute({ sections: [{ name: "Drop", bars: 4 }, { name: "Break", bars: 4, tracks: ["Pad"] }, { name: "Drop", bars: 4 }], scene: 1 }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    // An odd count gets an End, since Live's locators come in pairs here.
    assert.deepEqual(b.locators(), ["Drop@1", "Break@5", "Drop 2@9", "End@13"]);
    assert.deepEqual(JSON.parse(result.text).arranged.sections, ["Drop, bars 1–4: everything", "Break, bars 5–8: Pad", "Drop 2, bars 9–12: everything"]);
  } finally { await b.integration.close(); }
  const marked = await arranged({ tracks: SET, scenes: 4, locators: [{ name: "Drop", position: 400 }, { name: "Verse", position: 0 }] });
  try {
    const result = await tool(marked.tools, "arrange").execute({ sections: [{ name: "Drop", bars: 4 }, { name: "Drop", bars: 4 }, { name: "Break", bars: 4, tracks: ["Pad"] }], scene: 1, start_bar: 1 }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    // "Drop" is taken; bar 1 is marked already, so that section keeps the locator it has.
    assert.deepEqual(marked.locators(), ["Verse@1", "Drop 3@5", "Break@9", "Drop@101"]);
    assert.match(JSON.stringify(JSON.parse(result.text).notes), /Locators already mark one of the sections' starts/);
  } finally { await marked.integration.close(); }
});

test("an audio loop that isn't warped can't be shortened: its part is left empty and said; Live refusing a copy stops it, keeping what was made", async () => {
  const b = await arranged({ tracks: [{ name: "Loop", audio: true, clips: { 0: { name: "Break", beats: 16, warped: false } } }, { name: "Keys", clips: { 0: { name: "Chords", beats: 16 } } }], scenes: 2 });
  try {
    const result = await tool(b.tools, "arrange").execute({ sections: [{ name: "A", bars: 6 }] }, signal());
    assert.equal(result.isError ?? false, false, result.text);
    assert.deepEqual(b.arrangement(), { Loop: ["Break 1–5"], Keys: ["Chords 1–5", "Chords 5–7"] });
    assert.match(JSON.stringify(JSON.parse(result.text).notes), /Loop's clip \(16 beats\) doesn't fit A's end evenly and Live can't shorten this audio clip \(it isn't warped\), so its last 8 beats are left empty/);
  } finally { await b.integration.close(); }
  let copies = 0;
  const refusing = await arranged({ tracks: SET, scenes: 4, refuse: (name, args) => name === "live_clip_duplicate_preview" && args.arrangementPosition !== undefined && ++copies === 3 ? "Live refused it" : undefined });
  try {
    const result = await tool(refusing.tools, "arrange").execute({ sections: FORM, scene: 0 }, signal());
    assert.equal(result.isError, true);
    const reply = JSON.parse(result.text) as JsonObject;
    assert.match(String(reply.stopped), /Live refused it/); assert.deepEqual((reply.made as JsonObject).clips, 2);
    assert.deepEqual(refusing.records.map((record) => [record.title, record.state]), [["Arrangement, stopped in Intro · 2 clips from bar 1", "applied"]]);
    assert.equal(refusing.state.steps.closed, 1, "Live's undo step is closed");
  } finally { await refusing.integration.close(); }
});

test("the form's checks come before any change: a missing track, a track named twice, a riser on a track that plays", () => {
  const material: Material = { beatsPerBar: 4, tempo: 120, scenes: [{ index: 0, name: "" }], locators: [], end: 0, playing: false, sessionPlaying: false, unread: 0,
    tracks: [{ ref: "track:1", name: "Drums", busy: [], empty: [], clips: [{ ref: "clip:1", name: "Beat", beats: 16, loopStart: 0, audio: false, scene: 0, shortens: true }] },
      { ref: "track:2", name: "Drums", busy: [], empty: [], clips: [] }] };
  const can = { midi: true, audio: true };
  assert.match(String(compile(material, { sections: [{ name: "A", bars: 4, tracks: [{ track: "Snare" }], fill: [] }], final: false }, can)), /^A: There's no track called "Snare"/);
  assert.match(String(compile(material, { sections: [{ name: "A", bars: 4, tracks: [{ track: "Drums" }], fill: [] }], final: false }, can)), /Several tracks are called "Drums": name each by its ref \(track:1, track:2\)/);
  assert.match(String(compile(material, { sections: [{ name: "A", bars: 4, tracks: [{ track: "track:1" }, { track: "track:1" }], fill: [] }], final: false }, can)), /Drums is named twice/);
  assert.match(String(compile(material, { sections: [{ name: "A", bars: 8, fill: [], riser: { track: "track:1", scene: 0 } }], final: false }, can)), /Drums would play two clips at once at bar 5 \(its loop and its riser\)/);
  // Shortening offered or not: a 3-bar section of a 4-bar loop is a part, or nothing.
  const part = compile(material, { sections: [{ name: "A", bars: 3, fill: [] }], final: false }, can);
  assert.ok(typeof part !== "string"); assert.deepEqual(part.placements.map((item) => [item.at, item.beats]), [[0, 12]]);
  const none = compile(material, { sections: [{ name: "A", bars: 3, fill: [] }], final: false }, { midi: false, audio: false });
  assert.ok(typeof none !== "string"); assert.deepEqual(none.placements, []);
});
