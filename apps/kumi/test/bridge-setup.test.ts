import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setupBridge, type BridgeSetupIo, type Ran } from "../src/bridge-setup.js";

/** A repository bridge at `bundled`, Live's Remote Scripts folder, and (with `installed`) a bridge installed there. */
function world(options: { bundled: string; installed?: string }) {
  const root = mkdtempSync(join(tmpdir(), "kumi-bridge-setup-"));
  const bridgeDir = join(root, "repo", "apps", "mcp-server");
  mkdirSync(join(bridgeDir, "dist", "src"), { recursive: true });
  writeFileSync(join(bridgeDir, "package.json"), JSON.stringify({ name: "@ableton-mcp/mcp-server", version: options.bundled }));
  writeFileSync(join(bridgeDir, "dist", "src", "lifecycle-cli.js"), "");
  const scripts = join(root, "Remote Scripts");
  mkdirSync(join(scripts, "AbletonMcpBridge"), { recursive: true });
  const state = join(root, "state");
  if (options.installed) {
    const packageRoot = join(root, "installed", "node_modules", "@ableton-mcp", "mcp-server");
    mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: options.installed }));
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "bridge-config.json"), JSON.stringify({ server: { command: process.execPath, args: [join(packageRoot, "dist", "src", "cli.js")] } }));
    writeFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), JSON.stringify({ config: join(state, "bridge-config.json") }));
  }
  const calls: { command: string; args: readonly string[] }[] = [];
  let out = "";
  const output = new PassThrough(); output.on("data", (chunk) => { out += String(chunk); });
  const lifecycle: Ran[] = [];
  const io = (extra: Partial<BridgeSetupIo> = {}): BridgeSetupIo => ({
    out: output, env: { KUMI_REMOTE_SCRIPTS_DIR: scripts, KUMI_LIVE_EXTENSIONS_DIR: join(root, "Ableton", "Extensions") }, bridgeDir, home: join(root, "kumi"), waitMs: 0, yes: true,
    liveRunning: async () => false, sleep: async () => {},
    async run(command, args, cwd) {
      calls.push({ command, args });
      if (command === "npm" && args[0] === "pack") {
        const destination = args[args.indexOf("--pack-destination") + 1]!;
        writeFileSync(join(destination, "ableton-mcp-mcp-server.tgz"), "tarball bytes");
        return { code: 0, stdout: "ableton-mcp-mcp-server.tgz\n", stderr: "" };
      }
      if (command === "npm") {
        // The bridge's package carries Kumi's Live extension (staged when it's packed).
        const extension = join(args[args.indexOf("--prefix") + 1]!, "node_modules", "@ableton-mcp", "mcp-server", "live-extension");
        mkdirSync(join(extension, "dist"), { recursive: true });
        writeFileSync(join(extension, "manifest.json"), JSON.stringify({ name: "kumi", author: "Kumi", version: "1.0.0" })); writeFileSync(join(extension, "dist", "extension.js"), "module.exports = {};\n");
        return { code: 0, stdout: "added 1 package\n", stderr: "" };
      }
      assert.equal(command, process.execPath, "the lifecycle runs on Kumi's own Node");
      void cwd;
      return lifecycle.shift() ?? { code: 0, stdout: JSON.stringify({ version: "ableton-mcp-lifecycle/v1", state: "completed" }), stderr: "" };
    },
    ...extra,
  });
  return { root, scripts, state, calls, io, lifecycle, get out() { return out; }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const answer = (value: object, code = 0): Ran => ({ code, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

test("an installed bridge that's Kumi's own is left alone", async () => {
  const w = world({ bundled: "1.0.34", installed: "1.0.34" });
  try {
    assert.equal(await setupBridge(w.io()), 0);
    assert.match(w.out, /bridge 1\.0\.34 is installed, the same as Kumi's/);
    assert.equal(w.calls.length, 0, "nothing runs");
  } finally { w.done(); }
});

test("with Live open, nothing is changed and the producer is asked to quit it first", async () => {
  const w = world({ bundled: "1.0.34", installed: "1.0.33" });
  try {
    assert.equal(await setupBridge(w.io({ liveRunning: async () => true })), 1);
    assert.match(w.out, /Live is open\. Save your work, quit Live, then run this again: npm run kumi -- bridge/);
    assert.equal(w.calls.length, 0, "no packing, no installing");
    assert.equal(await setupBridge(w.io({ yes: false, confirm: async () => false })), 1);
    assert.match(w.out, /Nothing was changed/);
    assert.equal(w.calls.length, 0);
  } finally { w.done(); }
});

test("a first install packs Kumi's bridge, then has its lifecycle plan and apply it, and says what to do in Live", async () => {
  const w = world({ bundled: "1.0.34" });
  try {
    w.lifecycle.push(answer({ version: "ableton-mcp-lifecycle/v1", action: "install", applied: false, state: "planned" }),
      answer({ version: "ableton-mcp-lifecycle/v1", action: "install", applied: true, state: "installed-restart-required" }));
    assert.equal(await setupBridge(w.io()), 0, w.out);
    const [pack, install, plan, apply] = w.calls;
    assert.deepEqual([pack!.command, pack!.args[0], install!.command, install!.args[0]], ["npm", "pack", "npm", "install"]);
    assert.equal(plan!.args[1], "install");
    const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag(plan!.args, "--remote-scripts-dir"), w.scripts);
    assert.equal(flag(plan!.args, "--state-dir"), join(w.root, "kumi", "bridge", "state"), "a new install keeps its state in Kumi's folder");
    assert.match(flag(plan!.args, "--artifact-sha256")!, /^[0-9a-f]{64}$/);
    assert(!plan!.args.includes("--apply"), "the plan changes nothing");
    assert(apply!.args.includes("--apply") && apply!.args.includes("--confirm-live-stopped"));
    assert(!apply!.args.includes("--allow-dirty-private-build"), "only a developer asks for that");
    assert.match(w.out, /choose AbletonMcpBridge as a Control Surface/);
  } finally { w.done(); }
});

test("an update keeps the installed bridge's state, and the installer's refusal is said as it is", async () => {
  const w = world({ bundled: "1.0.34", installed: "1.0.33" });
  try {
    // Like the real lifecycle, a refusal is JSON on stderr.
    w.lifecycle.push({ code: 1, stdout: "", stderr: `${JSON.stringify({ version: "ableton-mcp-lifecycle-error/v1", reason: "private build is dirty; pass --allow-dirty-private-build" })}\n` });
    assert.equal(await setupBridge(w.io()), 1);
    const plan = w.calls.find((call) => call.command === process.execPath)!;
    assert.equal(plan.args[1], "upgrade");
    assert.equal(plan.args[plan.args.indexOf("--state-dir") + 1], w.state);
    assert.match(w.out, /1\.0\.34; the one Live uses is 1\.0\.33/);
    assert.match(w.out, /installer refused: private build is dirty/);
    assert.match(w.out, /add --allow-dirty/);
  } finally { w.done(); }
});

test("after installing, Kumi waits for Live to connect through the new bridge", async () => {
  const w = world({ bundled: "1.0.34", installed: "1.0.33" });
  try {
    w.lifecycle.push(answer({ version: "ableton-mcp-lifecycle/v1", state: "planned" }), answer({ version: "ableton-mcp-lifecycle/v1", state: "installed-restart-required" }),
      answer({ version: "ableton-mcp-lifecycle/v1", state: "activation-required" }), answer({ version: "ableton-mcp-lifecycle/v1", state: "activated" }));
    assert.equal(await setupBridge(w.io({ waitMs: 60_000, allowDirty: true })), 0);
    const activations = w.calls.filter((call) => call.args[1] === "activate");
    assert.equal(activations.length, 2);
    assert(activations.every((call) => call.args.includes("--allow-dirty-private-build")), "a developer's flag goes to every step");
    assert.match(w.out, /Now open Live\. Kumi connects on its own/);
    assert.match(w.out, /Live is connected through the new bridge/);
  } finally { w.done(); }
});

test("a User Library without a Remote Scripts folder gets one; without a User Library, Kumi says where it looked", async () => {
  const w = world({ bundled: "1.0.34" });
  try {
    const library = join(w.root, "Library Moved", "User Library"); mkdirSync(library, { recursive: true });
    w.lifecycle.push(answer({ version: "ableton-mcp-lifecycle/v1", state: "planned" }), answer({ version: "ableton-mcp-lifecycle/v1", state: "installed-restart-required" }));
    assert.equal(await setupBridge(w.io({ env: { KUMI_REMOTE_SCRIPTS_DIR: join(library, "Remote Scripts") } })), 0, w.out);
    assert.equal(existsSync(join(library, "Remote Scripts")), true, "made for the Remote Script");
    const lost = world({ bundled: "1.0.34" });
    try {
      assert.equal(await setupBridge(lost.io({ env: { KUMI_REMOTE_SCRIPTS_DIR: join(lost.root, "Nowhere", "User Library", "Remote Scripts") } })), 1);
      assert.match(lost.out, /couldn't find Live's User Library \(it looked for .*Nowhere.*User Library\)/);
      assert.equal(lost.calls.length, 0, "nothing was packed or installed");
    } finally { lost.done(); }
  } finally { w.done(); }
});

test("installing the bridge puts Kumi's extension in Live's Extensions folder; an installed bridge without it gets it", async () => {
  const w = world({ bundled: "1.0.57" });
  try {
    mkdirSync(join(w.root, "Ableton"), { recursive: true });
    assert.equal(await setupBridge(w.io()), 0);
    const placed = join(w.root, "Ableton", "Extensions", "kumi.kumi");
    assert.equal(readFileSync(join(placed, "dist", "extension.js"), "utf8"), "module.exports = {};\n");
    assert.match(readFileSync(join(placed, "package.json"), "utf8"), /"main": "dist\/extension\.js"/);
    assert.match(w.out, /Added Kumi's extension to Live: it renders tracks without playing them/);
    assert.doesNotMatch(w.out, /next time you open Live/);
  } finally { w.done(); }
  const current = world({ bundled: "1.0.57", installed: "1.0.57" });
  try {
    mkdirSync(join(current.root, "Ableton"), { recursive: true });
    const carried = join(current.root, "installed", "node_modules", "@ableton-mcp", "mcp-server", "live-extension");
    mkdirSync(join(carried, "dist"), { recursive: true });
    writeFileSync(join(carried, "manifest.json"), JSON.stringify({ version: "1.0.0" })); writeFileSync(join(carried, "dist", "extension.js"), "installed();\n");
    assert.equal(await setupBridge(current.io({ liveRunning: async () => true })), 0);
    assert.equal(readFileSync(join(current.root, "Ableton", "Extensions", "kumi.kumi", "dist", "extension.js"), "utf8"), "installed();\n");
    assert.match(current.out, /It starts the next time you open Live\./);
    assert.equal(current.calls.length, 0, "nothing runs");
    // Once it's there, the same again changes nothing and says nothing more.
    const before = current.out.length;
    assert.equal(await setupBridge(current.io()), 0);
    assert.doesNotMatch(current.out.slice(before), /extension/);
  } finally { current.done(); }
});

test("without Live's own folder (Live never opened), the extension isn't placed and the bridge still installs", async () => {
  const w = world({ bundled: "1.0.57" });
  try {
    assert.equal(await setupBridge(w.io()), 0);
    assert.equal(existsSync(join(w.root, "Ableton", "Extensions")), false);
    assert.match(w.out, /Kumi couldn't add its extension to Live \(Live's folder isn't there .*open Live once\); everything else works/);
  } finally { w.done(); }
});
