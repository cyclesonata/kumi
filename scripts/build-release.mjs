#!/usr/bin/env node
/**
 * Builds what the installer downloads: release/kumi.tar.gz (Kumi, ready to run with Kumi's own Node),
 * release/kumi-release.json (its version, checksum and the Node it runs on) and release/SHA256SUMS.
 * Run on Node 24 after `npm run setup`: `node scripts/build-release.mjs`.
 *
 * The bundle keeps the repository's layout (apps/kumi, packages/runtime, apps/mcp-server), because Kumi
 * finds its bridge and workers by paths relative to its own files. It holds production dependencies only,
 * no symlinks (Windows' tar can't make them), and the bridge already packed and installed under bridge/,
 * so `kumi bridge` needs no npm.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const stage = join(out, "stage");
const say = (line) => process.stdout.write(`${line}\n`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" }, shell: process.platform === "win32" && command === npm }).toString();
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error(`Build releases on Node 24 (this is ${process.version}): the bundle names the Node it was built and tested with.`);
const version = json(join(root, "package.json")).version;
const bridgeVersion = json(join(root, "apps", "mcp-server", "package.json")).version;
for (const built of ["apps/kumi/dist/src/cli.js", "packages/runtime/dist/src/index.js", "apps/mcp-server/dist/src/cli.js"]) {
  if (!existsSync(join(root, built))) throw new Error(`${built} is missing: run npm run setup first.`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const copy = (from, to = from, filter) => cpSync(join(root, from), join(stage, to), { recursive: true, ...(filter ? { filter } : {}) });
const noTests = (source) => !/[\\/]dist[\\/]test([\\/]|$)/.test(source) && !source.endsWith(".map");

say(`Kumi ${version}, bridge ${bridgeVersion}, Node ${process.versions.node}`);
for (const file of ["package.json", "package-lock.json", "LICENSE.md", "README.md", "CHANGELOG.md"]) copy(file);
copy("apps/kumi/package.json"); copy("apps/kumi/bin"); copy("apps/kumi/dist", "apps/kumi/dist", noTests);
copy("packages/runtime/package.json"); copy("packages/runtime/dist", "packages/runtime/dist", noTests);
copy("apps/mcp-server/package.json"); copy("apps/mcp-server/package-lock.json"); copy("apps/mcp-server/dist", "apps/mcp-server/dist", noTests);
// The bridge Kumi runs from its own tree reads Live's operations from protocol/, with the app as its working folder.
copy("protocol");
// Kumi's Live extension, which that bridge starts in Live's Extension Host: its committed build only.
for (const file of ["manifest.json", "dist/extension.js", "dist/extension.js.sha256"]) copy(`apps/live-extension/${file}`);
const extensionPackage = json(join(root, "apps", "live-extension", "package.json"));
writeFileSync(join(stage, "apps", "live-extension", "package.json"), `${JSON.stringify({ name: extensionPackage.name, version: extensionPackage.version, private: true, license: extensionPackage.license, main: "dist/extension.js" }, null, 2)}\n`);

say("Production dependencies…");
sh(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], stage);
sh(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], join(stage, "apps", "mcp-server"));
// npm links workspaces with symlinks; the app only needs @kumi/runtime, as a small package that points at
// packages/runtime (so the runtime's own paths, relative to its files, still hold).
rmSync(join(stage, "node_modules", "@kumi"), { recursive: true, force: true });
mkdirSync(join(stage, "node_modules", "@kumi", "runtime"), { recursive: true });
writeFileSync(join(stage, "node_modules", "@kumi", "runtime", "package.json"), `${JSON.stringify({ name: "@kumi/runtime", version, type: "module", exports: { ".": "./index.js" } }, null, 2)}\n`);
writeFileSync(join(stage, "node_modules", "@kumi", "runtime", "index.js"), 'export * from "../../../packages/runtime/dist/src/index.js";\n');

say("The bridge, packed and installed…");
const bridge = join(stage, "bridge");
mkdirSync(join(bridge, "package"), { recursive: true });
const packed = sh(npm, ["pack", "--pack-destination", bridge, "--silent"], join(root, "apps", "mcp-server")).trim().split("\n").filter(Boolean).at(-1);
if (!packed || !existsSync(join(bridge, packed))) throw new Error("npm pack didn't produce the bridge's package");
sh(npm, ["install", "--prefix", join(bridge, "package"), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", join(bridge, packed)], bridge);
const artifactSha = createHash("sha256").update(readFileSync(join(bridge, packed))).digest("hex");
writeFileSync(join(bridge, "prepared.json"), `${JSON.stringify({ artifact: packed, sha256: artifactSha, version: bridgeVersion }, null, 2)}\n`);

// No symlinks and no npm shims: .bin folders are only for running packages' commands, which Kumi doesn't.
const walk = (dir, visit) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); visit(path); if (existsSync(path) && lstatSync(path).isDirectory()) walk(path, visit); } };
walk(stage, (path) => { if (/[\\/]node_modules[\\/]\.bin$/.test(path)) rmSync(path, { recursive: true, force: true }); });
const links = []; walk(stage, (path) => { if (lstatSync(path).isSymbolicLink()) links.push(relative(stage, path)); });
if (links.length) throw new Error(`the bundle can't hold symlinks: ${links.slice(0, 5).join(", ")}`);
writeFileSync(join(stage, "kumi-install.json"), `${JSON.stringify({ kumi: version, node: process.versions.node, bridge: bridgeVersion }, null, 2)}\n`);

say("Packing…");
const bundle = join(out, "kumi.tar.gz");
sh("tar", ["-czf", bundle, "-C", stage, "."], root);
const sha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
const manifest = { kumi: version, bundle: "kumi.tar.gz", sha256, node: process.versions.node, bridge: bridgeVersion };
writeFileSync(join(out, "kumi-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, "SHA256SUMS"), `${sha256}  kumi.tar.gz\n`);
rmSync(stage, { recursive: true, force: true });
say(`release/kumi.tar.gz ${(readFileSync(bundle).length / 1e6).toFixed(1)} MB  sha256 ${sha256}`);
