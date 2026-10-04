#![cfg(windows)]

use kumi::input::TerminalInput;
use kumi::tui::tty::Stdin;
use std::cell::{Cell, RefCell};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::os::windows::{io::AsRawHandle, process::CommandExt};
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Console::*;

const PROBE: &str = "KUMI_WINDOWS_STDIN_CONSOLE";
const CHILD: &str = "KUMI_WINDOWS_STDIN_CHILD";
const CREATE_NEW_CONSOLE: u32 = 0x10;

struct Process(Option<Child>);
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "console process did not finish before its deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn isolated(case: &str, run: impl FnOnce(File)) {
    if std::env::var(PROBE).as_deref() != Ok(case) {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", case, "--nocapture"])
            .env(PROBE, case)
            .creation_flags(CREATE_NEW_CONSOLE)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut process = Process(Some(child));
        let status = wait(process.0.as_mut().unwrap(), Duration::from_secs(60));
        let output = process.0.take().unwrap().wait_with_output().unwrap();
        assert!(
            status.success(),
            "{case}: {status}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let mut processes = [0u32; 2];
    // SAFETY: the array is writable; refuse to touch any shared developer console.
    assert_eq!(unsafe { GetConsoleProcessList(processes.as_mut_ptr(), 2) }, 1);
    assert_eq!(processes[0], std::process::id());
    let console = OpenOptions::new().read(true).write(true).open("CONIN$").unwrap();
    // Harness output stays redirected. Production must read this actual stdin
    // handle, rather than relying on console stdout or silently opening CONIN$.
    assert_ne!(unsafe { SetStdHandle(STD_INPUT_HANDLE, console.as_raw_handle()) }, 0);
    assert_ne!(unsafe { FlushConsoleInputBuffer(console.as_raw_handle()) }, 0);
    assert_ne!(unsafe { SetConsoleMode(console.as_raw_handle(), ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT) }, 0);
    run(console);
}

fn key(unit: u16, repeats: u16) -> INPUT_RECORD {
    let mut event = INPUT_RECORD { EventType: KEY_EVENT as u16, ..INPUT_RECORD::default() };
    event.Event.KeyEvent = KEY_EVENT_RECORD {
        bKeyDown: 1,
        wRepeatCount: repeats,
        wVirtualKeyCode: if matches!(unit, 8 | 13) { unit } else { 0 },
        wVirtualScanCode: if unit == 13 { 0x1c } else { 0 },
        uChar: KEY_EVENT_RECORD_0 { UnicodeChar: unit },
        dwControlKeyState: 0,
    };
    event
}

fn write_records(console: &File, records: &[INPUT_RECORD]) {
    let mut written = 0;
    // SAFETY: records is initialized and count matches its length.
    assert_ne!(
        unsafe { WriteConsoleInputW(console.as_raw_handle(), records.as_ptr(), records.len() as u32, &mut written) },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
    assert_eq!(written, records.len() as u32);
}

fn write_text(console: &File, text: &str) {
    write_records(console, &text.encode_utf16().map(|unit| key(unit, 1)).collect::<Vec<_>>());
}

fn queue_empty(console: &File) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut count = 0;
        assert_ne!(unsafe { GetNumberOfConsoleInputEvents(console.as_raw_handle(), &mut count) }, 0);
        if count == 0 {
            return;
        }
        assert!(Instant::now() < deadline, "reader did not consume the prepared console records ({count} remain)");
        std::thread::yield_now();
    }
}

fn receive(input: &Stdin, count: usize, pause: bool) -> tokio::sync::oneshot::Receiver<Vec<u8>> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = RefCell::new(Some(send));
    let bytes = RefCell::new(Vec::new());
    let input_copy = input.clone();
    input.resume(Rc::new(move |chunk| {
        bytes.borrow_mut().extend_from_slice(chunk);
        if bytes.borrow().len() >= count {
            if pause {
                input_copy.pause();
            }
            if let Some(send) = send.borrow_mut().take() {
                let _ = send.send(std::mem::take(&mut *bytes.borrow_mut()));
            }
        }
    }));
    receive
}

async fn received(receive: tokio::sync::oneshot::Receiver<Vec<u8>>) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), receive).await.expect("parent input stalled").unwrap()
}

fn child_reads(console: &File, text: &str) {
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "console_child_reads_exact_line", "--nocapture"])
        .env(CHILD, format!("{text}\r\n"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut process = Process(Some(child));
    let child = process.0.as_mut().unwrap();
    let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        assert_ne!(output.read_line(&mut line).unwrap(), 0, "child exited before reading: {line}");
        if line.contains("[console-child-ready]") {
            break;
        }
        line.clear();
    }
    write_text(console, &format!("{text}\r"));
    let status = wait(child, Duration::from_secs(5));
    let mut rest = String::new();
    output.read_to_string(&mut rest).unwrap();
    let mut errors = String::new();
    child.stderr.take().unwrap().read_to_string(&mut errors).unwrap();
    assert!(status.success(), "child read failed: {status}\n{rest}\n{errors}");
    process.0.take();
    queue_empty(console);
}

#[test]
fn console_child_reads_exact_line() {
    let Ok(expected) = std::env::var(CHILD) else { return };
    let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    let mut mode = 0;
    assert_ne!(unsafe { GetConsoleMode(input, &mut mode) }, 0, "child must inherit the owned console input");
    assert_ne!(mode & ENABLE_LINE_INPUT, 0);
    println!("[console-child-ready]");
    std::io::stdout().flush().unwrap();
    let mut buffer = [0u16; 4096];
    let mut read = 0;
    assert_ne!(unsafe { ReadConsoleW(input, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut read, std::ptr::null()) }, 0);
    assert_eq!(String::from_utf16_lossy(&buffer[..read as usize]), expected, "child received stale or synthetic input");
}

#[test]
fn raw_console_preserves_vt_unicode_repeats_and_queued_parent_input() {
    isolated("raw_console_preserves_vt_unicode_repeats_and_queued_parent_input", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                let input = Stdin::new();
                input.set_raw_mode(true).unwrap();
                let ended = Rc::new(Cell::new(false));
                input.on_end(Rc::new({
                    let ended = ended.clone();
                    move || ended.set(true)
                }));
                let first = receive(&input, "aaa😀\x1b[D\0é".len(), true);
                let mut focus = INPUT_RECORD { EventType: FOCUS_EVENT as u16, ..INPUT_RECORD::default() };
                focus.Event.FocusEvent = FOCUS_EVENT_RECORD { bSetFocus: 1 };
                let mut release = key(b'x' as u16, 1);
                unsafe { release.Event.KeyEvent.bKeyDown = 0 };
                write_records(&console, &[focus, release]);
                queue_empty(&console);
                tokio::task::yield_now().await;
                assert!(!ended.get(), "non-text records must not emit EOF");
                write_records(&console, &[key(b'a' as u16, 3), key(0xd83d, 1)]);
                // The next batch completes the UTF-16 pair. The intervening message
                // acknowledgement must retain the pending high surrogate.
                tokio::task::yield_now().await;
                let mut alt_release = key(0xe9, 1);
                unsafe {
                    alt_release.Event.KeyEvent.bKeyDown = 0;
                    alt_release.Event.KeyEvent.wVirtualKeyCode = 0x12;
                }
                write_records(&console, &[key(0xde00, 1), key(27, 1), key(91, 1), key(68, 1), key(0, 1), alt_release]);
                assert_eq!(received(first).await, "aaa😀\x1b[D\0é".as_bytes());
                input.set_raw_mode(false).unwrap();
                child_reads(&console, "raw-child");

                input.set_raw_mode(true).unwrap();
                let expected = format!("{}😀😀", "x".repeat(127));
                let boundary = receive(&input, expected.len(), true);
                let mut records = vec![key(b'x' as u16, 1); 127];
                records.extend([key(0xd83d, 2), key(0xde00, 2)]);
                write_records(&console, &records);
                assert_eq!(received(boundary).await, expected.as_bytes());
                input.set_raw_mode(false).unwrap();
                child_reads(&console, "surrogate-boundary-child");

                for round in 0..3 {
                    input.set_raw_mode(true).unwrap();
                    let _old_listener = receive(&input, 1, false);
                    write_text(&console, "p");
                    // No LocalSet poll until after pause: the native reader has
                    // queued genuine parent input, which must survive the handoff.
                    queue_empty(&console);
                    input.pause();
                    input.set_raw_mode(false).unwrap();
                    child_reads(&console, &format!("buffered-child-{round}"));
                    assert_eq!(received(receive(&input, 1, true)).await, b"p");
                }
                assert!(!ended.get());
            },
        ));
    });
}

#[test]
fn cooked_console_pause_preserves_os_editing_and_partial_text() {
    isolated("cooked_console_pause_preserves_os_editing_and_partial_text", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                let input = Stdin::new();
                for round in 0..3 {
                    let _waiting = receive(&input, 2, false);
                    write_text(&console, "ab\u{8}C");
                    queue_empty(&console);
                    input.pause();
                    child_reads(&console, &format!("cooked-child-{round}"));
                    assert_eq!(received(receive(&input, 2, true)).await, b"aC");
                }
                // Dropping a pending cooked read must release console ownership too.
                input.resume(Rc::new(|_| panic!("unexpected parent input")));
                write_text(&console, "drop-parent");
                queue_empty(&console);
                drop(input);
                child_reads(&console, "drop-child");
            },
        ));
    });
}

#[test]
fn cooked_console_eof_is_once_and_leaves_no_cancellation_input() {
    isolated("cooked_console_eof_is_once_and_leaves_no_cancellation_input", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                let input = Stdin::new();
                let ended = Rc::new(Cell::new(0));
                let (send, receive) = tokio::sync::oneshot::channel();
                let send = RefCell::new(Some(send));
                input.on_end(Rc::new({
                    let ended = ended.clone();
                    move || {
                        ended.set(ended.get() + 1);
                        if let Some(send) = send.borrow_mut().take() {
                            let _ = send.send(());
                        }
                    }
                }));
                input.resume(Rc::new(|_| panic!("Ctrl+Z at the start of a cooked line must be EOF")));
                write_text(&console, "\u{1a}\r");
                queue_empty(&console);
                input.pause();
                child_reads(&console, "eof-child");
                input.resume(Rc::new(|_| panic!("data after EOF")));
                tokio::time::timeout(Duration::from_secs(5), receive).await.unwrap().unwrap();
                input.pause();
                input.resume(Rc::new(|_| panic!("data after repeated EOF resume")));
                for _ in 0..4 {
                    tokio::task::yield_now().await;
                }
                assert_eq!(ended.get(), 1);
                input.pause();
            },
        ));
    });
}

#[test]
fn natural_newline_racing_pause_never_reaches_the_child() {
    isolated("natural_newline_racing_pause_never_reaches_the_child", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                let input = Stdin::new();
                for round in 0..16 {
                    let _waiting = receive(&input, 8, false);
                    write_text(&console, "parent");
                    queue_empty(&console);
                    // Enqueue the real Return first, then race its completion
                    // publication. Any synthetic Return belongs solely to the parent.
                    write_text(&console, "\r");
                    input.pause();
                    child_reads(&console, &format!("race-child-{round}"));
                    assert_eq!(received(receive(&input, 8, true)).await, b"parent\r\n");
                }
            },
        ));
    });
}

#[test]
fn cooked_pause_finishes_buffered_line_tails_before_child_handoff() {
    isolated("cooked_pause_finishes_buffered_line_tails_before_child_handoff", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                let input = Stdin::new();
                let mut cases = [4095, 4096, 4097, 8191].map(|length| "x".repeat(length)).to_vec();
                // The high surrogate is WCHAR4096; its low surrogate begins the next buffer.
                cases.push(format!("{}😀", "x".repeat(4095)));
                for (case, text) in cases.into_iter().enumerate() {
                    for newline in [false, true] {
                        let expected = if newline { format!("{text}\r\n") } else { text.clone() };
                        let _waiting = receive(&input, expected.len(), false);
                        write_text(&console, &text);
                        queue_empty(&console);
                        if newline {
                            write_text(&console, "\r");
                        }
                        input.pause();
                        child_reads(&console, &format!("tail-child-{case}-{newline}"));
                        assert_eq!(received(receive(&input, expected.len(), true)).await, expected.as_bytes());
                    }
                }
            },
        ));
    });
}

#[test]
fn unavailable_windows_stdin_reports_one_error_without_panicking() {
    isolated("unavailable_windows_stdin_reports_one_error_without_panicking", |console| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(tokio::task::LocalSet::new().run_until(
            async {
                assert_ne!(unsafe { SetStdHandle(STD_INPUT_HANDLE, std::ptr::null_mut()) }, 0);
                let input = Stdin::new();
                let errors = Rc::new(Cell::new(0));
                let (send, receive) = tokio::sync::oneshot::channel();
                let send = RefCell::new(Some(send));
                input.on_error(Rc::new({
                    let errors = errors.clone();
                    move |_| {
                        errors.set(errors.get() + 1);
                        if let Some(send) = send.borrow_mut().take() {
                            let _ = send.send(());
                        }
                    }
                }));
                input.resume(Rc::new(|_| panic!("unavailable stdin emitted data")));
                tokio::time::timeout(Duration::from_secs(5), receive).await.unwrap().unwrap();
                input.pause();
                input.resume(Rc::new(|_| panic!("unavailable stdin emitted data after resume")));
                for _ in 0..4 {
                    tokio::task::yield_now().await;
                }
                assert_eq!(errors.get(), 1);
                drop(input);
                assert_ne!(unsafe { SetStdHandle(STD_INPUT_HANDLE, console.as_raw_handle()) }, 0);
            },
        ));
    });
}
