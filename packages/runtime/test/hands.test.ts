import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hands, MenuItem } from "../src/hands/index.js";
import { COMMANDS, findItem, shortcut } from "../src/integrations/ableton/live-command.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

// Live 12.4.15b5's own titles, as Accessibility reads them.
const LIVE_MENUS: MenuItem[] = [
  { path: ["File", "Save Live Set"], enabled: true, key: "S", modifiers: 0 },
  { path: ["File", "Export Audio/Video…"], enabled: true, key: "R", modifiers: 1 },
  { path: ["Edit", "Group"], enabled: true, key: "G", modifiers: 0 },
  { path: ["Edit", "Ungroup"], enabled: true, key: "G", modifiers: 1 },
  { path: ["Edit", "Freeze Track"], enabled: false },
  { path: ["Create", "Convert Melody to New MIDI Track"], enabled: true },
  { path: ["Create", "Bounce to New Track"], enabled: true },
];

/** Hands that press nothing real: they say what they were asked, and Live answers as the test says. */
function fakeHands(options: { trusted?: boolean; onMenu?: (path: readonly string[]) => { ok: boolean; error?: string } | void; dialog?: { open: boolean; title?: string; buttons?: string[] } } = {}) {
  const pressed: string[][] = []; const keys: string[][] = []; const answered: string[] = []; const prompts: boolean[] = [];
  let dialog = options.dialog ?? { open: false };
  const hands: Hands = {
    async trusted(prompt = false) { prompts.push(prompt); return options.trusted ?? true; },
    async menus() { return LIVE_MENUS; },
    async menu(path) { pressed.push([...path]); const reply = options.onMenu?.(path); return reply ?? { ok: true }; },
    async keys(combos) { keys.push([...combos]); return { ok: true }; },
    async dialog() { return dialog; },
    async answer(button) { answered.push(button); const ok = dialog.open && (dialog.buttons ?? []).includes(button); if (ok) dialog = { open: false }; return { ok }; },
    async windows() { return []; },
    close() {},
  };
  return { open: async () => hands, pressed, keys, answered, prompts, setDialog: (value: typeof dialog) => { dialog = value; } };
}

test("a command's menu item is found by its title wherever Live keeps it, and Live's own shortcut is said", () => {
  assert.deepEqual(findItem(LIVE_MENUS, COMMANDS.group_tracks!.titles)?.path, ["Edit", "Group"]);
  assert.deepEqual(findItem(LIVE_MENUS, COMMANDS.ungroup_tracks!.titles)?.path, ["Edit", "Ungroup"]);
  assert.deepEqual(findItem(LIVE_MENUS, COMMANDS.export_audio!.titles)?.path, ["File", "Export Audio/Video…"], "an ellipsis doesn't stop a match");
  assert.deepEqual(findItem(LIVE_MENUS, COMMANDS.bounce_to_new_track!.titles)?.path, ["Create", "Bounce to New Track"]);
  assert.equal(findItem(LIVE_MENUS, COMMANDS.separate_stems!.titles), undefined, "not in this Live");
  assert.equal(shortcut(LIVE_MENUS[2]!), "⌘G");
  assert.equal(shortcut(LIVE_MENUS[1]!), "⇧⌘R");
});

test("live_command groups tracks side by side: the first selected, the selection stretched, Live's Group Tracks pressed, the new group said", async () => {
  let b!: Awaited<ReturnType<typeof opened>>;
  const hands = fakeHands({ onMenu: (path) => { if (path.at(-1) === "Group") b.addTrack("2-Group"); } });
  b = await opened({ version: "1.0.70", hands });
  try {
    const result = await tool(b.tools, "live_command").execute({ command: "group_tracks", tracks: ["Fixture Bass", "Fixture Drums"] }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as { pressed: string; liveShortcut: string; newTracks: string[] };
    assert.equal(reply.pressed, "Edit › Group");
    assert.equal(reply.liveShortcut, "⌘G");
    assert.deepEqual(reply.newTracks, ["2-Group"]);
    // Session view in front, the first track selected through the bridge, the rest by Live's own Shift-→.
    assert.ok(b.requests.some((request) => request.name === "live_view_preview" && request.args.view === "Session"));
    assert.ok(b.requests.some((request) => request.name === "live_selection_preview" && request.args.trackRef === "7:track:0"));
    assert.deepEqual(hands.keys, [["shift+right"]]);
    assert.deepEqual(hands.pressed, [["Edit", "Group"]]);
    // HISTORY keeps it, with Live's undo the way back.
    assert.deepEqual(b.records.map((record) => [record.title, record.state]), [["Grouped 2 tracks", "kept"]]);
    assert.match(b.records[0]!.note ?? "", /Live's undo/);
    assert.equal(b.actions.at(-1)?.title, "Grouped 2 tracks");
  } finally { await b.integration.close(); }
});

test("live_command asks macOS for access once, says a greyed-out command needs a selection, and answers Live's dialogs", async () => {
  const untrusted = fakeHands({ trusted: false });
  let b = await opened({ version: "1.0.70", hands: untrusted });
  try {
    const result = await tool(b.tools, "live_command").execute({ command: "save" }, signal());
    assert.equal(result.isError, true);
    assert.match(result.text, /Accessibility/);
    assert.deepEqual(untrusted.prompts, [false, true], "macOS's own request is shown");
    assert.equal(untrusted.pressed.length, 0);
  } finally { await b.integration.close(); }
  const hands = fakeHands({ onMenu: (path) => (path.at(-1) === "Freeze Track" ? { ok: false, error: "disabled" } : undefined) });
  b = await opened({ version: "1.0.70", hands });
  try {
    const greyed = await tool(b.tools, "live_command").execute({ command: "freeze_track", track: "Fixture Bass" }, signal());
    assert.equal(greyed.isError, true);
    assert.match(greyed.text, /greyed out right now/);
    assert.match((await tool(b.tools, "live_command").execute({ command: "freeze_track" }, signal())).text, /works on a track/);
    assert.match((await tool(b.tools, "live_command").execute({ menu: ["Create", "Insert Silence"] }, signal())).text, /menus don't have/);
    // Export opens Live's dialog: its words come back, and answer presses a button.
    hands.setDialog({ open: true, title: "Export Audio/Video", buttons: ["Export", "Cancel"] });
    const exported = JSON.parse((await tool(b.tools, "live_command").execute({ command: "export_audio" }, signal())).text) as { dialog: { buttons: string[] } };
    assert.deepEqual(exported.dialog.buttons, ["Export", "Cancel"]);
    const answered = await tool(b.tools, "live_command").execute({ answer: "Cancel" }, signal());
    assert.equal(answered.isError, false, answered.text);
    assert.deepEqual(hands.answered, ["Cancel"]);
    assert.match((await tool(b.tools, "live_command").execute({ answer: "OK" }, signal())).text, /no dialog open/);
  } finally { await b.integration.close(); }
});
