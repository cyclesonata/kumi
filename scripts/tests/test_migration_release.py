"""Real legacy-updater probes against native fixture programs; no publication or user files."""
import hashlib
import functools
import http.server
import threading
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

    @unittest.skipIf(os.name == "nt", "Unix installer; Windows PowerShell runs in the installer workflow")
    def test_fresh_unix_installer_uses_native_target_without_node_and_preserves_repair_rollback(self):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.out)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            home = self.root / "fresh home"
            env = dict(os.environ, KUMI_HOME=str(home), KUMI_RELEASES=f"http://127.0.0.1:{server.server_port}",
                       KUMI_NO_MODIFY_PATH="1", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
            for iteration in range(2):
                run = subprocess.run(["sh", str(release.native.ROOT / "install.sh")], env=env, capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertFalse((home / "node").exists())
                result = subprocess.run([str(home / "bin/kumi"), "--version"], env=env, capture_output=True, text=True)
                self.assertEqual(result.stdout, "Kumi 99.0.0\n")
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((home / "app.previous" / self.binary).is_file())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_npm_command_with_cargo_builds_this_checkout_and_forwards_arguments(self):
        tools = self.root / "tools"
        tools.mkdir()
        fixture = self.root / "cargo.rs"
        fixture.write_text('''use std::{env,fs::OpenOptions,io::Write}; fn main() { let args: Vec<_> = env::args().skip(1).collect(); let mut file = OpenOptions::new().create(true).append(true).open(env::var("KUMI_SHIM_LOG").unwrap()).unwrap(); writeln!(file,"{}",args.join("|" )).unwrap(); if args.first().map(String::as_str)==Some("run") { println!("checkout native fixture"); assert!(env::var("KUMI_INSTALLED").is_err()); } }''')
        cargo = tools / ("cargo.exe" if os.name == "nt" else "cargo")
        subprocess.run(["rustc", str(fixture), "-C", "debuginfo=0", "-o", str(cargo)], check=True)
        log = self.root / "cargo.log"
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"], KUMI_SHIM_LOG=str(log), KUMI_INSTALLED="1")
        env.pop("KUMI_REFERENCE_RUNTIME", None)
        result = subprocess.run(["node", str(release.native.ROOT / "scripts/native-kumi.mjs"), "--model", "a model with spaces"], env=env, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checkout native fixture", result.stdout)
        self.assertEqual(log.read_text().splitlines(), ["--version", "build|--quiet|--release|--locked|--workspace|--bins", "run|--quiet|--release|--locked|-p|kumi|--|--model|a model with spaces"])

    def test_reference_switch_is_confined_to_npm_shim_and_skips_native_acquisition(self):
        checkout = self.root / "reference checkout"
        (checkout / "scripts").mkdir(parents=True)
        shutil.copyfile(release.native.ROOT / "scripts/native-kumi.mjs", checkout / "scripts/native-kumi.mjs")
        entry = checkout / "apps/kumi/bin/kumi.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('reference fixture: ' + process.argv.slice(2).join('|'))")
        result = subprocess.run(["node", str(checkout / "scripts/native-kumi.mjs"), "--help"], env=dict(os.environ, KUMI_REFERENCE_RUNTIME="1"), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "reference fixture: --help\n")

    @unittest.skipIf(os.name == "nt", "PowerShell acquisition is exercised by installer CI")
    def test_npm_only_handoff_installs_native_without_rust_or_moving_credentials(self):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.out)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            home = self.root / "npm-only home"
            home.mkdir()
            (home / "auth.json").write_text('{"version":1,"credentials":{"fixture":"unchanged"}}')
            env = dict(os.environ, KUMI_HOME=str(home), KUMI_RELEASES=f"http://127.0.0.1:{server.server_port}",
                       KUMI_NO_MODIFY_PATH="1", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
            env.pop("KUMI_REFERENCE_RUNTIME", None)
            result = subprocess.run([shutil.which("node"), str(release.native.ROOT / "scripts/native-kumi.mjs"), "--setup"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("switching this npm installation to the native release", result.stdout)
            self.assertEqual((home / "auth.json").read_text(), '{"version":1,"credentials":{"fixture":"unchanged"}}')
            result = subprocess.run([shutil.which("node"), str(release.native.ROOT / "scripts/native-kumi.mjs"), "argument with spaces"], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "native fixture: argument with spaces\n")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @unittest.skipUnless(os.environ.get("KUMI_NATIVE_RELEASES"), "built release interoperability runs in installer CI")
    def test_actual_built_release_with_authoritative_old_updater(self):
        reference = Path(os.environ.get("KUMI_TS_REFERENCE", release.native.ROOT)) / "apps/kumi/dist/src/install.js"
        artifacts = Path(os.environ["KUMI_NATIVE_RELEASES"])
        manifest = json.loads((artifacts / "kumi-release.json").read_text())
        # Pending final integration: old 1.7.4 updaters ignore same-version application releases.
        self.assertGreater(tuple(map(int, manifest["kumi"].split("-")[0].split("."))), (1, 7, 4),
                           "the native transition must publish a newer application version than legacy 1.7.4")
        home = self.root / "production home"
        entry = home / "app/apps/kumi/bin/kumi.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('legacy fixture entry')")
        (home / "app/package.json").write_text('{"version":"0.0.1"}')
        (home / "auth.json").write_text('{"version":1,"credentials":{}}')
        test = self.root / "built-updater.mjs"
        test.write_text('''import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {updateInstalled} = await import(pathToFileURL(process.argv[2]));
const release = JSON.parse(readFileSync(process.argv[3] + '/kumi-release.json'));
const env = {KUMI_HOME:process.argv[4], KUMI_RELEASES:'https://fixture.invalid', KUMI_REMOTE_SCRIPTS_DIR:process.argv[4]+'/absent'};
const io = {env, out:process.stdout, fetcher: async url => new Response(url.endsWith('.json') ? JSON.stringify(release) : readFileSync(process.argv[3] + '/' + release.bundle))};
if (await updateInstalled(io) !== 0) throw new Error('old updater failed');
''')
        result = subprocess.run(["node", str(test), str(reference), str(artifacts), str(home)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((home / "app" / self.binary).is_file(), result.stdout)
        result = subprocess.run([str(home / "app" / self.binary), "--version"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(manifest["kumi"], result.stdout)
        self.assertEqual((home / "auth.json").read_text(), '{"version":1,"credentials":{}}')
        self.assertEqual((home / "app.previous/apps/kumi/bin/kumi.mjs").read_text(), "console.log('legacy fixture entry')")

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
