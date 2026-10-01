import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const env = { KUMI_REMOTE_SCRIPTS_DIR: scripts, KUMI_MODEL: "openai/gpt-fixture", OPENAI_API_KEY: "sk-fixture-never-printed", KUMI_AUTH_FILE: join(root, "auth.json"), KUMI_SETTINGS_FILE: join(root, "settings.json"), KUMI_PROJECTS_DIR: join(root, "projects"), KUMI_LIVE_EXTENSIONS_DIR: join(root, "Ableton", "Extensions") };
  return { root, env, packageRoot, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const io = (env: DoctorIo["env"], extra: Partial<DoctorIo> = {}): DoctorIo => ({ out: new Writable({ write(_c, _e, done) { done(); } }), env, nodeVersion: "v24.21.0",
  terminal: { isTTY: true, columns: 120, rows: 36 }, probeLive: async () => ({ started: true, connected: true, set: "Night Drive", realLive: true }), nodeVersionOf: async () => "v24.1.0",
  videoPrograms: async () => ({ ffmpeg: "/usr/bin/ffmpeg", whisper: "/usr/bin/whisper-cli" }), ...extra });

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
    // With Live's part as new as Kumi's, the bridge stopping at its handshake means Live isn't answering.
    const unanswered = await doctorChecks(io(s.env, { bundledBridgeVersion: "1.0.9", probeLive: async () => ({ started: false }) }));
    assert.match(unanswered.find((check) => /couldn't reach Live/.test(check.text))?.next ?? "", /Control Surface.*answer it first/);
    assert(!unanswered.some((check) => /didn't start/.test(check.text)));
    const small = await doctorChecks(io(s.env, { terminal: { isTTY: true, columns: 50, rows: 12 } }));
    assert.match(small.find((check) => /Terminal/.test(check.text))?.text ?? "", /small/);
    const missing = await doctorChecks(io({ ...s.env, KUMI_REMOTE_SCRIPTS_DIR: join(s.root, "nowhere") }));
    assert.match(missing.find((check) => /bridge isn't installed/.test(check.text))?.next ?? "", /npm run kumi -- bridge/);
    const unsigned = await doctorChecks(io({ ...s.env, KUMI_MODEL: "openai-codex/gpt-fixture" }));
    assert.equal(unsigned.find((check) => /ChatGPT/.test(check.text))?.next, "npm run kumi -- login openai-codex");
  } finally { s.cleanup(); }
});

test("the doctor says what watching videos needs: ffmpeg for frames, whisper.cpp for videos without captions", async () => {
  const s = setup();
  try {
    const all = await doctorChecks(io(s.env));
    assert.equal(all.find((check) => /Watches videos/.test(check.text))?.status, "ok");
    const noWhisper = await doctorChecks(io(s.env, { videoPrograms: async () => ({ ffmpeg: "/usr/bin/ffmpeg" }) }));
    const note = noWhisper.find((check) => /without captions needs whisper\.cpp/.test(check.text));
    assert.equal(note?.status, "note"); assert.match(note?.next ?? "", /whisper/);
    const noFfmpeg = await doctorChecks(io(s.env, { videoPrograms: async () => ({}) }));
    assert.match(noFfmpeg.find((check) => /can't see its frames/.test(check.text))?.next ?? "", /ffmpeg/);
    assert.ok(noFfmpeg.every((check) => check.status !== "fix" || !/video/.test(check.text)), "videos are never something to fix");
  } finally { s.cleanup(); }
});

/** An extension folder (manifest and code), as the bridge carries it and Live keeps it. */
function extensionFolder(folder: string, code = "module.exports = {};\n"): void {
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ name: "kumi", author: "Kumi", version: "1.0.0", entry: "dist/extension.js", minimumApiVersion: "1.0.0" }));
  writeFileSync(join(folder, "dist", "extension.js"), code);
}

test("the doctor says whether Kumi's extension is in Live, the bridge's own, running and answering", async () => {
  const s = setup();
  const extensions = s.env.KUMI_LIVE_EXTENSIONS_DIR; const data = join(dirname(extensions), "Extensions Data", "kumi.kumi");
  // A stand-in for the running extension: it greets each connection the way the extension does.
  const server = createServer((socket) => socket.end(`${JSON.stringify({ version: "ableton-loopback/v1", id: "hello", ok: true })}\n`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const line = async (probe: Partial<Awaited<ReturnType<NonNullable<DoctorIo["probeLive"]>>>> = {}) => (await doctorChecks(io(s.env, { probeLive: async () => ({ started: true, connected: true, realLive: true, ...probe }) }))).find((check) => /extension/.test(check.text));
  try {
    assert.equal(await line(), undefined, "a bridge without an extension says nothing more");
    extensionFolder(join(s.packageRoot, "live-extension"));
    assert.deepEqual(await line(), { status: "fix", text: "Kumi's extension isn't in Live (it renders tracks without playing them and writes MIDI clips in the Arrangement)", next: "Run: npm run kumi -- bridge, then restart Live" });
    cpSync(join(s.packageRoot, "live-extension"), join(extensions, "kumi.kumi"), { recursive: true });
    assert.match((await line())!.text, /Live hasn't started Kumi's extension/);
    assert.match((await line({ connected: false }))!.text, /Kumi's extension 1\.0\.0 is in Live; it starts with Live/);
    mkdirSync(data, { recursive: true }); writeFileSync(join(data, "endpoint.json"), JSON.stringify({ host: "127.0.0.1", port, pid: process.pid }));
    assert.deepEqual(await line(), { status: "ok", text: "Kumi's extension is running in Live" });
    // With Developer Mode on, Live starts no extensions: the bridge started this one in its own folder.
    rmSync(data, { recursive: true }); mkdirSync(join(dirname(s.config), "live-extension"), { recursive: true });
    writeFileSync(join(dirname(s.config), "live-extension", "endpoint.json"), JSON.stringify({ host: "127.0.0.1", port, pid: process.pid }));
    assert.match((await line())!.text, /running \(Kumi started it: Live's Developer Mode is on\)/);
    extensionFolder(join(s.packageRoot, "live-extension"), "module.exports = { newer: true };\n");
    assert.deepEqual(await line(), { status: "fix", text: "Kumi's extension in Live is from another bridge", next: "Run: npm run kumi -- bridge, then restart Live" });
    assert.match((await line({ liveVersion: "12.3.2" }))!.text, /Live 12\.3\.2 runs no extensions \(12\.4 and later do\)/);
  } finally { server.close(); s.cleanup(); }
});
