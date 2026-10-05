//! Live, the app: which one is open, asking it to quit the way its own menu does (unsaved work makes
//! it ask to save first), and opening it again.

use crate::bridge_setup::{is_live_running_on, Run};
use kumi_common::abort::Signal;
use kumi_runtime::system::{self, Env, SystemProgram};
use std::time::Duration;

/// The Live that's open: its app, a `.app` on macOS and an `.exe` on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenLive {
    pub app: String,
}

/// "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live", as `ps` names it, is that app.
pub fn live_app_of(line: &str) -> Option<OpenLive> {
    let app = line.trim().strip_suffix("/Contents/MacOS/Live")?;
    app.ends_with(".app").then(|| OpenLive { app: app.into() })
}

fn powershell(env: &Env, platform: &str) -> String {
    system::system_program(SystemProgram::Powershell, env, platform)
}
fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| word.to_string()).collect()
}
/// A PowerShell single-quoted string.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Which Live is open, if one is.
pub async fn open_live(run: &Run, platform: &str, env: &Env) -> Option<OpenLive> {
    match platform {
        "darwin" => run("ps".into(), args(&["-axo", "comm="]), None).await.stdout.lines().find_map(live_app_of),
        "win32" => {
            let path = "Get-Process -Name 'Ableton Live*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path";
            let ran = run(powershell(env, platform), args(&["-NoProfile", "-NonInteractive", "-Command", path]), None).await;
            let app = ran.stdout.trim();
            (!app.is_empty()).then(|| OpenLive { app: app.into() })
        }
        _ => None,
    }
}

/// Ask Live to quit, as its own menu does: with unsaved work it asks the producer to save first. This
/// returns at once, not when Live has answered: the producer may still be deciding about saving.
pub async fn ask_to_quit(run: &Run, platform: &str, env: &Env) {
    match platform {
        "darwin" => {
            // Without `ignoring application responses`, osascript waits for Live's answer, which comes
            // only once the save dialog is answered (or after AppleScript's two-minute timeout).
            let quit = ["ignoring application responses", "tell application id \"com.ableton.live\" to quit", "end ignoring"];
            run("osascript".into(), args(&["-e", quit[0], "-e", quit[1], "-e", quit[2]]), None).await;
        }
        "win32" => {
            let close = "Get-Process -Name 'Ableton Live*' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }";
            run(powershell(env, platform), args(&["-NoProfile", "-NonInteractive", "-Command", close]), None).await;
        }
        _ => {}
    }
}

/// Wait until Live has closed: true once it has, false when `stop` comes first.
pub async fn closed(run: &Run, platform: &str, env: &Env, stop: &Signal) -> bool {
    loop {
        if !is_live_running_on(run.clone(), platform, env).await {
            return true;
        }
        if stop.is_cancelled() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            _ = stop.cancelled() => return false,
        }
    }
}

/// Open Live: the app that was open before, or else the newest one installed.
pub async fn start(run: &Run, platform: &str, env: &Env, app: Option<&str>) -> bool {
    match platform {
        "darwin" => {
            let target = match app {
                Some(app) => args(&[app]),
                None => args(&["-b", "com.ableton.live"]),
            };
            run("open".into(), target, None).await.code == 0
        }
        "win32" => {
            let found = "Get-ChildItem -Path (Join-Path $env:ProgramData 'Ableton\\Live*\\Program\\Ableton Live*.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName";
            let app = app.map(quoted).unwrap_or_else(|| format!("({found})"));
            let script = format!("$app = {app}; if ($app) {{ Start-Process -FilePath $app; 'started' }}");
            run(powershell(env, platform), args(&["-NoProfile", "-NonInteractive", "-Command", &script]), None)
                .await
                .stdout
                .contains("started")
        }
        _ => false,
    }
}

/// "12.4" from a version such as "12.4.15b5" or "12.4b15": its first two numbers.
pub fn major_minor(version: &str) -> Option<String> {
    let mut parts = version.trim().split(|c: char| !c.is_ascii_digit());
    let major = parts.next().filter(|p| !p.is_empty())?;
    let minor = parts.next().filter(|p| !p.is_empty());
    Some(minor.map(|minor| format!("{major}.{minor}")).unwrap_or_else(|| major.into()))
}

/// Live's version ("12.4"), read from its app: `app`, or else the Live that's open.
pub async fn version(run: &Run, platform: &str, env: &Env, app: Option<&str>) -> Option<String> {
    let app = match app {
        Some(app) => app.to_string(),
        None => open_live(run, platform, env).await?.app,
    };
    let read = match platform {
        "darwin" => run("defaults".into(), args(&["read", &format!("{app}/Contents/Info"), "CFBundleShortVersionString"]), None).await,
        "win32" => {
            let script = format!("(Get-Item -LiteralPath {}).VersionInfo.ProductVersion", quoted(&app));
            run(powershell(env, platform), args(&["-NoProfile", "-NonInteractive", "-Command", &script]), None).await
        }
        _ => return None,
    };
    (read.code == 0).then(|| major_minor(&read.stdout)).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge_setup::Ran;
    use futures::FutureExt;
    use std::{cell::RefCell, rc::Rc};

    #[test]
    fn the_open_live_is_named_by_its_app() {
        assert_eq!(
            live_app_of("/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live"),
            Some(OpenLive { app: "/Applications/Ableton Live 12 Suite.app".into() })
        );
        for other in ["/Applications/Ableton Live 12 Suite.app/Contents/Helpers/ExtensionHost/node", "/usr/bin/Live", ""] {
            assert_eq!(live_app_of(other), None, "{other}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn live_is_found_quit_waited_for_and_opened_again() {
        let calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let running = Rc::new(RefCell::new(2u32));
        let run: Run = {
            let calls = calls.clone();
            let running = running.clone();
            Rc::new(move |command, args, _| {
                calls.borrow_mut().push(format!("{command} {}", args.join(" ")));
                let ran = match command.as_str() {
                    "ps" => Ran {
                        code: 0,
                        stdout: "/sbin/launchd\n/Applications/Ableton Live 12 Beta.app/Contents/MacOS/Live\n".into(),
                        stderr: String::new(),
                    },
                    // pgrep: running for two more looks, then closed.
                    "pgrep" => {
                        let left = *running.borrow();
                        *running.borrow_mut() = left.saturating_sub(1);
                        Ran { code: if left > 0 { 0 } else { 1 }, stdout: String::new(), stderr: String::new() }
                    }
                    _ => Ran { code: 0, stdout: String::new(), stderr: String::new() },
                };
                async move { ran }.boxed_local()
            })
        };
        let env = Env::new();
        let live = open_live(&run, "darwin", &env).await.unwrap();
        assert_eq!(live.app, "/Applications/Ableton Live 12 Beta.app");
        ask_to_quit(&run, "darwin", &env).await;
        assert!(closed(&run, "darwin", &env, &Signal::new()).await);
        assert!(start(&run, "darwin", &env, Some(&live.app)).await);
        assert!(start(&run, "darwin", &env, None).await);
        {
            let calls = calls.borrow();
            assert_eq!(
                calls[1],
                "osascript -e ignoring application responses -e tell application id \"com.ableton.live\" to quit -e end ignoring"
            );
            assert_eq!(calls.iter().filter(|c| c.starts_with("pgrep")).count(), 3);
            assert_eq!(&calls[calls.len() - 2..], ["open /Applications/Ableton Live 12 Beta.app", "open -b com.ableton.live"]);
        }
        // Waiting stops when asked to.
        *running.borrow_mut() = 100;
        let stop = Signal::new();
        stop.cancel();
        assert!(!closed(&run, "darwin", &env, &stop).await);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn on_windows_live_is_found_closed_opened_and_read_through_powershell() {
        let calls = Rc::new(RefCell::new(Vec::<(String, Vec<String>)>::new()));
        let run: Run = {
            let calls = calls.clone();
            Rc::new(move |command, args, _| {
                let script = args.last().cloned().unwrap_or_default();
                calls.borrow_mut().push((command, args));
                let stdout = if script.contains("Select-Object -First 1 -ExpandProperty Path") {
                    "C:\\ProgramData\\Ableton\\Live 12 Suite\\Program\\Ableton Live 12 Suite.exe\r\n"
                } else if script.contains("Start-Process") {
                    "started\r\n"
                } else if script.contains("ProductVersion") {
                    "12.4.15.0\r\n"
                } else {
                    ""
                };
                let ran = Ran { code: 0, stdout: stdout.into(), stderr: String::new() };
                async move { ran }.boxed_local()
            })
        };
        let env = Env::from([("SystemRoot".to_string(), "C:\\Windows".to_string())]);
        let powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        let live = open_live(&run, "win32", &env).await.unwrap();
        assert_eq!(live.app, "C:\\ProgramData\\Ableton\\Live 12 Suite\\Program\\Ableton Live 12 Suite.exe");
        ask_to_quit(&run, "win32", &env).await;
        // The same Live again, by its path; a path with a quote in it stays one string.
        assert!(start(&run, "win32", &env, Some(&live.app)).await);
        assert!(start(&run, "win32", &env, Some("C:\\Live's\\Ableton Live 12.exe")).await);
        // Without one, the newest Live under ProgramData.
        assert!(start(&run, "win32", &env, None).await);
        assert_eq!(version(&run, "win32", &env, Some(&live.app)).await.as_deref(), Some("12.4"));
        let calls = calls.borrow();
        for (command, args) in calls.iter() {
            assert_eq!(command, powershell);
            assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        }
        let scripts: Vec<&str> = calls.iter().map(|(_, args)| args[3].as_str()).collect();
        assert_eq!(
            scripts[0],
            "Get-Process -Name 'Ableton Live*' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"
        );
        assert_eq!(
            scripts[1],
            "Get-Process -Name 'Ableton Live*' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }"
        );
        assert_eq!(
            scripts[2],
            "$app = 'C:\\ProgramData\\Ableton\\Live 12 Suite\\Program\\Ableton Live 12 Suite.exe'; if ($app) { Start-Process -FilePath $app; 'started' }"
        );
        assert_eq!(scripts[3], "$app = 'C:\\Live''s\\Ableton Live 12.exe'; if ($app) { Start-Process -FilePath $app; 'started' }");
        assert_eq!(
            scripts[4],
            "$app = (Get-ChildItem -Path (Join-Path $env:ProgramData 'Ableton\\Live*\\Program\\Ableton Live*.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName); if ($app) { Start-Process -FilePath $app; 'started' }"
        );
        assert_eq!(scripts[5], "(Get-Item -LiteralPath 'C:\\ProgramData\\Ableton\\Live 12 Suite\\Program\\Ableton Live 12 Suite.exe').VersionInfo.ProductVersion");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn on_windows_live_not_found_or_not_started_says_so() {
        let run: Run = Rc::new(|_, _, _| async { Ran { code: 0, stdout: String::new(), stderr: String::new() } }.boxed_local());
        let env = Env::new();
        assert_eq!(open_live(&run, "win32", &env).await, None);
        assert!(!start(&run, "win32", &env, None).await, "no Live under ProgramData: nothing started");
        assert_eq!(version(&run, "win32", &env, Some("C:\\x.exe")).await, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lives_version_is_read_from_its_app() {
        for (raw, want) in [("12.4.15b5", Some("12.4")), ("12.4b15", Some("12.4")), ("12", Some("12")), ("", None), ("beta", None)] {
            assert_eq!(major_minor(raw).as_deref(), want, "{raw}");
        }
        let calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let run: Run = {
            let calls = calls.clone();
            Rc::new(move |command, args, _| {
                calls.borrow_mut().push(format!("{command} {}", args.join(" ")));
                let stdout = match command.as_str() {
                    "ps" => "/Applications/Ableton Live 12 Beta.app/Contents/MacOS/Live\n",
                    "defaults" => "12.4b15\n",
                    _ => "",
                };
                let ran = Ran { code: 0, stdout: stdout.into(), stderr: String::new() };
                async move { ran }.boxed_local()
            })
        };
        let env = Env::new();
        assert_eq!(version(&run, "darwin", &env, None).await.as_deref(), Some("12.4"));
        assert_eq!(calls.borrow()[1], "defaults read /Applications/Ableton Live 12 Beta.app/Contents/Info CFBundleShortVersionString");
        assert_eq!(version(&run, "linux", &env, Some("/x")).await, None);
    }
}
