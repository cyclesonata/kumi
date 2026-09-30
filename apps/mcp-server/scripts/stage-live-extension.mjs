// Stages Kumi's Live extension (apps/live-extension, its committed build) into the bridge package, so
// an installed bridge carries the extension it starts in Live's Extension Host.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "..", "live-extension");
const destination = join(packageRoot, "live-extension");
const bundle = join(source, "dist", "extension.js");
const [recorded] = readFileSync(join(source, "dist", "extension.js.sha256"), "utf8").split(/\s+/);
if (createHash("sha256").update(readFileSync(bundle)).digest("hex") !== recorded) throw new Error("apps/live-extension/dist/extension.js doesn't match its checksum; rebuild it (node apps/live-extension/build.mjs)");
rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, "dist"), { recursive: true });
copyFileSync(join(source, "manifest.json"), join(destination, "manifest.json"));
copyFileSync(bundle, join(destination, "dist", "extension.js"));
copyFileSync(join(source, "dist", "extension.js.sha256"), join(destination, "dist", "extension.js.sha256"));
// Live's Extension Host wants a package.json beside the manifest; the development one's tooling isn't needed.
const extensionPackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
writeFileSync(join(destination, "package.json"), `${JSON.stringify({ name: extensionPackage.name, version: extensionPackage.version, private: true, license: extensionPackage.license, main: "dist/extension.js" }, null, 2)}\n`);
