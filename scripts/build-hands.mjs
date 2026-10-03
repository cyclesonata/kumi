#!/usr/bin/env node
/**
 * Builds Kumi's Mac helper (its hands: Live's menus and keys through Accessibility) for the release to carry,
 * so producers without Xcode's tools have it: one universal binary (Apple silicon and Intel, macOS 13 on),
 * signed ad hoc, at packages/runtime/hands/kumi-hands-<source digest>. Run on a Mac after `npm run setup`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Kumi's Mac helper builds on a Mac.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { MAC_SOURCE } = await import(join(root, "packages/runtime/dist/src/hands/mac.js"));
const digest = createHash("sha256").update(MAC_SOURCE).digest("hex").slice(0, 12);
const work = mkdtempSync(join(tmpdir(), "kumi-hands-"));
try {
  const source = join(work, "KumiHands.swift");
  writeFileSync(source, MAC_SOURCE);
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const out = join(work, arch);
    execFileSync("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos13`, "-o", out, source], { stdio: "inherit" });
    slices.push(out);
  }
  const folder = join(root, "packages", "runtime", "hands");
  mkdirSync(folder, { recursive: true });
  const target = join(folder, `kumi-hands-${digest}`);
  execFileSync("lipo", ["-create", "-output", target, ...slices], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
  process.stdout.write(`${target}\n`);
} finally { rmSync(work, { recursive: true, force: true }); }
