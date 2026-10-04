//! The stdin reader owns kernel reads only while the stream is resumed.

#[cfg(unix)]
mod unix {
    use std::io::{self, Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Condvar, Mutex};

    use super::super::Message;

    struct State {
        active: bool,
        ready: bool,
        finished: bool,
    }

    struct Control {
        state: Mutex<State>,
        changed: Condvar,
    }

    pub(in super::super) struct Reader {
        control: Arc<Control>,
        wake: UnixStream,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Reader {
        pub(in super::super) fn new(sender: tokio::sync::mpsc::UnboundedSender<Message>) -> io::Result<Self> {
            let control =
                Arc::new(Control { state: Mutex::new(State { active: false, ready: true, finished: false }), changed: Condvar::new() });
            let (wake, mut wake_reader) = UnixStream::pair()?;
            wake.set_nonblocking(true)?;
            wake_reader.set_nonblocking(true)?;
            let reader_control = control.clone();
            let thread = std::thread::Builder::new().name("kumi-stdin".into()).spawn(move || {
                let mut buffer = [0u8; 4096];
                loop {
                    let mut state = reader_control.state.lock().unwrap_or_else(|error| error.into_inner());
                    while !state.finished && !(state.active && state.ready) {
                        state = reader_control.changed.wait(state).unwrap_or_else(|error| error.into_inner());
                    }
                    if state.finished {
                        break;
                    }
                    drop(state);
                    let mut fds = [
                        libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 },
                        libc::pollfd { fd: wake_reader.as_raw_fd(), events: libc::POLLIN, revents: 0 },
                    ];
                    // SAFETY: both descriptors remain valid for this thread's lifetime.
                    let polled = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
                    if polled < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        let _ = sender.send(Message::Error(error));
                        break;
                    }
                    if fds[1].revents != 0 {
                        while wake_reader.read(&mut [0u8; 64]).is_ok_and(|count| count != 0) {}
                    }
                    let mut state = reader_control.state.lock().unwrap_or_else(|error| error.into_inner());
                    if state.finished {
                        break;
                    }
                    if !state.active || !state.ready {
                        continue;
                    }
                    // Raw mode may have changed after the first poll. Recheck while holding
                    // the same lock as pause and mode changes, before the unbuffered read.
                    fds[0].revents = 0;
                    let ready = unsafe { libc::poll(fds.as_mut_ptr(), 1, 0) };
                    if ready <= 0 {
                        continue;
                    }
                    // SAFETY: the buffer is valid, and readiness was checked under the read lock.
                    let count = unsafe { libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(), buffer.len()) };
                    let message = if count < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        Message::Error(error)
                    } else if count == 0 {
                        Message::End
                    } else {
                        Message::Data(buffer[..count as usize].to_vec())
                    };
                    let done = !matches!(message, Message::Data(_));
                    state.ready = false;
                    state.finished = done;
                    drop(state);
                    if sender.send(message).is_err() || done {
                        break;
                    }
                }
                reader_control.state.lock().unwrap_or_else(|error| error.into_inner()).finished = true;
            })?;
            Ok(Self { control, wake, thread: Some(thread) })
        }

        pub(in super::super) fn resume(&self) {
            self.control.state.lock().unwrap_or_else(|error| error.into_inner()).active = true;
            self.control.changed.notify_one();
        }

        pub(in super::super) fn pause(&self) {
            self.control.state.lock().unwrap_or_else(|error| error.into_inner()).active = false;
            self.wake();
        }

        /// A callback can pause the input before another kernel read is admitted.
        pub(in super::super) fn acknowledge(&self) {
            self.control.state.lock().unwrap_or_else(|error| error.into_inner()).ready = true;
            self.control.changed.notify_one();
        }

        pub(in super::super) fn with_mode<T>(&self, change: impl FnOnce() -> T) -> T {
            let _state = self.control.state.lock().unwrap_or_else(|error| error.into_inner());
            let result = change();
            self.wake();
            result
        }

        pub(in super::super) fn guard_restorer(&self, restore: crate::input::RawModeRestorer) -> crate::input::RawModeRestorer {
            let control = self.control.clone();
            Arc::new(move |enabled| {
                let _state = control.state.lock().unwrap_or_else(|error| error.into_inner());
                restore(enabled);
            })
        }

        fn wake(&self) {
            // A full wake socket already guarantees that the poll will return.
            let _ = (&self.wake).write(&[1]);
        }
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            self.control.state.lock().unwrap_or_else(|error| error.into_inner()).finished = true;
            self.control.changed.notify_one();
            self.wake();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(unix)]
pub(super) use unix::Reader;
