"""Real legacy-updater probes against native fixture programs; no publication or user files."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("migration_release", Path(__file__).parents[1] / "build-migration-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

class MigrationRelease(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="kumi-migration-test-")
        self.root = Path(self.directory.name)
        arch = {"arm64": "aarch64", "aarch64": "aarch64", "AMD64": "x86_64", "x86_64": "x86_64"}[platform.machine()]
        system = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu", "Windows": "pc-windows-msvc"}[platform.system()]
        self.target = f"{arch}-{system}"
        self.node = subprocess.check_output(["node", "-p", "process.versions.node"], text=True).strip()
        stage = self.root / "stage"
        stage.mkdir()
        self.binary = "kumi.exe" if os.name == "nt" else "kumi"
        source = self.root / "fixture.rs"
        source.write_text('fn main() { let args: Vec<_> = std::env::args().skip(1).collect(); if args == ["--version"] {println!("Kumi 99.0.0")} else {println!("native fixture: {}", args.join("|"));} }')
        subprocess.run(["rustc", str(source), "-C", "debuginfo=0", "-o", str(stage / self.binary)], check=True)
        (stage / "package.json").write_text(json.dumps({"version":"99.0.0", "bridge":"1.0.73", "runtime":"rust-native"}))
        bundle = f"kumi-{self.target}.tar.gz"
        digest = release.native.archive(stage, self.root / bundle, "", 0)
        self.manifest = self.root / "kumi-release.json"
        self.manifest.write_text(json.dumps({"kumi":"99.0.0", "bridge":"1.0.73", "runtime":"rust-native", "target":self.target, "bundle":bundle, "sha256":digest}))
        self.out = self.root / "release"
        self.index = release.build([self.manifest], self.out, self.node)

    def tearDown(self):
        self.directory.cleanup()

    def unpack(self, folder):
        folder.mkdir(parents=True)
        with tarfile.open(self.out / "kumi.tar.gz") as archive:
            archive.extractall(folder, filter="data")
        return folder / "apps/kumi/bin/kumi.mjs"

    def test_index_and_archive_are_bound_and_old_probe_materializes_native_once(self):
        self.assertEqual(release.native.digest(self.out / "kumi.tar.gz"), self.index["sha256"])
        self.assertEqual(self.index["node"], self.node)
        self.assertEqual(json.loads((self.out / f"kumi-release-{self.target}.json").read_text()), self.index["targets"][self.target])
        app = self.root / "app.new"
        entry = self.unpack(app)
        first = subprocess.run(["node", str(entry), "--version"], capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, "Kumi 99.0.0\n")
        self.assertTrue((app / self.binary).is_file())
        self.assertFalse((app / "native").exists())
        again = subprocess.run(["node", str(entry), "argument with spaces", "--model=example"], capture_output=True, text=True)
        self.assertEqual(again.stdout, "native fixture: argument with spaces|--model=example\n")
        self.assertEqual(again.returncode, 0, again.stderr)

    def test_checksum_failure_keeps_unstaged_app_and_aggregator_rejects_tampered_input(self):
        app = self.root / "app.new"
        entry = self.unpack(app)
        archive = next((app / "native").iterdir())
        archive.write_bytes(b"tampered")
        result = subprocess.run(["node", str(entry), "--version"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("checksum", result.stderr)
        self.assertFalse((app / self.binary).exists())
        original = json.loads(self.manifest.read_text())
        (self.manifest.parent / original["bundle"]).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum"):
            release.build([self.manifest], self.out, self.node)

    def test_actual_source_installed_updater_swaps_after_native_probe_and_retains_user_data(self):
        reference = Path(os.environ.get("KUMI_TS_REFERENCE", release.native.ROOT)) / "apps/kumi/dist/src/install.js"
        if not reference.exists():
            self.skipTest("build the authoritative TypeScript reference or set KUMI_TS_REFERENCE")
        home = self.root / "home"
        entry = home / "app/apps/kumi/bin/kumi.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('legacy Kumi')")
        (home / "app/package.json").write_text('{"version":"1.7.4"}')
        markers = ["settings.json", "auth.json", "history.json", "library/catalog.json", "conversations/session.json", "memory/producer.json"]
        for name in markers:
            file = home / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(f"unchanged {name}")
        test = self.root / "old-updater.mjs"
        test.write_text('''import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {updateInstalled, rollbackInstalled} = await import(pathToFileURL(process.argv[2]));
const manifest = JSON.parse(readFileSync(process.argv[3] + '/kumi-release.json'));
const env = {KUMI_HOME:process.argv[4], KUMI_RELEASES:'https://fixture.invalid', KUMI_REMOTE_SCRIPTS_DIR:process.argv[4]+'/absent'};
const io = {env, out:process.stdout, fetcher: async url => new Response(url.endsWith('.json') ? JSON.stringify(manifest) : readFileSync(process.argv[3] + '/' + manifest.bundle))};
if (await updateInstalled(io) !== 0) throw new Error('old update failed');
if (await rollbackInstalled(io) !== 0) throw new Error('old rollback failed');
if (await rollbackInstalled(io) !== 0) throw new Error('old return-to-native failed');
''')
        completed = subprocess.run(["node", str(test), str(reference), str(self.out), str(home)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("Kumi is now 99.0.0", completed.stdout)
        self.assertTrue((home / "app" / self.binary).exists())
        self.assertEqual((home / "app.previous/apps/kumi/bin/kumi.mjs").read_text(), "console.log('legacy Kumi')")
        for name in markers:
            self.assertEqual((home / name).read_text(), f"unchanged {name}")

if __name__ == '__main__':
    unittest.main()
