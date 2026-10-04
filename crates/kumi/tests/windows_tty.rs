#![cfg(windows)]

use kumi::input::TerminalInput;
use kumi::tui::tty::Stdin;
use std::fs::{File, OpenOptions};
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::process::{Command, Stdio};
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetConsoleProcessList, SetConsoleMode, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT,
};

const PROBE: &str = "KUMI_TEST_WINDOWS_INPUT_CONSOLE";
const CASE: &str = "raw_byte_input_enables_vt_and_restores_the_actual_windows_console";
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

fn mode(console: &File) -> u32 {
    let mut mode = 0;
    // SAFETY: console owns a live console-input handle; mode is writable.
    assert_ne!(unsafe { GetConsoleMode(console.as_raw_handle(), &mut mode) }, 0, "{}", std::io::Error::last_os_error());
    mode
}

fn set_mode(console: &File, mode: u32) {
    // SAFETY: console owns a live console-input handle.
    assert_ne!(unsafe { SetConsoleMode(console.as_raw_handle(), mode) }, 0, "{}", std::io::Error::last_os_error());
}

struct Restore<'a>(&'a File, u32);
impl Drop for Restore<'_> {
    fn drop(&mut self) {
        // SAFETY: the borrowed file outlives this guard, including unwinding.
        unsafe { SetConsoleMode(self.0.as_raw_handle(), self.1) };
    }
}

#[test]
fn raw_byte_input_enables_vt_and_restores_the_actual_windows_console() {
    if std::env::var_os(PROBE).is_none() {
        // Use a new console, never the runner's or developer's console. The child
        // opens CONIN$ just as production does; harness output remains in pipes.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CASE, "--nocapture"])
            .env(PROBE, "1")
            .creation_flags(CREATE_NEW_CONSOLE)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "console probe {}\nstdout: {}\nstderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let mut processes = [0; 2];
    // SAFETY: processes is writable for its declared length. Refuse to alter a
    // shared console even if someone manually sets the subprocess marker.
    let count = unsafe { GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) };
    assert_eq!(count, 1, "the probe must own its console");
    assert_eq!(processes[0], std::process::id());
    let console = OpenOptions::new().read(true).write(true).open("CONIN$").unwrap();
    let original = mode(&console);
    let _restore = Restore(&console, original);
    let cooked = ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT;
    let without_vt = original & !ENABLE_VIRTUAL_TERMINAL_INPUT;
    for initial in [
        (without_vt | ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT) & !ENABLE_ECHO_INPUT,
        without_vt & !cooked,
        original | ENABLE_VIRTUAL_TERMINAL_INPUT,
    ] {
        set_mode(&console, initial);
        let input = Stdin::new();
        assert!(!input.is_raw(), "a new stream does not own inherited raw mode");
        input.set_raw_mode(true).unwrap();
        let raw = (initial & !cooked) | ENABLE_VIRTUAL_TERMINAL_INPUT;
        assert_eq!(mode(&console), raw, "byte input requires VT conversion");
        assert!(input.is_raw());
        let nested_was_raw = input.is_raw();
        input.set_raw_mode(true).unwrap();
        input.set_raw_mode(nested_was_raw).unwrap();
        assert_eq!(mode(&console), raw);
        input.set_raw_mode(false).unwrap();
        input.set_raw_mode(false).unwrap();
        assert_eq!(mode(&console), initial, "restore all original bits, including VT");
        assert!(!input.is_raw());

        for order in [[false, true], [true, false]] {
            input.set_raw_mode(true).unwrap();
            let outer = input.emergency_raw_mode().unwrap();
            input.set_raw_mode(true).unwrap();
            let inner = input.emergency_raw_mode().unwrap();
            for was_raw in order {
                let restore = if was_raw { inner.clone() } else { outer.clone() };
                std::thread::spawn(move || restore(was_raw)).join().unwrap();
            }
            assert_eq!(mode(&console), initial, "nested emergency cleanup must not re-enable raw mode");
            assert!(!input.is_raw());
        }
        input.set_raw_mode(true).unwrap();
        drop(input);
        assert_eq!(mode(&console), initial, "dropping the raw owner restores the snapshot");
    }
}
