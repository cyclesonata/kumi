//! Compatibility with the install layout used before native releases.
use super::*;
/// The fallback is used only when the user explicitly rolls back to a JavaScript release.
pub fn launcher(windows: bool) -> &'static str {
    if windows {
        "@echo off\r\nif not defined KUMI_HOME set \"KUMI_HOME=%~dp0..\"\r\nset KUMI_INSTALLED=1\r\nif exist \"%KUMI_HOME%\\app\\kumi.exe\" goto native\r\n\"%KUMI_HOME%\\node\\node.exe\" \"%KUMI_HOME%\\app\\apps\\kumi\\bin\\kumi.mjs\" %*\r\nexit /b %errorlevel%\r\n:native\r\n\"%KUMI_HOME%\\app\\kumi.exe\" %*\r\nexit /b %errorlevel%\r\n"
    } else {
        "#!/bin/sh\nKUMI_HOME=\"${KUMI_HOME:-$(cd \"$(dirname \"$0\")/..\" && pwd)}\"\nexport KUMI_HOME KUMI_INSTALLED=1\nif [ -x \"$KUMI_HOME/app/kumi\" ]; then\n  exec \"$KUMI_HOME/app/kumi\" \"$@\"\nfi\nexec \"$KUMI_HOME/node/bin/node\" \"$KUMI_HOME/app/apps/kumi/bin/kumi.mjs\" \"$@\"\n"
    }
}
/// Repair the installed launcher only from its active app, never an update probe or checkout.
pub fn ensure_native_launcher(env: &Env, executable: &Path) -> std::io::Result<bool> {
    if env.get("KUMI_INSTALLED").is_none_or(|s| s != "1") {
        return Ok(false);
    }
    let home = kumi_home(env);
    let app = Path::new(&home).join("app");
    if app.canonicalize().ok().zip(executable.parent().and_then(|p| p.canonicalize().ok())).is_none_or(|(app, folder)| app != folder) {
        return Ok(false);
    }
    write_launcher(&home)?;
    Ok(true)
}
pub fn write_launcher(home: &str) -> std::io::Result<()> {
    write_launcher_for(home, cfg!(windows))
}

// The 1.7.4 installer launcher remains usable through the retained Node and the
// compatibility entry shipped in every native bundle, including after rollback.
const LEGACY_WINDOWS_LAUNCHER: &str = "@echo off\nrem Kumi's launcher, written by its installer: Kumi runs on its own Node, whatever Node this computer has.\nsetlocal\nfor %%I in (\"%~dp0..\") do set \"KUMI_HOME=%%~fI\"\nset \"KUMI_INSTALLED=1\"\n\"%KUMI_HOME%\\node\\node.exe\" \"%KUMI_HOME%\\app\\apps\\kumi\\bin\\kumi.mjs\" %*\n";

fn compatible_windows_launcher(current: &str, legacy_available: bool) -> bool {
    let current = current.replace("\r\n", "\n");
    let native = launcher(true).replace("\r\n", "\n");
    let current = current.trim_end_matches('\n');
    current == native.trim_end_matches('\n') || (legacy_available && current == LEGACY_WINDOWS_LAUNCHER.trim_end_matches('\n'))
}

fn write_launcher_for(home: &str, windows: bool) -> std::io::Result<()> {
    use std::io::Write;
    let home = Path::new(home);
    let path = home.join("bin").join(if windows { "kumi.cmd" } else { "kumi" });
    let contents = launcher(windows);
    if let Ok(current) = fs::read_to_string(&path) {
        if current == contents {
            return Ok(());
        }
        // cmd.exe resumes a batch file at its old byte offset when the child exits.
        // Replacing a working launcher, even just LF with CRLF, can execute a suffix
        // of the new file. Preserve both native line endings and the legacy entry.
        if windows {
            let legacy_available = home.join("node/node.exe").is_file() && home.join("app/apps/kumi/bin/kumi.mjs").is_file();
            if compatible_windows_launcher(&current, legacy_available) {
                return Ok(());
            }
        }
    }
    fs::create_dir_all(path.parent().unwrap())?;
    let temporary = path.with_extension(format!("new-{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o755);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_installer_and_native_windows_launcher_have_the_same_template() {
        let script = include_str!("../../../../install.ps1").replace("\r\n", "\n");
        let template = script.split_once("$launcher = @'\n").unwrap().1.split_once("\n'@").unwrap().0;
        assert_eq!(template.replace('\n', "\r\n") + "\r\n", launcher(true));
    }

    #[test]
    fn native_windows_launcher_keeps_its_bytes_with_each_installer_line_ending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bin/kumi.cmd");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for contents in [launcher(true).into(), launcher(true).replace("\r\n", "\n"), launcher(true).replace("\r\n", "\n") + "\r\n"] {
            fs::write(&path, &contents).unwrap();
            write_launcher_for(dir.path().to_str().unwrap(), true).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
    }

    #[test]
    fn legacy_windows_launcher_survives_first_start_update_and_rollback_while_its_entry_is_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bin/kumi.cmd");
        let node = dir.path().join("node/node.exe");
        let entry = dir.path().join("app/apps/kumi/bin/kumi.mjs");
        for file in [&path, &node, &entry] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
        }
        fs::write(&node, "retained node").unwrap();
        for contents in [
            LEGACY_WINDOWS_LAUNCHER.into(),
            LEGACY_WINDOWS_LAUNCHER.replace('\n', "\r\n"),
            LEGACY_WINDOWS_LAUNCHER.trim_end_matches('\n').to_string() + "\r\n",
        ] {
            fs::write(&path, &contents).unwrap();
            for app in ["native bootstrap", "updated native bootstrap", "legacy app after rollback"] {
                fs::write(&entry, app).unwrap();
                write_launcher_for(dir.path().to_str().unwrap(), true).unwrap();
                assert_eq!(fs::read_to_string(&path).unwrap(), contents);
            }
        }
        fs::remove_file(&node).unwrap();
        write_launcher_for(dir.path().to_str().unwrap(), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), launcher(true));
    }
}
/// Legacy probes require this file; native updates retain it so old rollback can return here.
pub fn legacy_entry(app: &str) -> String {
    join(app, "apps/kumi/bin/kumi.mjs")
}
pub fn has_app(app: &str) -> bool {
    Path::new(&join(app, &executable_name("kumi"))).is_file() || Path::new(&legacy_entry(app)).is_file()
}
/// Complete a receipt-bound bridge transition after the old updater's application swap.
pub async fn finish_legacy_transition(io: &InstalledIo) -> Result<(), RuntimeError> {
    let home = kumi_home(&io.env);
    let app = join(&home, "app");
    let native = fs::read(join(&app, "package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|metadata| metadata["runtime"] == "rust-native");
    if !native {
        return Ok(());
    }
    let Some(config) = find_bridge_config(&io.env) else { return Ok(()) };
    let Some(server) = read_bridge_server(&config).ok().filter(|s| !s.native()) else { return Ok(()) };
    let Some(bundled) = bridge_version(&app) else { return Ok(()) };
    if server.version.as_deref().is_none_or(|version| version != bundled && !newer_version(&bundled, version)) {
        return Ok(());
    }
    if live_open(io, io.run.clone().unwrap_or_else(default_run)).await {
        io.out.write("Kumi is now native. The bridge can switch after Live closes; chatting with the existing bridge for now.\n");
        return Ok(());
    }
    let mut setup = crate::bridge_setup::BridgeSetupIo::new(io.out.clone(), io.env.clone());
    setup.input = io.input.clone();
    setup.bridge_dir = Some(app.clone());
    setup.prepared = Some(join(&app, "bridge"));
    setup.yes = true;
    setup.wait_ms = Some(0);
    setup.run = io.run.clone();
    setup.live_running = io.live_running.clone();
    if crate::bridge_setup::setup_bridge(setup).await? != 0 {
        io.out.write("Kumi can still open. To finish switching the bridge, close Live and run: kumi bridge\n");
    }
    Ok(())
}

pub(super) struct BridgeRollback {
    command: String,
    args: Vec<String>,
    run: Run,
}
impl BridgeRollback {
    pub(super) async fn apply(&self) -> Result<(), RuntimeError> {
        let result = (self.run)(self.command.clone(), self.args.clone(), None).await;
        crate::bridge_setup::lifecycle_answer(result).map(|_| ()).map_err(RuntimeError::plain)
    }
}
pub(super) async fn prepare_legacy_rollback(io: &InstalledIo, home: &str) -> Result<Option<BridgeRollback>, RuntimeError> {
    let Some(config) = find_bridge_config(&io.env) else { return Ok(None) };
    let server = read_bridge_server(&config)?;
    if !server.native() {
        return Ok(None);
    }
    let package = server.package_root().ok_or_else(|| RuntimeError::plain("The bridge's package could not be found."))?;
    let Some((state, secret, scripts)) = crate::bridge_setup::owner_paths(&config, &package, home) else {
        return Err(RuntimeError::plain(
            "The earlier Kumi needs its JavaScript bridge, but its owner receipt could not be found. Nothing was changed.",
        ));
    };
    let receipt: Value = serde_json::from_slice(&fs::read(join(&state, "install-receipt.json")).map_err(error)?).map_err(error)?;
    let previous = receipt["previous"]["packageRoot"].as_str().filter(|path| Path::new(path).is_absolute());
    let schema = |root: &str| {
        fs::read(join(root, "release-manifest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value["schema"].as_str().map(str::to_string))
    };
    if schema(&package).as_deref() != Some("ableton-mcp-native-release/v1")
        || !previous.and_then(schema).is_some_and(|schema| matches!(schema.as_str(), "ableton-mcp-release/v1" | "ableton-mcp-release/v2"))
    {
        return Err(RuntimeError::plain(
            "The earlier Kumi needs its JavaScript bridge, but no retained JavaScript bridge generation is available. Nothing was changed.",
        ));
    }
    let run = io.run.clone().unwrap_or_else(default_run);
    if live_open(io, run.clone()).await {
        return Err(RuntimeError::plain("Quit Live (save your work first), then run: kumi update --rollback. Restoring this Kumi also restores its previous bridge; nothing was changed."));
    }
    let args = vec![
        "lifecycle".into(),
        "rollback".into(),
        "--package-root".into(),
        package,
        "--state-dir".into(),
        state,
        "--config".into(),
        config,
        "--secret".into(),
        secret,
        "--remote-scripts-dir".into(),
        scripts,
        "--apply".into(),
        "--confirm-live-stopped".into(),
    ];
    Ok(Some(BridgeRollback { command: server.command.unwrap(), args, run }))
}
