import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { doctorChecks, runDoctor, type DoctorIo } from "../src/doctor.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "kumi-doctor-"));
  const scripts = join(root, "Remote Scripts"); const packageRoot = join(root, "bridge", "node_modules", "@ableton-mcp", "mcp-server");
  mkdirSync(join(scripts, "AbletonMcpBridge"), { recursive: true }); mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.9" }));
  const node = join(root, "_npx", "abc", "node"); mkdirSync(join(root, "_npx", "abc"), { recursive: true }); writeFileSync(node, "#!/bin/sh\necho v24.1.0\n"); chmodSync(node, 0o755);
  const config = join(root, "bridge-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, server: { command: node, args: [join(packageRoot, "dist", "src", "cli.js"), "--config", config] } }));
  writeFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), JSON.stringify({ config }));
  const env = { KUMI_REMOTE_SCRIPTS_DIR: scripts, KUMI_MODEL: "openai/gpt-fixture", OPENAI_API_KEY: "sk-fixture-never-printed", KUMI_AUTH_FILE: join(root, "auth.json"), KUMI_SETTINGS_FILE: join(root, "settings.json"), KUMI_PROJECTS_DIR: join(root, "projects") };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const io = (env: DoctorIo["env"], extra: Partial<DoctorIo> = {}): DoctorIo => ({ out: new Writable({ write(_c, _e, done) { done(); } }), env, nodeVersion: "v24.21.0",
  terminal: { isTTY: true, columns: 120, rows: 36 }, probeLive: async () => ({ started: true, connected: true, set: "Night Drive", realLive: true }), nodeVersionOf: async () => "v24.1.0", ...extra });

test("the doctor says what's fine and exactly what to fix, without printing secrets", async () => {
  const s = setup();
  try {
    let printed = "";
    const out = new Writable({ write(chunk, _e, done) { printed += String(chunk); done(); } });
    const code = await runDoctor({ ...io(s.env), out, nodeVersion: "v25.9.0", bundledBridgeVersion: "1.0.10" });
    assert.equal(code, 1);
    assert.match(printed, /fix +Node\.js 25\.9\.0 isn't supported/); assert.match(printed, /Install Node 24 LTS/);
    assert.match(printed, /ok +openai API key from OPENAI_API_KEY · model openai\/gpt-fixture/);
    assert.match(printed, /fix +The installed bridge \(1\.0\.9\) is older than this Kumi's \(1\.0\.10\)/);
    assert.match(printed, /note +Other MCP apps would start the bridge with a Node from a temporary folder/);
    assert.match(printed, /ok +Live connected · Night Drive/);
    assert.match(printed, /2 things to fix/);
    assert(!printed.includes("sk-fixture-never-printed"), "no secret is printed");
  } finally { s.cleanup(); }
});

test("the doctor explains Live, the bridge and the terminal in plain words", async () => {
  const s = setup();
  try {
    const away = await doctorChecks(io(s.env, { probeLive: async () => ({ started: true, connected: false }) }));
    assert.equal(away.find((check) => /Live isn't connected/.test(check.text))?.status, "fix");
    const stopped = await doctorChecks(io(s.env, { probeLive: async () => ({ started: false }) }));
    assert.match(stopped.find((check) => /didn't start/.test(check.text))?.next ?? "", /npm run setup/);
    const small = await doctorChecks(io(s.env, { terminal: { isTTY: true, columns: 50, rows: 12 } }));
    assert.match(small.find((check) => /Terminal/.test(check.text))?.text ?? "", /small/);
    const missing = await doctorChecks(io({ ...s.env, KUMI_REMOTE_SCRIPTS_DIR: join(s.root, "nowhere") }));
    assert.match(missing.find((check) => /bridge isn't installed/.test(check.text))?.next ?? "", /Connect to Live/);
    const unsigned = await doctorChecks(io({ ...s.env, KUMI_MODEL: "openai-codex/gpt-fixture" }));
    assert.equal(unsigned.find((check) => /ChatGPT/.test(check.text))?.next, "npm run kumi -- login openai-codex");
  } finally { s.cleanup(); }
});
