//! Cancellation in the shape the TypeScript used: an `AbortSignal` that work checks and awaits.
//!
//! A [`Signal`] is a `tokio_util` `CancellationToken`. `Signal::timeout(ms)` is `AbortSignal.timeout`,
//! `Signal::any` is `AbortSignal.any`, [`Signal::check`] is `signal.throwIfAborted()`, and a
//! [`Controller`] is an `AbortController`.

use std::time::Duration;

pub use tokio_util::sync::CancellationToken as Signal;

/// `new Error("...")` thrown by `throwIfAborted`: the work was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Aborted;

impl std::fmt::Display for Aborted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Operation cancelled")
    }
}

impl std::error::Error for Aborted {}

/// `AbortSignal` methods beyond the token's own.
pub trait SignalExt {
    /// `signal.throwIfAborted()`.
    fn check(&self) -> Result<(), Aborted>;
    /// `signal.aborted`.
    fn aborted(&self) -> bool;
}

impl SignalExt for Signal {
    fn check(&self) -> Result<(), Aborted> {
        if self.is_cancelled() {
            Err(Aborted)
        } else {
            Ok(())
        }
    }
    fn aborted(&self) -> bool {
        self.is_cancelled()
    }
}

/// `AbortSignal.timeout(ms)`: a signal that fires after `ms` (needs a Tokio runtime).
pub fn timeout(ms: u64) -> Signal {
    let signal = Signal::new();
    let fired = signal.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        fired.cancel();
    });
    signal
}

/// `AbortSignal.any([...])`: a signal that fires when any of `signals` does (needs a Tokio runtime).
pub fn any<I: IntoIterator<Item = Signal>>(signals: I) -> Signal {
    let combined = Signal::new();
    for signal in signals {
        if signal.is_cancelled() {
            combined.cancel();
            break;
        }
        let fire = combined.clone();
        tokio::spawn(async move {
            signal.cancelled().await;
            fire.cancel();
        });
    }
    combined
}

/// A signal that never fires: `new AbortController().signal` left alone.
pub fn never() -> Signal {
    Signal::new()
}

/// `AbortController`: owns a signal and fires it.
#[derive(Debug, Clone, Default)]
pub struct Controller {
    pub signal: Signal,
}

impl Controller {
    pub fn new() -> Self {
        Self { signal: Signal::new() }
    }
    /// `controller.abort()`.
    pub fn abort(&self) {
        self.signal.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn any_fires_with_the_first() {
        let a = Controller::new();
        let b = Controller::new();
        let both = any([a.signal.clone(), b.signal.clone()]);
        assert!(!both.aborted());
        b.abort();
        both.cancelled().await;
        assert!(both.check().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_fires_after_its_delay() {
        let signal = timeout(50);
        assert!(!signal.aborted());
        tokio::time::advance(Duration::from_millis(60)).await;
        signal.cancelled().await;
        assert!(signal.aborted());
    }
}
