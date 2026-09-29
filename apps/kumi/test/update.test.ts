import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import type { Ran } from "../src/bridge-setup.js";
import { newer, newerKumi, runUpdate } from "../src/update.js";

/** A checkout following origin/main, with Kumi and its bridge at the given versions, and a bridge in Live. */
function checkout(kumi: string, bundled: string, installed?: string) {
  const root = mkdtempSync(join(tmpdir(), "kumi-update-"));
  const repo = join(root, "repo"); mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(repo, "apps", "mcp-server"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: kumi })); writeFileSync(join(repo, "apps", "mcp-server", "package.json"), JSON.stringify({ version: bundled }));
  const env: Record<string, string> = { KUMI_REMOTE_SCRIPTS_DIR: join(root, "none") };
  if (installed) {
    const scripts = join(root, "Remote Scripts"); const packageRoot = join(root, "bridge", "node_modules", "@ableton-mcp", "mcp-server");
    mkdirSync(join(scripts, "AbletonMcpBridge"), { recursive: true }); mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: installed }));
    const config = join(root, "bridge-config.json");
    writeFileSync(config, JSON.stringify({ version: 2, server: { command: process.execPath, args: [join(packageRoot, "dist", "src", "cli.js"), "--config", config] } }));
    writeFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), JSON.stringify({ config }));
    env.KUMI_REMOTE_SCRIPTS_DIR = scripts;
  }
  return { root, repo, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** git and npm as the checkout would answer: `upstream` is package.json on origin/main; `behind`, the commits to take. */
function programs(options: { upstream?: string; behind?: number; dirty?: boolean; offline?: boolean; onMerge?: () => void }) {
  const calls: string[] = [];
  const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
  const run = async (command: string, args: readonly string[]): Promise<Ran> => {
    const line = `${command} ${args.join(" ")}`; calls.push(line);
    if (line.startsWith("git rev-parse")) return ok("origin/main\n");
    if (line.startsWith("git fetch")) return options.offline ? { code: 128, stdout: "", stderr: "fatal: unable to access" } : ok();
    if (line.startsWith("git show")) return ok(JSON.stringify({ version: options.upstream ?? "1.0.0" }));
    if (line.startsWith("git status")) return ok(options.dirty ? " M apps/kumi/src/cli.ts\n" : "");
    if (line.startsWith("git rev-list")) return ok(`${options.behind ?? 0}\n`);
    if (line.startsWith("git merge")) { options.onMerge?.(); return ok(); }
    if (line.startsWith("npm run setup")) return ok();
    return { code: 1, stdout: "", stderr: `unexpected ${line}` };
  };
  return { run, calls };
}
const sink = () => { let text = ""; return { out: new Writable({ write(chunk, _e, done) { text += String(chunk); done(); } }), text: () => text }; };

test("versions compare by number", () => {
  assert.equal(newer("1.0.10", "1.0.9"), true); assert.equal(newer("1.1.0", "1.0.39"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false); assert.equal(newer("0.9.9", "1.0.0"), false);
});

test("a newer Kumi on the checkout's branch is found with git, at most once a day, and nothing is said otherwise", async () => {
  const c = checkout("1.0.0", "1.0.39");
  try {
    const cacheFile = join(c.root, "kumi", "update-check.json");
    const p = programs({ upstream: "1.0.1" });
    let now = 1_000_000;
    assert.equal(await newerKumi({ cacheFile, run: p.run, repoDir: c.repo, now: () => now, version: "1.0.0" }), "1.0.1");
    assert.ok(p.calls.includes("git fetch --quiet origin main"));
    const asked = p.calls.length;
    now += 60 * 60_000;
    assert.equal(await newerKumi({ cacheFile, run: p.run, repoDir: c.repo, now: () => now, version: "1.0.0" }), "1.0.1", "from the last answer");
    assert.equal(p.calls.length, asked, "git isn't asked again the same day");
    assert.equal(await newerKumi({ cacheFile, run: p.run, repoDir: c.repo, now: () => now, version: "1.0.1" }), undefined, "once updated, nothing");
    now += 25 * 60 * 60_000;
    const same = programs({ upstream: "1.0.1" });
    await newerKumi({ cacheFile, run: same.run, repoDir: c.repo, now: () => now, version: "1.0.0" });
    assert.ok(same.calls.some((call) => call.startsWith("git fetch")), "a day later, asked again");
    // Offline, or not a checkout: nothing.
    const offline = programs({ offline: true });
    assert.equal(await newerKumi({ cacheFile: join(c.root, "other.json"), run: offline.run, repoDir: c.repo, version: "1.0.0" }), undefined);
    rmSync(join(c.repo, ".git"), { recursive: true });
    assert.equal(await newerKumi({ cacheFile: join(c.root, "third.json"), run: p.run, repoDir: c.repo, version: "1.0.0" }), undefined);
  } finally { c.cleanup(); }
});

test("update moves the checkout forward, rebuilds, and updates an older bridge in Live, or says to quit Live first", async () => {
  const c = checkout("1.0.0", "1.0.39", "1.0.35");
  try {
    const p = programs({ behind: 3, onMerge: () => { writeFileSync(join(c.repo, "package.json"), JSON.stringify({ version: "1.0.1" })); writeFileSync(join(c.repo, "apps", "mcp-server", "package.json"), JSON.stringify({ version: "1.0.40" })); } });
    const s = sink(); let bridged = "";
    const code = await runUpdate({ out: s.out, env: c.env, run: p.run, repoDir: c.repo, liveRunning: async () => false, updateBridge: async (repo) => { bridged = repo; return 0; } });
    assert.equal(code, 0);
    assert.deepEqual(p.calls.filter((call) => /merge|setup/.test(call)), ["git merge --ff-only origin/main", "npm run setup"]);
    assert.match(s.text(), /Kumi is now 1\.0\.1\./); assert.match(s.text(), /The bridge in Live is 1\.0\.35; this Kumi's is 1\.0\.40\./);
    assert.equal(bridged, c.repo, "the updated checkout's own bridge command runs");
    // Live open: nothing is changed in Live; it says what to do.
    const open = sink(); let touched = false;
    await runUpdate({ out: open.out, env: c.env, run: programs({}).run, repoDir: c.repo, liveRunning: async () => true, updateBridge: async () => { touched = true; return 0; } });
    assert.match(open.text(), /Kumi is up to date \(1\.0\.1\)\./); assert.match(open.text(), /Quit Live \(save your work first\), then run: npm run kumi -- bridge/);
    assert.equal(touched, false);
  } finally { c.cleanup(); }
});

test("update leaves a checkout with changes of its own, and says when the bridge is current or not installed", async () => {
  const c = checkout("1.0.0", "1.0.39", "1.0.39");
  try {
    const dirty = programs({ dirty: true, behind: 2 }); const s = sink();
    assert.equal(await runUpdate({ out: s.out, env: c.env, run: dirty.run, repoDir: c.repo }), 1);
    assert.match(s.text(), /changes of its own/); assert.ok(!dirty.calls.some((call) => /merge|setup/.test(call)));
    const current = sink();
    assert.equal(await runUpdate({ out: current.out, env: c.env, run: programs({}).run, repoDir: c.repo }), 0);
    assert.match(current.text(), /The bridge in Live is up to date\./);
    const none = sink();
    await runUpdate({ out: none.out, env: { KUMI_REMOTE_SCRIPTS_DIR: join(c.root, "none") }, run: programs({}).run, repoDir: c.repo });
    assert.match(none.text(), /To connect Live, quit Live, then run: npm run kumi -- bridge/);
  } finally { c.cleanup(); }
});
