"""Native artifact inventory, binding, reproducibility and reference documentation checks."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("native_release", Path(__file__).parents[1] / "build-native-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

class NativeRelease(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="kumi-native-release-test-")
        self.root = Path(self.folder.name)
        self.binaries = self.root / "binaries"
        self.binaries.mkdir()
        for name in release.BINARIES:
            (self.binaries / name).write_bytes(b"\x7fELF fixture " + name.encode())
        self.source = {"commit": "a" * 40, "commitTimestamp": "2026-10-01T12:00:00+00:00", "dirty": True}
        self.builder = {"rustc": "rustc fixture", "cargo": "cargo fixture", "platform": "linux", "architecture": "x64",
            "runnerImage": "test", "runnerImageVersion": "test", "cargoLockSha256": "b" * 64, "workflowSha256": "c" * 64}

    def tearDown(self):
        self.folder.cleanup()

    def build(self, out):
        return release.build_release(release.ROOT, self.binaries, out, "x86_64-unknown-linux-gnu", self.source,
                                     self.builder, "test fixture payload (not a compiled runtime)")

    def test_native_bundle_has_exact_manifest_bound_bridge_and_no_node_runtime(self):
        out = self.root / "release"
        result = self.build(out)
        archive = out / result["bundle"]
        self.assertEqual(release.digest(archive), result["sha256"])
        self.assertEqual(result["runtime"], "rust-native")
        self.assertNotIn("node", result)
        with tarfile.open(archive) as tar:
            self.assertTrue(all(member.isfile() for member in tar.getmembers()))
            names = tar.getnames()
            self.assertTrue(all(binary in names for binary in release.BINARIES))
            self.assertIn("apps/kumi/bin/kumi.mjs", names)
            self.assertEqual(json.load(tar.extractfile("apps/mcp-server/package.json"))["version"], result["bridge"])
            self.assertFalse(any("node_modules" in name or name.startswith("node/") for name in names))
            prepared = json.load(tar.extractfile("bridge/prepared.json"))
            artifact = tar.extractfile("bridge/" + prepared["artifact"]).read()
            self.assertEqual(hashlib.sha256(artifact).hexdigest(), prepared["sha256"])
            manifest = json.load(tar.extractfile("bridge/package/release-manifest.json"))
            self.assertEqual(manifest["schema"], "ableton-mcp-native-release/v1")
            self.assertEqual(manifest["source"], self.source)
            self.assertEqual(manifest["build"]["builder"], self.builder)
            self.assertEqual(manifest["build"]["runtime"], "rust-native")
            self.assertEqual(manifest["roles"]["ableton-mcp-server"], "native-runtime")
            self.assertEqual(manifest["roles"]["ableton-mcp-analysis-worker"], "native-runtime")
            package = json.load(tar.extractfile("bridge/package/package.json"))
            self.assertEqual(package["bin"], {binary: binary for binary in release.BRIDGE_BINARIES})
            self.assertNotIn("compiled-runtime", manifest["roles"].values())
            self.assertEqual(manifest["files"]["LICENSE.md"], release.MIT_SHA256)
            self.assertEqual(set(manifest["files"]), set(manifest["roles"]))
            self.assertNotIn("release-manifest.json", manifest["files"])
            self.assertGreaterEqual(len(manifest["files"]), 10)
            # This is the canonical JSON hash from the TypeScript registry hasher.
            self.assertEqual(manifest["protocol"]["registryHash"], "ec05dd401ec098adb77da1c185aff1857be2bd87859afe9dda4bfeb14e04aa57")
            self.assertEqual(manifest["distribution"], {"channel": "local-native-tarball", "published": False,
                "signed": False, "notarized": False, "integrityIsIdentityProof": False})
            for name, digest in manifest["files"].items():
                self.assertEqual(hashlib.sha256(tar.extractfile("bridge/package/" + name).read()).hexdigest(), digest)
            import io
            with tarfile.open(fileobj=io.BytesIO(artifact)) as bridge:
                expected = {"package/" + name for name in manifest["files"]} | {"package/release-manifest.json"}
                self.assertEqual(set(bridge.getnames()), expected)
                self.assertTrue(all(member.isfile() and not member.pax_headers for member in bridge.getmembers()))
                for binary in release.BRIDGE_BINARIES:
                    self.assertEqual(bridge.getmember("package/" + binary).mode, 0o755)
                for member in bridge.getmembers():
                    self.assertEqual(bridge.extractfile(member).read(), tar.extractfile("bridge/" + member.name).read())
        self.assertTrue(gzip.decompress(artifact).endswith(b"\0" * 1024))

    def test_archive_is_reproducible_and_failed_rebuild_preserves_previous_bundle(self):
        out = self.root / "release"
        result = self.build(out)
        first = (out / result["bundle"]).read_bytes()
        self.assertEqual(self.build(out), result)
        self.assertEqual((out / result["bundle"]).read_bytes(), first)
        (self.binaries / "kumi-harness").unlink()
        with self.assertRaises(ValueError):
            self.build(out)
        self.assertEqual((out / result["bundle"]).read_bytes(), first)
        self.assertFalse(list(out.glob("kumi-native-stage-*")))

    def test_bridge_only_requires_analysis_worker_and_supports_windows_names(self):
        (self.binaries / "ableton-mcp-analysis-worker").unlink()
        with self.assertRaises(ValueError):
            release.build_release(release.ROOT, self.binaries, self.root / "missing", "x86_64-unknown-linux-gnu",
                                  self.source, self.builder, "fixture", bridge_only=True)
        for name in release.BRIDGE_BINARIES:
            (self.binaries / (name + ".exe")).write_bytes(b"MZ fixture " + name.encode())
        out = self.root / "windows"
        result = release.build_release(release.ROOT, self.binaries, out, "x86_64-pc-windows-msvc",
                                       self.source, self.builder, "fixture", bridge_only=True)
        with tarfile.open(out / result["artifact"]) as archive:
            package = json.load(archive.extractfile("package/package.json"))
            for name in release.BRIDGE_BINARIES:
                self.assertEqual(package["bin"][name], name + ".exe")
                self.assertEqual(result["manifest"]["roles"][name + ".exe"], "native-runtime")
                self.assertEqual(archive.getmember("package/" + name + ".exe").mode, 0o755)

    def test_manifest_rejects_unknown_roles_and_linked_payloads(self):
        with self.assertRaises(ValueError):
            release.role("local-state/auth.json")
        with self.assertRaises(ValueError):
            release.role("dist/src/cli.js")
        source = self.root / "payload"
        source.mkdir()
        (source / "file").write_text("content")
        try:
            (source / "link").symlink_to(source / "file")
        except OSError:
            self.skipTest("this Windows user cannot create symlinks")
        with self.assertRaises(ValueError):
            release.inventory(source)
        with self.assertRaises(ValueError):
            release.copy(source / "link", self.root / "copied")

    def test_all_packaged_documents_match_the_source_rewrite(self):
        oracle = json.loads((Path(__file__).parent / "native-release-doc-oracle.json").read_text())
        for source, expected in oracle["docs"].items():
            text = (release.ROOT / source).read_text(encoding="utf-8")
            actual = release.transform_document(text, release.ROOT, source, oracle["revision"])
            self.assertEqual(hashlib.sha256(actual.encode()).hexdigest(), expected, source)
        for target in ("../../../../outside", "/absolute", "C:/user", "a\\b", "x\0y"):
            with self.assertRaises(ValueError):
                release.document_target(release.ROOT, "docs/en/test.md", target, oracle["revision"], "href")

if __name__ == "__main__":
    unittest.main()
