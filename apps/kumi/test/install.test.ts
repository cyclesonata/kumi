import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { KUMI_VERSION } from "@kumi/runtime";
import { askRelease, checkRelease, fetchManifest, newerVersion, PATH_MARKER, rollbackInstalled, swapIn, uninstallInstalled, updateInstalled } from "../src/install.js";

const out = () => { const stream = new PassThrough(); let text = ""; stream.on("data", (chunk) => { text += String(chunk); }); return { stream, text: () => text }; };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const node = process.versions.node;

/** A tiny Kumi release: a kumi.mjs that says its version, packed like the real bundle. */
function fakeRelease(dir: string, version: string): { bundle: Buffer; sha256: string } {
  const stage = join(dir, `stage-${version}`);
  mkdirSync(join(stage, "apps", "kumi", "bin"), { recursive: true });
  writeFileSync(join(stage, "apps", "kumi", "bin", "kumi.mjs"), `process.stdout.write("Kumi ${version}\\n");\n`);
  writeFileSync(join(stage, "package.json"), JSON.stringify({ version }));
  const file = join(dir, `kumi-${version}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", stage, "."]);
  const bundle = readFileSync(file);
  return { bundle, sha256: createHash("sha256").update(bundle).digest("hex") };
}

test("versions compare by number, and a release's description is checked before it's used", async () => {
  assert.equal(newerVersion("1.1.0", "1.0.9"), true); assert.equal(newerVersion("1.0.10", "1.0.9"), true); assert.equal(newerVersion("1.0.0", "1.0.0"), false);
  const good = { kumi: "1.2.3", bundle: "kumi.tar.gz", sha256: "a".repeat(64), node: "24.21.0" };
  assert.deepEqual(await fetchManifest({ KUMI_RELEASES: "https://example.test/r/" }, (async (url: string | URL | Request) => { assert.equal(String(url), "https://example.test/r/kumi-release.json"); return json(good); }) as typeof fetch), good);
  for (const bad of [{ ...good, sha256: "short" }, { ...good, bundle: "../../evil.tar.gz" }, { ...good, kumi: "latest" }, { ...good, node: undefined }]) {
    assert.equal(await fetchManifest({}, (async () => json(bad)) as typeof fetch), undefined);
  }
  assert.equal(await fetchManifest({}, (async () => { throw new Error("offline"); }) as typeof fetch), undefined, "no network is no answer, not a crash");
  assert.equal(await fetchManifest({}, (async () => new Response("", { status: 404 })) as typeof fetch), undefined);
});

test("asked now (/update, update --check), a release says whether it's newer; not being able to ask isn't taken for up to date", async () => {
  const release = (kumi: string) => (async () => json({ kumi, bundle: "kumi.tar.gz", sha256: "a".repeat(64), node })) as typeof fetch;
  assert.equal(await checkRelease({ KUMI_RELEASES: "https://example.test/r" }, release("99.0.0")), "99.0.0");
  assert.equal(await checkRelease({ KUMI_RELEASES: "https://example.test/r" }, release(KUMI_VERSION)), undefined);
  await assert.rejects(checkRelease({ KUMI_RELEASES: "https://example.test/r" }, (async () => { throw new Error("offline"); }) as typeof fetch), /couldn't reach GitHub/);
});

test("update puts the new Kumi in place only after checking it, keeps the one before, and rollback goes back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-install-"));
  try {
    const home = join(dir, "home"); const scripts = join(dir, "Remote Scripts");
    mkdirSync(join(home, "app", "apps", "kumi", "bin"), { recursive: true }); mkdirSync(scripts);
    writeFileSync(join(home, "app", "package.json"), JSON.stringify({ version: KUMI_VERSION }));
    writeFileSync(join(home, "app", "apps", "kumi", "bin", "kumi.mjs"), `process.stdout.write("Kumi ${KUMI_VERSION}\\n");\n`);
    writeFileSync(join(home, "settings.json"), "{}");
    const next = "99.0.0";
    const release = fakeRelease(dir, next);
    const env = { KUMI_HOME: home, KUMI_RELEASES: "https://example.test/r", KUMI_REMOTE_SCRIPTS_DIR: scripts };
    const serve = (manifest: object) => (async (url: string | URL | Request) => String(url).endsWith(".json") ? json(manifest) : new Response(new Uint8Array(release.bundle), { status: 200 })) as typeof fetch;

    // A download that doesn't match its checksum changes nothing.
    const tampered = out();
    assert.equal(await updateInstalled({ out: tampered.stream, env, fetcher: serve({ kumi: next, bundle: "kumi.tar.gz", sha256: "b".repeat(64), node }) }), 1);
    assert.match(tampered.text(), /didn't match its checksum/);
    assert.equal(existsSync(join(home, "app.previous")), false);

    // A release for another Node says to run the installer, which brings it.
    const otherNode = out();
    assert.equal(await updateInstalled({ out: otherNode.stream, env, fetcher: serve({ kumi: next, bundle: "kumi.tar.gz", sha256: release.sha256, node: "99.0.0" }) }), 1);
    assert.match(otherNode.text(), /needs Node 99\. Run the installer again/);

    const updated = out();
    assert.equal(await updateInstalled({ out: updated.stream, env, fetcher: serve({ kumi: next, bundle: "kumi.tar.gz", sha256: release.sha256, node }) }), 0, updated.text());
    assert.match(updated.text(), new RegExp(`Kumi is now ${next.replaceAll(".", "\\.")}`));
    assert.match(readFileSync(join(home, "app", "apps", "kumi", "bin", "kumi.mjs"), "utf8"), /99\.0\.0/);
    assert.equal(JSON.parse(readFileSync(join(home, "app.previous", "package.json"), "utf8")).version, KUMI_VERSION, "the one before is kept");
    assert.equal(existsSync(join(home, "app.new")), false); assert.equal(existsSync(join(home, "downloads", "kumi.tar.gz")), false, "nothing left behind");
    assert.match(updated.text(), /To connect Live/, "and then says what the bridge needs");

    const back = out();
    assert.equal(await rollbackInstalled({ out: back.stream, env }), 0);
    assert.equal(JSON.parse(readFileSync(join(home, "app", "package.json"), "utf8")).version, KUMI_VERSION);
    assert.match(readFileSync(join(home, "app.previous", "apps", "kumi", "bin", "kumi.mjs"), "utf8"), /99\.0\.0/, "and rollback again returns");

    const same = out();
    assert.equal(await updateInstalled({ out: same.stream, env, fetcher: serve({ kumi: KUMI_VERSION, bundle: "kumi.tar.gz", sha256: release.sha256, node }) }), 0);
    assert.match(same.text(), /up to date/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall removes Kumi, its Node and its launcher, and keeps the producer's own files unless asked", async () => {
  if (process.platform === "win32") return; // Windows removes them a moment after Kumi exits (covered by the installer's CI).
  const dir = mkdtempSync(join(tmpdir(), "kumi-uninstall-"));
  try {
    const home = join(dir, "home");
    for (const part of ["app", "app.previous", "node", "bin", "projects"]) mkdirSync(join(home, part), { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    const env = { KUMI_HOME: home, KUMI_REMOTE_SCRIPTS_DIR: join(dir, "none"), HOME: join(dir, "user") };
    const refused = out();
    assert.equal(await uninstallInstalled({ out: refused.stream, env, confirm: async () => false }, { all: false, yes: false }), 1);
    assert.equal(existsSync(join(home, "app")), true, "nothing goes without a yes");
    const removed = out();
    assert.equal(await uninstallInstalled({ out: removed.stream, env }, { all: false, yes: true }), 0);
    for (const part of ["app", "app.previous", "node", "bin"]) assert.equal(existsSync(join(home, part)), false, part);
    assert.equal(existsSync(join(home, "auth.json")), true); assert.equal(existsSync(join(home, "projects")), true);
    assert.equal(await uninstallInstalled({ out: out().stream, env }, { all: true, yes: true }), 0);
    assert.equal(existsSync(home), false, "--all takes everything");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** An installed Kumi whose bridge Live loads from KUMI_HOME/bridge, as `kumi bridge` sets it up. */
function withBridge(dir: string) {
  const home = join(dir, "home"); const scripts = join(dir, "Remote Scripts");
  for (const part of ["app", "node", "bin"]) mkdirSync(join(home, part), { recursive: true });
  const state = join(home, "bridge", "state"); const packageRoot = join(home, "bridge", "1.0.52-1", "node_modules", "@ableton-mcp", "mcp-server");
  mkdirSync(state, { recursive: true }); mkdirSync(join(packageRoot, "dist", "src"), { recursive: true }); mkdirSync(join(scripts, "AbletonMcpBridge"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.52" }));
  writeFileSync(join(packageRoot, "dist", "src", "lifecycle-cli.js"), "");
  const config = join(state, "bridge-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, server: { command: process.execPath, args: [join(packageRoot, "dist", "src", "cli.js"), "--config", config] } }));
  writeFileSync(join(scripts, "AbletonMcpBridge", "bridge-reference.json"), JSON.stringify({ config }));
  writeFileSync(join(home, "auth.json"), "{}");
  // Kumi's extension in Live, beside the bridge.
  const extensions = join(dir, "Ableton", "Extensions");
  mkdirSync(join(extensions, "kumi.kumi", "dist"), { recursive: true }); writeFileSync(join(extensions, "kumi.kumi", "manifest.json"), "{}");
  mkdirSync(join(dir, "Ableton", "Extensions Data", "kumi.kumi"), { recursive: true });
  return { home, extensions, env: { KUMI_HOME: home, KUMI_REMOTE_SCRIPTS_DIR: scripts, HOME: join(dir, "user"), KUMI_LIVE_EXTENSIONS_DIR: extensions } };
}

test("uninstall keeps the bridge's files while Live still loads the bridge from them, and takes them once it's out", async () => {
  if (process.platform === "win32") return; // Windows removes them a moment after Kumi exits.
  const dir = mkdtempSync(join(tmpdir(), "kumi-uninstall-bridge-"));
  try {
    // Kept in Live (said no, or Live open, or --yes with nobody to ask): its configuration and package stay.
    let kumi = withBridge(dir);
    const kept = out();
    assert.equal(await uninstallInstalled({ out: kept.stream, env: kumi.env, confirm: async (question) => !/bridge/i.test(question), liveRunning: async () => false }, { all: true, yes: true }), 0);
    assert.equal(existsSync(join(kumi.home, "bridge", "state", "bridge-config.json")), true, "the bridge in Live still has its configuration");
    assert.equal(existsSync(join(kumi.home, "bridge", "1.0.52-1")), true, "and its package");
    assert.equal(existsSync(join(kumi.home, "app")) || existsSync(join(kumi.home, "auth.json")), false, "everything else goes with --all");
    assert.match(kept.text(), /The bridge's files stay in .*bridge while Live uses it\./);
    assert.equal(existsSync(join(kumi.extensions, "kumi.kumi")), true, "Kumi's extension stays in Live with the bridge");
    assert.ok(kept.text().includes(`remove AbletonMcpBridge from Live's Remote Scripts folder, and kumi.kumi from ${kumi.extensions}`), "and how to take both out by hand is said");
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
    // Taken out of Live by its own uninstaller: its files go too.
    kumi = withBridge(dir);
    const ran: string[] = [];
    const gone = out();
    assert.equal(await uninstallInstalled({ out: gone.stream, env: kumi.env, confirm: async () => true, liveRunning: async () => false,
      run: async (_command, args) => { ran.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; } }, { all: false, yes: true }), 0);
    assert.ok(ran.some((line) => line.includes("uninstall")), "the bridge's own uninstaller ran");
    assert.equal(existsSync(join(kumi.extensions, "kumi.kumi")) || existsSync(join(kumi.extensions, "..", "Extensions Data", "kumi.kumi")), false, "Kumi's extension leaves Live with the bridge");
    assert.match(gone.text(), /The bridge and Kumi's extension are out of Live\./);
    assert.equal(existsSync(join(kumi.home, "bridge")), false);
    assert.equal(existsSync(join(kumi.home, "auth.json")), true, "the producer's files stay without --all");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall takes Kumi's PATH lines out of the startup files it wrote, zsh's ZDOTDIR too, and leaves a line someone put under the marker", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "kumi-uninstall-path-"));
  try {
    const home = join(dir, "home"); const user = join(dir, "user"); const zdot = join(dir, "zdot");
    for (const folder of [join(home, "app"), user, zdot]) mkdirSync(folder, { recursive: true });
    const line = `export PATH="${join(home, "bin")}:$PATH"`;
    writeFileSync(join(zdot, ".zshrc"), `alias ll='ls -l'\n\n${PATH_MARKER}\n${line}\n`);
    writeFileSync(join(user, ".profile"), `${PATH_MARKER}\nexport EDITOR=vim\n`);
    await uninstallInstalled({ out: out().stream, env: { KUMI_HOME: home, KUMI_REMOTE_SCRIPTS_DIR: join(dir, "none"), HOME: user, ZDOTDIR: zdot } }, { all: false, yes: true });
    assert.equal(readFileSync(join(zdot, ".zshrc"), "utf8"), "alias ll='ls -l'\n\n", "the marker and Kumi's line go");
    assert.equal(readFileSync(join(user, ".profile"), "utf8"), "export EDITOR=vim\n", "a line that isn't Kumi's stays");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no release to get is told apart from no network, so the advice fits", async () => {
  const env = { KUMI_RELEASES: "https://example.test/r" };
  assert.equal(await askRelease(env, (async () => new Response("Not Found", { status: 404 })) as typeof fetch), "none");
  assert.equal(await askRelease(env, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch), "offline");
  assert.equal(await askRelease(env, (async () => new Response("<html>", { status: 200 })) as typeof fetch), "invalid");
  await assert.rejects(checkRelease(env, (async () => new Response("", { status: 404 })) as typeof fetch), /There's no Kumi release to get at example\.test\/r yet/);
  const said = out();
  assert.equal(await updateInstalled({ out: said.stream, env: { ...env, KUMI_HOME: join(tmpdir(), "kumi-no-release") }, fetcher: (async () => new Response("", { status: 404 })) as typeof fetch }), 1);
  assert.match(said.text(), /There's no Kumi release to get/);
  assert.doesNotMatch(said.text(), /internet/);
});

test("a swap that fails partway puts everything back, the rollback copy included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-swap-"));
  try {
    const app = join(dir, "app"); const previous = join(dir, "app.previous");
    mkdirSync(app); writeFileSync(join(app, "v"), "2"); mkdirSync(previous); writeFileSync(join(previous, "v"), "1");
    await assert.rejects(swapIn(join(dir, "missing"), app, previous));
    assert.equal(readFileSync(join(app, "v"), "utf8"), "2"); assert.equal(readFileSync(join(previous, "v"), "utf8"), "1");
    // And one that works keeps the one before as the rollback copy.
    const fresh = join(dir, "app.new"); mkdirSync(fresh); writeFileSync(join(fresh, "v"), "3");
    await swapIn(fresh, app, previous);
    assert.equal(readFileSync(join(app, "v"), "utf8"), "3"); assert.equal(readFileSync(join(previous, "v"), "utf8"), "2");
    assert.equal(existsSync(`${previous}.old`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
