//! A parked reader owns no pending console or pipe read when a child inherits stdin.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, ReadFile, FILE_TYPE_PIPE};
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE};

use super::super::Message;

// This tag identifies only our injected Return, including when a natural newline
// finishes ReadConsoleW just before pause publishes the cancellation trap.
const CANCEL_SCAN: u16 = 0xfffe;
const RETURN: u16 = 0x0d;

struct State {
    active: bool,
    ready: bool,
    closing: bool,
    terminal: bool,
    busy: bool,
    cooked: bool,
    injected: bool,
    cursor: Option<CONSOLE_SCREEN_BUFFER_INFO>,
    cooked_mode: Option<u32>,
    failure: Option<io::Error>,
}

struct Control {
    state: Mutex<State>,
    changed: Condvar,
    input: File,
    console_writer: Option<File>,
    output: Option<File>,
    wake: OwnedHandle,
}

impl Control {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn wake(&self) {
        // SAFETY: the event remains owned until after the worker has joined.
        unsafe { SetEvent(self.wake.as_raw_handle()) };
        self.changed.notify_all();
    }

    fn activate(&self) {
        let mut state = self.lock();
        if state.closing || state.terminal || state.failure.is_some() {
            return;
        }
        if !state.active && self.console_writer.is_some() {
            let prepare = (|| {
                let mode = console_mode(self.input.as_raw_handle())?;
                if mode & (ENABLE_LINE_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT) == (ENABLE_LINE_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT) {
                    // libuv's normal mode excludes VT input. Besides changing
                    // cooked Backspace editing, VT translation rewrites injected
                    // records and erases the cancellation Return's scan tag.
                    // Establish this before resume returns, not in the worker:
                    // input typed immediately after resume must use normal editing.
                    if unsafe { SetConsoleMode(self.input.as_raw_handle(), mode & !ENABLE_VIRTUAL_TERMINAL_INPUT) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    state.cooked_mode.get_or_insert(mode);
                }
                Ok(())
            })();
            if let Err(error) = prepare {
                state.failure = Some(error);
                self.changed.notify_all();
                return;
            }
        }
        // SAFETY: the owned wake event remains live.
        unsafe { ResetEvent(self.wake.as_raw_handle()) };
        state.active = true;
        self.changed.notify_all();
    }

    fn restore_cooked_mode(&self, state: &mut State) {
        if let Some(mode) = state.cooked_mode {
            // No OS read or cancellation marker may remain when the inherited
            // mode is restored. Keep the snapshot on failure so Drop can retry.
            if unsafe { SetConsoleMode(self.input.as_raw_handle(), mode) } != 0 {
                state.cooked_mode = None;
            } else if !state.terminal && state.failure.is_none() {
                state.failure = Some(io::Error::last_os_error());
                self.changed.notify_all();
            }
        }
    }

    fn park(&self) {
        let mut state = self.lock();
        state.active = false;
        self.wake();
        if state.busy && state.cooked && !state.injected {
            // Like libuv's console-read trap, cancellation completes a cooked
            // read with Return. CancelIoEx/CancelSynchronousIo can consume the
            // next child's console input instead. ReadConsole's control wakeup
            // is not available when stdout is redirected.
            let mut record = cancel_record();
            if let Some(output) = &self.output {
                let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
                // SAFETY: output and info are valid for this call.
                if unsafe { GetConsoleScreenBufferInfo(output.as_raw_handle(), &mut info) } != 0 {
                    state.cursor = Some(info);
                }
            }
            let mut written = 0;
            // A console writer is acquired before admitting any console read.
            // Publication and injection share this lock with read completion.
            let writer = self.console_writer.as_ref().expect("cooked input has a console writer");
            // SAFETY: the one fully initialized record and output count are valid.
            let ok = unsafe { WriteConsoleInputW(writer.as_raw_handle(), &mut record, 1, &mut written) };
            state.injected = ok != 0 && written == 1;
            if !state.injected {
                // A disconnected console also releases ReadConsoleW. Never try
                // marker reconciliation if injection failed.
                state.cursor = None;
            }
        }
        while state.busy {
            state = self.changed.wait(state).unwrap_or_else(|error| error.into_inner());
        }
        self.restore_cooked_mode(&mut state);
    }
}

pub(crate) struct Reader {
    control: Arc<Control>,
    commands: Arc<Mutex<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Reader {
    pub(crate) fn new(sender: tokio::sync::mpsc::UnboundedSender<Message>) -> io::Result<Self> {
        // Read the actual standard handle: redirected files/pipes must not be
        // replaced with CONIN$. Duplicate ownership without changing inheritance.
        let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if input.is_null() || input == INVALID_HANDLE_VALUE {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "stdin is unavailable"));
        }
        // SAFETY: GetStdHandle returned a live borrowed handle; clone owns its copy.
        let input = File::from(unsafe { BorrowedHandle::borrow_raw(input) }.try_clone_to_owned()?);
        let console = console_mode(input.as_raw_handle()).is_ok();
        let console_writer = if console { Some(OpenOptions::new().read(true).write(true).open("CONIN$")?) } else { None };
        let output = if console { OpenOptions::new().read(true).write(true).open("CONOUT$").ok() } else { None };
        // SAFETY: null attributes/name request an unnamed, noninherited manual event.
        let wake = unsafe { CreateEventW(null(), 1, 0, null()) };
        if wake.is_null() {
            return Err(io::Error::last_os_error());
        }
        let control = Arc::new(Control {
            state: Mutex::new(State {
                active: false,
                ready: true,
                closing: false,
                terminal: false,
                busy: false,
                cooked: false,
                injected: false,
                cursor: None,
                cooked_mode: None,
                failure: None,
            }),
            changed: Condvar::new(),
            input,
            console_writer,
            output,
            // SAFETY: CreateEventW created this unique owned handle.
            wake: unsafe { OwnedHandle::from_raw_handle(wake) },
        });
        let worker = control.clone();
        let thread = std::thread::Builder::new().name("kumi-stdin".into()).spawn(move || run(&worker, sender))?;
        Ok(Self { control, commands: Arc::new(Mutex::new(())), thread: Some(thread) })
    }

    pub(crate) fn resume(&self) {
        let _command = self.commands.lock().unwrap_or_else(|error| error.into_inner());
        self.control.activate();
    }

    pub(crate) fn pause(&self) {
        let _command = self.commands.lock().unwrap_or_else(|error| error.into_inner());
        self.control.park();
    }

    pub(crate) fn acknowledge(&self) {
        self.control.lock().ready = true;
        self.control.changed.notify_all();
    }

    pub(crate) fn with_mode<T>(&self, change: impl FnOnce() -> T) -> T {
        let _command = self.commands.lock().unwrap_or_else(|error| error.into_inner());
        let active = self.control.lock().active;
        self.control.park();
        let result = change();
        if active {
            self.control.activate();
        }
        result
    }

    pub(crate) fn guard_restorer(&self, restore: crate::input::RawModeRestorer) -> crate::input::RawModeRestorer {
        let control = Arc::downgrade(&self.control);
        let commands = self.commands.clone();
        Arc::new(move |enabled| {
            let _command = commands.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(control) = control.upgrade() {
                // Emergency restoration relinquishes input, rather than admitting
                // another read after the terminal has been restored.
                control.park();
            }
            restore(enabled);
        })
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        let _command = self.commands.lock().unwrap_or_else(|error| error.into_inner());
        self.control.park();
        self.control.lock().closing = true;
        self.control.wake();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(control: &Control, sender: tokio::sync::mpsc::UnboundedSender<Message>) {
    let mut decoder = ConsoleText::default();
    loop {
        let mut state = control.lock();
        while !state.closing && !state.terminal && state.failure.is_none() && !(state.active && state.ready) {
            state = control.changed.wait(state).unwrap_or_else(|error| error.into_inner());
        }
        if state.closing || state.terminal {
            break;
        }
        if let Some(error) = state.failure.take() {
            state.terminal = true;
            state.ready = false;
            let _ = sender.send(Message::Error(error));
            break;
        }
        let mode = if control.console_writer.is_some() { console_mode(control.input.as_raw_handle()) } else { Ok(0) };
        state.busy = true;
        state.cooked = mode.as_ref().is_ok_and(|mode| mode & ENABLE_LINE_INPUT != 0);
        state.injected = false;
        state.cursor = None;
        let cooked = state.cooked;
        drop(state);
        let result = match mode {
            Err(error) => Err(error),
            Ok(_) if cooked => read_cooked(control),
            Ok(_) if control.console_writer.is_some() => read_raw(control, &mut decoder),
            Ok(_) => read_redirected(control),
        };
        let mut state = control.lock();
        let message = match result {
            Ok(Read::Parked) => None,
            Ok(Read::Data(bytes)) if bytes.is_empty() => None,
            Ok(Read::Data(bytes)) => Some(Message::Data(bytes)),
            Ok(Read::End) => Some(Message::End),
            Err(error) => Some(Message::Error(error)),
        };
        if let Some(message) = message {
            state.ready = false;
            state.terminal = !matches!(message, Message::Data(_));
            if sender.send(message).is_err() {
                state.terminal = true;
            }
        }
        state.busy = false;
        state.cooked = false;
        control.changed.notify_all();
    }
}

enum Read {
    Data(Vec<u8>),
    End,
    Parked,
}

fn console_mode(input: HANDLE) -> io::Result<u32> {
    let mut mode = 0;
    // SAFETY: input is a borrowed live handle, mode is writable.
    if unsafe { GetConsoleMode(input, &mut mode) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(mode)
    }
}

fn read_raw(control: &Control, decoder: &mut ConsoleText) -> io::Result<Read> {
    let handles = [control.wake.as_raw_handle(), control.input.as_raw_handle()];
    // SAFETY: both handles remain owned throughout the wait.
    let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
    if result == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    let state = control.lock();
    if result == WAIT_OBJECT_0 || !state.active || state.closing {
        return Ok(Read::Parked);
    }
    // Mode changes and pause share this lock. Recheck readiness, since a mode
    // transition or another console consumer can have invalidated the first wait.
    let mut count = 0;
    if unsafe { GetNumberOfConsoleInputEvents(control.input.as_raw_handle(), &mut count) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if count == 0 {
        return Ok(Read::Parked);
    }
    let mut records = [INPUT_RECORD::default(); 128];
    let count = count.min(records.len() as u32);
    let mut read = 0;
    // SAFETY: the buffer is writable for count initialized records. The read is
    // admitted while holding the same lock as pause and mode changes.
    if unsafe { ReadConsoleInputW(control.input.as_raw_handle(), records.as_mut_ptr(), count, &mut read) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut text = String::new();
    for record in &records[..read as usize] {
        decoder.record(record, &mut text);
    }
    // Do not split an already queued UTF-16 pair at the 128-record batch limit:
    // pausing in the Data callback would otherwise leave its low surrogate for
    // the child. A future, not-yet-typed low surrogate remains stream decoder state.
    while decoder.high.is_some() {
        let mut next = INPUT_RECORD::default();
        let mut available = 0;
        if unsafe { PeekConsoleInputW(control.input.as_raw_handle(), &mut next, 1, &mut available) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if available == 0 || text_key(&next).is_some_and(|(unit, _)| !(0xdc00..=0xdfff).contains(&unit)) {
            break;
        }
        if unsafe { ReadConsoleInputW(control.input.as_raw_handle(), &mut next, 1, &mut available) } == 0 {
            return Err(io::Error::last_os_error());
        }
        decoder.record(&next, &mut text);
    }
    // Focus, resize, modifier and key-up events are not stream EOF.
    Ok(Read::Data(text.into_bytes()))
}

fn read_redirected(control: &Control) -> io::Result<Read> {
    loop {
        let state = control.lock();
        if !state.active || state.closing {
            return Ok(Read::Parked);
        }
        let mut buffer = [0u8; 4096];
        let mut available = buffer.len() as u32;
        // Anonymous stdin pipes are synchronous handles. Peek before ReadFile so
        // pause never leaves a blocked pipe read competing with the next owner.
        if unsafe { GetFileType(control.input.as_raw_handle()) } == FILE_TYPE_PIPE {
            if unsafe { PeekNamedPipe(control.input.as_raw_handle(), null_mut(), 0, null_mut(), &mut available, null_mut()) } == 0 {
                let error = io::Error::last_os_error();
                return if is_eof(&error) { Ok(Read::End) } else { Err(error) };
            }
            if available == 0 {
                drop(state);
                // There is no pipe readiness event for an inherited synchronous
                // handle. The stop event makes this bounded readiness wait cancelable.
                unsafe { WaitForSingleObject(control.wake.as_raw_handle(), 5) };
                continue;
            }
        }
        let mut read = 0;
        // SAFETY: buffer is valid for the requested length, and no other reader
        // is admitted until pause has released this state lock.
        if unsafe {
            ReadFile(control.input.as_raw_handle(), buffer.as_mut_ptr(), available.min(buffer.len() as u32), &mut read, null_mut())
        } == 0
        {
            let error = io::Error::last_os_error();
            return if is_eof(&error) { Ok(Read::End) } else { Err(error) };
        }
        return if read == 0 { Ok(Read::End) } else { Ok(Read::Data(buffer[..read as usize].to_vec())) };
    }
}

fn is_eof(error: &io::Error) -> bool {
    matches!(error.raw_os_error().map(|code| code as u32), Some(ERROR_BROKEN_PIPE | ERROR_HANDLE_EOF))
}

fn cancel_record() -> INPUT_RECORD {
    let mut record = INPUT_RECORD { EventType: KEY_EVENT as u16, ..INPUT_RECORD::default() };
    record.Event.KeyEvent = KEY_EVENT_RECORD {
        bKeyDown: 1,
        wRepeatCount: 1,
        wVirtualKeyCode: RETURN,
        wVirtualScanCode: CANCEL_SCAN,
        uChar: KEY_EVENT_RECORD_0 { UnicodeChar: RETURN },
        dwControlKeyState: 0,
    };
    record
}

fn marker_queued(input: HANDLE) -> io::Result<bool> {
    let mut count = 0;
    // SAFETY: input is live and count is writable.
    if unsafe { GetNumberOfConsoleInputEvents(input, &mut count) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if count == 0 {
        return Ok(false);
    }
    let mut records = vec![INPUT_RECORD::default(); count as usize];
    let mut read = 0;
    // SAFETY: the initialized records vector has exactly count elements.
    if unsafe { PeekConsoleInputW(input, records.as_mut_ptr(), count, &mut read) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(records[..read as usize].iter().any(|record| {
        if record.EventType != KEY_EVENT as u16 {
            return false;
        }
        // SAFETY: KEY_EVENT selects the matching union member.
        let key = unsafe { record.Event.KeyEvent };
        key.bKeyDown != 0
            && key.wVirtualKeyCode == RETURN
            && key.wVirtualScanCode == CANCEL_SCAN
            && unsafe { key.uChar.UnicodeChar } == RETURN
    }))
}

fn read_cooked(control: &Control) -> io::Result<Read> {
    let mut text = Vec::new();
    loop {
        let mut buffer = [0u16; 4096];
        let mut read = 0;
        // SAFETY: the UTF-16 buffer is valid, and mode changes wait for this read
        // to finish. Windows supplies its normal cooked editing and echo.
        let ok = unsafe { ReadConsoleW(control.input.as_raw_handle(), buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut read, null()) };
        let error = if ok == 0 { Some(io::Error::last_os_error()) } else { None };
        // Publish completion before decoding. A pause that won this lock may have
        // injected Return after a *natural* completion; do not leave it for a child.
        let mut state = control.lock();
        if let Some(error) = error {
            state.cooked = false;
            return Err(error);
        }
        let part = &buffer[..read as usize];
        if state.injected {
            let queued = match marker_queued(control.input.as_raw_handle()) {
                Ok(queued) => queued,
                Err(error) => {
                    state.cooked = false;
                    return Err(error);
                }
            };
            if queued || (read as usize == buffer.len() && !part.ends_with(&[10])) {
                // Our Return is positively still queued. Finish only that read,
                // keeping genuine preceding lines and partial text. Never drain
                // and reinsert records: that can reorder concurrently typed keys.
                // A full unterminated chunk can also have consumed the marker
                // into ReadConsole's pending line; finish that buffered line.
                text.extend_from_slice(part);
                drop(state);
                continue;
            }
            // The trap's Return was consumed by this read. Remove only its line
            // terminator; all real bytes already read remain owned by this stream.
            if let (Some(output), Some(info)) = (&control.output, state.cursor.take()) {
                let mut cursor = info.dwCursorPosition;
                if cursor.Y == info.dwSize.Y - 1 {
                    cursor.Y = cursor.Y.saturating_sub(1);
                }
                // SAFETY: output is live; this is libuv's pre-trap cursor restoration.
                unsafe { SetConsoleCursorPosition(output.as_raw_handle(), cursor) };
            }
            text.extend_from_slice(part);
            // The CRLF can straddle ReadConsole's 4096-WCHAR buffer boundary.
            if text.ends_with(&[13, 10]) {
                text.truncate(text.len() - 2);
            } else if text.ends_with(&[13]) {
                text.truncate(text.len() - 1);
            }
            state.cooked = false;
            if text.first() == Some(&26) {
                return Ok(Read::End);
            }
            return if text.is_empty() { Ok(Read::Parked) } else { Ok(Read::Data(String::from_utf16_lossy(&text).into_bytes())) };
        }
        // ReadConsole can split a completed line (and a surrogate pair) at its
        // output-buffer boundary. Finish that OS-buffered line before releasing
        // ownership or publishing decoded bytes; a child must not inherit its tail.
        if read as usize == buffer.len() && !part.ends_with(&[10]) {
            text.extend_from_slice(part);
            drop(state);
            continue;
        }
        // Hold completion publication through the worker's next lock: clearing
        // cooked prevents a cancellation from injecting after a completed read.
        state.cooked = false;
        if read == 0 || part.first() == Some(&26) {
            return Ok(Read::End);
        }
        text.extend_from_slice(part);
        return Ok(Read::Data(String::from_utf16_lossy(&text).into_bytes()));
    }
}

#[derive(Default)]
struct ConsoleText {
    high: Option<(u16, u16)>,
}

impl ConsoleText {
    fn record(&mut self, record: &INPUT_RECORD, text: &mut String) {
        let Some((unit, repeats)) = text_key(record) else { return };
        if let Some((high, high_repeats)) = self.high.take() {
            if (0xdc00..=0xdfff).contains(&unit) {
                let codepoint = 0x10000 + ((u32::from(high) - 0xd800) << 10) + (u32::from(unit) - 0xdc00);
                for _ in 0..high_repeats.min(repeats) {
                    text.push(char::from_u32(codepoint).expect("a surrogate pair is a Unicode scalar"));
                }
                for _ in 0..high_repeats.abs_diff(repeats) {
                    text.push('\u{fffd}');
                }
                return;
            }
            for _ in 0..high_repeats {
                text.push('\u{fffd}');
            }
        }
        if (0xd800..=0xdbff).contains(&unit) {
            self.high = Some((unit, repeats));
        } else {
            for _ in 0..repeats {
                text.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'));
            }
        }
    }
}

fn text_key(record: &INPUT_RECORD) -> Option<(u16, u16)> {
    if record.EventType != KEY_EVENT as u16 {
        return None;
    }
    // SAFETY: KEY_EVENT selects this initialized union member.
    let key = unsafe { record.Event.KeyEvent };
    if key.bKeyDown == 0 && key.wVirtualKeyCode != 0x12 {
        return None; // Alt key-up can carry the character produced by an Alt code.
    }
    let unit = unsafe { key.uChar.UnicodeChar };
    if key.wRepeatCount == 0 || (unit == 0 && key.wVirtualScanCode != 0) {
        return None;
    }
    Some((unit, key.wRepeatCount))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(unit: u16, repeats: u16, down: bool, virtual_key: u16, scan: u16) -> INPUT_RECORD {
        let mut record = INPUT_RECORD { EventType: KEY_EVENT as u16, ..INPUT_RECORD::default() };
        record.Event.KeyEvent = KEY_EVENT_RECORD {
            bKeyDown: down as i32,
            wRepeatCount: repeats,
            wVirtualKeyCode: virtual_key,
            wVirtualScanCode: scan,
            uChar: KEY_EVENT_RECORD_0 { UnicodeChar: unit },
            dwControlKeyState: 0,
        };
        record
    }

    #[test]
    fn raw_decoder_preserves_repeat_counts_and_alt_code_key_up() {
        let mut decoder = ConsoleText::default();
        let mut text = String::new();
        decoder.record(&key(b'a' as u16, 3, true, 0x41, 0x1e), &mut text);
        decoder.record(&key(b'x' as u16, 1, false, 0x58, 0x2d), &mut text);
        decoder.record(&key(0xe9, 2, false, 0x12, 0x38), &mut text);
        assert_eq!(text, "aaaéé");
    }

    #[test]
    fn raw_decoder_pairs_repeated_surrogates_across_record_batches() {
        let mut decoder = ConsoleText::default();
        let mut first = String::new();
        decoder.record(&key(0xd83d, 2, true, 0, 0), &mut first);
        assert_eq!(first, "");
        let mut next = String::new();
        decoder.record(&key(0xde00, 2, true, 0, 0), &mut next);
        assert_eq!(next, "😀😀");
        assert!(decoder.high.is_none());
    }

    #[test]
    fn raw_decoder_keeps_vt_nul_but_ignores_modifier_and_non_text_records() {
        let mut decoder = ConsoleText::default();
        let mut text = String::new();
        decoder.record(&INPUT_RECORD { EventType: FOCUS_EVENT as u16, ..INPUT_RECORD::default() }, &mut text);
        decoder.record(&INPUT_RECORD { EventType: WINDOW_BUFFER_SIZE_EVENT as u16, ..INPUT_RECORD::default() }, &mut text);
        decoder.record(&key(0, 1, true, 0x10, 0x2a), &mut text);
        decoder.record(&key(b'x' as u16, 0, true, 0, 0), &mut text);
        assert_eq!(text, "");
        for unit in [27, 91, 65, 0] {
            decoder.record(&key(unit, 1, true, 0, 0), &mut text);
        }
        assert_eq!(text, "\x1b[A\0");
    }

    #[test]
    fn raw_decoder_retains_surrogates_across_non_text_records() {
        let mut decoder = ConsoleText::default();
        let mut text = String::new();
        decoder.record(&key(0xd83d, 1, true, 0, 0), &mut text);
        decoder.record(&INPUT_RECORD { EventType: FOCUS_EVENT as u16, ..INPUT_RECORD::default() }, &mut text);
        decoder.record(&key(0xde00, 1, true, 0, 0), &mut text);
        assert_eq!(text, "😀");
        decoder.record(&key(0xd83d, 1, true, 0, 0), &mut text);
        decoder.record(&key(b'a' as u16, 1, true, 0, 0), &mut text);
        decoder.record(&key(0xde00, 1, true, 0, 0), &mut text);
        assert_eq!(text, "😀\u{fffd}a\u{fffd}");
    }
}
