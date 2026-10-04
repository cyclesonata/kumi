//! Windows console modes for the byte-oriented input reader.

use std::io;

const COOKED_INPUT: u32 = 0x0001 | 0x0002 | 0x0004;
const VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;

pub(super) trait ConsoleMode {
    fn mode(&mut self) -> io::Result<u32>;
    fn set_mode(&mut self, mode: u32) -> io::Result<()>;
}

/// Owns one raw-mode interval, including the console's complete original mode.
#[derive(Default)]
pub(super) struct RawInput<C: ConsoleMode> {
    console: C,
    original: Option<u32>,
}

impl<C: ConsoleMode> RawInput<C> {
    pub(super) fn is_raw(&self) -> bool {
        self.original.is_some()
    }

    pub(super) fn set(&mut self, enabled: bool) -> io::Result<()> {
        match (enabled, self.original) {
            (true, None) => {
                let original = self.console.mode()?;
                self.console.set_mode((original & !COOKED_INPUT) | VIRTUAL_TERMINAL_INPUT)?;
                self.original = Some(original);
            }
            (false, Some(original)) => {
                self.console.set_mode(original)?;
                self.original = None;
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn restore(&mut self, was_raw: bool) -> io::Result<()> {
        // Exit restorers run in registration order. A nested raw owner must not
        // re-enable input after its outer owner has already restored the console.
        if was_raw {
            Ok(())
        } else {
            self.set(false)
        }
    }
}

impl<C: ConsoleMode> Drop for RawInput<C> {
    fn drop(&mut self) {
        let _ = self.set(false);
    }
}

#[cfg(windows)]
#[derive(Default)]
pub(super) struct Console {
    file: Option<std::fs::File>,
}

#[cfg(windows)]
impl Console {
    fn handle(&mut self) -> io::Result<std::os::windows::io::RawHandle> {
        use std::os::windows::io::AsRawHandle;
        if self.file.is_none() {
            self.file = Some(std::fs::OpenOptions::new().read(true).write(true).open("CONIN$")?);
        }
        Ok(self.file.as_ref().expect("opened console input").as_raw_handle())
    }
}

#[cfg(windows)]
impl ConsoleMode for Console {
    fn mode(&mut self) -> io::Result<u32> {
        let mut mode = 0;
        // SAFETY: the owned CONIN$ handle is live; mode points to a writable DWORD.
        if unsafe { windows_sys::Win32::System::Console::GetConsoleMode(self.handle()?, &mut mode) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(mode)
    }

    fn set_mode(&mut self, mode: u32) -> io::Result<()> {
        // SAFETY: the owned CONIN$ handle remains live for the call.
        if unsafe { windows_sys::Win32::System::Console::SetConsoleMode(self.handle()?, mode) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) type RawMode = RawInput<Console>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct FakeConsole {
        mode: Rc<Cell<u32>>,
        fail: Rc<Cell<bool>>,
    }

    impl ConsoleMode for FakeConsole {
        fn mode(&mut self) -> io::Result<u32> {
            Ok(self.mode.get())
        }
        fn set_mode(&mut self, mode: u32) -> io::Result<()> {
            if self.fail.get() {
                return Err(io::Error::other("console mode fixture failure"));
            }
            self.mode.set(mode);
            Ok(())
        }
    }

    fn input(original: u32) -> (RawInput<FakeConsole>, FakeConsole) {
        let console = FakeConsole { mode: Rc::new(Cell::new(original)), fail: Rc::new(Cell::new(false)) };
        (RawInput { console: console.clone(), original: None }, console)
    }

    #[test]
    fn raw_byte_input_enables_vt_and_restores_every_original_input_flag() {
        for original in 0..=0x03ff {
            let (mut input, console) = input(original);
            assert!(!input.is_raw(), "Node's new ReadStream starts with isRaw=false");
            input.set(true).unwrap();
            assert_eq!(console.mode.get(), (original & !COOKED_INPUT) | VIRTUAL_TERMINAL_INPUT);
            assert!(input.is_raw());
            input.set(false).unwrap();
            assert_eq!(console.mode.get(), original);
            assert!(!input.is_raw());
            input.set(false).unwrap();
            assert_eq!(console.mode.get(), original);
        }
    }

    #[test]
    fn nested_raw_sessions_and_both_emergency_orders_restore_the_outer_snapshot() {
        for original in [0x01f3, 0x01f0, 0x03f7] {
            let (mut input, console) = input(original);
            input.set(true).unwrap();
            let nested_was_raw = input.is_raw();
            input.set(true).unwrap();
            input.set(nested_was_raw).unwrap();
            assert_eq!(console.mode.get(), (original & !COOKED_INPUT) | VIRTUAL_TERMINAL_INPUT);
            input.set(false).unwrap();
            assert_eq!(console.mode.get(), original);
            for order in [[false, true], [true, false]] {
                input.set(true).unwrap();
                input.set(true).unwrap();
                for was_raw in order {
                    input.restore(was_raw).unwrap();
                }
                assert_eq!(console.mode.get(), original);
                assert!(!input.is_raw());
            }
        }
    }

    #[test]
    fn failed_mode_changes_retain_the_snapshot_and_drop_restores_it() {
        let original = 0x01f3;
        let (mut input, console) = input(original);
        console.fail.set(true);
        assert!(input.set(true).is_err());
        assert!(!input.is_raw());
        assert_eq!(console.mode.get(), original);
        console.fail.set(false);
        input.set(true).unwrap();
        console.fail.set(true);
        assert!(input.set(false).is_err());
        assert!(input.is_raw());
        console.fail.set(false);
        drop(input);
        assert_eq!(console.mode.get(), original);
    }
}
