import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { redactor, writeReport } from "../src/report.js";

test("the report holds versions, the doctor, the last conversation, the gap log and Live's log, without keys, the home folder or the account name", async () => {
  const home = mkdtempSync(join(tmpdir(), "kumi-report-"));
  try {
    const kumi = join(home, ".kumi"); const projects = join(kumi, "projects"); const conversations = join(projects, "a".repeat(32), "conversations");
    mkdirSync(conversations, { recursive: true });
    const token = "oauth-access-token-0123456789abcdef";
    writeFileSync(join(kumi, "auth.json"), JSON.stringify({ version: 1, credentials: { "openai-codex": { type: "oauth", access: token, refresh: "refresh-token-abcdefghijkl", expires: 1 } } }), { mode: 0o600 });
    writeFileSync(join(kumi, "settings.json"), JSON.stringify({ model: "openai-codex/gpt-6-astra" }));
    writeFileSync(join(kumi, "gaps.jsonl"), `${JSON.stringify({ missing: "Freezing a track", asked: "Freeze the Bass" })}\n`);
    writeFileSync(join(conversations, "older1.json"), JSON.stringify({ savedAt: 1, checkpoint: { version: 1, messages: [{ role: "user", content: "an older one" }] } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(conversations, "latest1.json"), JSON.stringify({ savedAt: 2, checkpoint: { version: 1, messages: [
      { role: "user", content: [{ type: "text", text: `Load my sample from ${home}/Music/kick.wav` }] },
      { role: "assistant", content: [{ type: "tool-call", toolName: "make_changes", input: { steps: [{ tool: "set_tempo", input: { tempo: 124 } }] } }] },
      { role: "tool", content: [{ type: "tool-result", output: { type: "text", value: "{\"done\":[{\"changed\":\"Tempo 120 → 124 BPM\"}]}" } }] },
    ] }, changes: [{ title: "Tempo 120 → 124 BPM", state: "applied" }] }));
    const log = join(home, "Log.txt");
    writeFileSync(log, ["info: MemoryUsage: fine", " Exception: 0x0000000103218c50:0x0000000000000000", "error: Python: ValueError: bad value", '  MidiRemoteScript 5 [Control Surface="None"]', "info: RemoteScriptMessage: (AbletonMcpBridge) Initializing...", "error: Python: Traceback (most recent call last):", '  File "bridge.py", line 1', "RuntimeError: boom", "info: unrelated"].join("\n"));
    const env = { KUMI_AUTH_FILE: join(kumi, "auth.json"), KUMI_SETTINGS_FILE: join(kumi, "settings.json"), KUMI_PROJECTS_DIR: projects, KUMI_GAPS_FILE: join(kumi, "gaps.jsonl"),
      KUMI_REMOTE_SCRIPTS_DIR: join(home, "none"), OPENAI_API_KEY: "sk-live-abcdefghijklmnop", TERM_PROGRAM: "ghostty" };
    let printed = "";
    const code = await writeReport({ out: new Writable({ write(chunk, _e, done) { printed += String(chunk); done(); } }), env, home, user: "fixtureuser", folder: home,
      now: () => new Date("2026-09-29T20:00:00Z"), nodeVersion: "v24.21.0", terminal: { isTTY: false }, liveLogs: async () => [log],
      videoPrograms: async () => ({}) });
    assert.equal(code, 0);
    const file = join(home, "kumi-report-2026-09-29T20-00-00.txt");
    assert.deepEqual(readdirSync(home).filter((name) => name.startsWith("kumi-report")), ["kumi-report-2026-09-29T20-00-00.txt"]);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "only this user can read it");
    assert.match(printed, /Kumi's report is in ~\/kumi-report-2026-09-29T20-00-00\.txt/);
    const text = readFileSync(file, "utf8");
    for (const heading of ["## Versions", "## Doctor", "## Settings", "## Last conversation", "## What Kumi couldn't do (gap log)", "## Live's log"]) assert.ok(text.includes(heading), heading);
    assert.match(text, /Kumi \d+\.\d+\.\d+/); assert.match(text, /Terminal: ghostty/); assert.match(text, /model: openai-codex\/gpt-6-astra/);
    assert.match(text, /producer: Load my sample from ~\/Music\/kick\.wav/, "the home folder is ~");
    assert.match(text, /→ make_changes \{"steps":\[\{"tool":"set_tempo"/); assert.match(text, /← .*Tempo 120 → 124 BPM/); assert.match(text, /applied · Tempo 120 → 124 BPM/);
    assert.ok(!text.includes("an older one"), "only the last conversation");
    assert.match(text, /Freezing a track/);
    assert.match(text, /AbletonMcpBridge\) Initializing/); assert.match(text, /RuntimeError: boom/); assert.match(text, /File "bridge.py"/, "a traceback keeps its lines");
    assert.match(text, /Python: ValueError: bad value/);
    assert.ok(!text.includes("MemoryUsage") && !text.includes("unrelated") && !text.includes("MidiRemoteScript") && !text.includes("0x0000000103218c50"));
    for (const secret of [token, "refresh-token-abcdefghijkl", "sk-live-abcdefghijklmnop", home]) assert.ok(!text.includes(secret), `no ${secret.slice(0, 12)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("redaction takes out keys, tokens, long values, the home folder in either slash, and the account name", () => {
  const redact = redactor(["saved-key-1234567890"], "C:\\Users\\Mia", "Mia");
  assert.equal(redact("key saved-key-1234567890 and sk-abcdefghijklmnopqrst"), "key [secret] and [secret]");
  assert.equal(redact("Authorization: Bearer abc.def"), "Authorization: Bearer [secret]");
  assert.equal(redact('{"token": "abcdefghijk"}'), '{"token": "[secret]"}');
  assert.equal(redact(`x ${"A".repeat(60)} y`), "x [long value] y");
  assert.equal(redact("C:\\Users\\Mia\\Music\\a.als and C:/Users/Mia/b"), "~\\Music\\a.als and ~/b");
  assert.equal(redact("Mia's set, Miami"), "<user>'s set, Miami");
  assert.equal(redact("~/.config/ableton-mcp-release-a8a291e/bridge-config.json"), "~/.config/ableton-mcp-release-a8a291e/bridge-config.json", "paths stay readable");
});
