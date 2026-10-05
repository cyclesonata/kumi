//! First-run setup in the app: only the missing steps, each done in place, then the session.
#[path = "support/models.rs"]
mod models;
#[path = "support/tui_app.rs"]
mod support;
use async_trait::async_trait;
use kumi::tui::{
    app::{ConnectLive, LiveSetup, TuiOptions},
    icons::IconStyle,
    style::ColorDepth,
};
use kumi_common::abort::Signal;
use models::FakeModels;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use support::*;
macro_rules! case {
    ($name:ident,$body:expr) => {
        #[tokio::test(flavor = "current_thread")]
        async fn $name() {
            tokio::task::LocalSet::new().run_until($body).await;
        }
    };
}

const LIVE: &str = "/Applications/Ableton Live 12 Suite.app";
const MISSING: &str = "The Ableton bridge isn't in Live yet, so Kumi can't see your Set.";

struct FakeLive {
    calls: RefCell<Vec<String>>,
    open: RefCell<Option<String>>,
    /// Live closes as soon as it's asked to (or, for "I'll restart it", once the test says so).
    closes: Cell<bool>,
    installs: RefCell<Vec<Result<String, String>>>,
}
impl FakeLive {
    fn new(open: bool) -> Rc<Self> {
        Rc::new(Self {
            calls: RefCell::default(),
            open: RefCell::new(open.then(|| LIVE.to_string())),
            closes: Cell::new(true),
            installs: RefCell::default(),
        })
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}
#[async_trait(?Send)]
impl LiveSetup for FakeLive {
    async fn open_live(&self) -> Option<String> {
        self.calls.borrow_mut().push("open?".into());
        self.open.borrow().clone()
    }
    async fn ask_to_quit(&self) {
        self.calls.borrow_mut().push("quit".into());
    }
    async fn closed(&self, stop: &Signal) -> bool {
        self.calls.borrow_mut().push("closed?".into());
        if self.closes.get() {
            self.open.borrow_mut().take();
            return true;
        }
        stop.cancelled().await;
        false
    }
    async fn install(&self) -> Result<String, String> {
        self.calls.borrow_mut().push("install".into());
        let next = self.installs.borrow_mut().pop();
        next.unwrap_or_else(|| Ok("1.0.74".into()))
    }
    async fn start(&self, app: Option<String>) -> bool {
        self.calls.borrow_mut().push(format!("start {}", app.unwrap_or_default()).trim().into());
        true
    }
    async fn connect(&self) {
        self.calls.borrow_mut().push("connect".into());
    }
    async fn version(&self, _: Option<String>) -> Option<String> {
        Some("12.4".into())
    }
}

fn unsigned() -> Rc<FakeModels> {
    let models = FakeModels::catalog();
    *models.model.borrow_mut() = None;
    models.signed_in.borrow_mut().clear();
    models
}
fn setup(
    width: i32,
    models: Rc<FakeModels>,
    live: Option<(Option<&str>, Rc<FakeLive>)>,
    configure: impl FnOnce(&mut TuiOptions),
) -> Harness {
    Harness::with(width, 30, Rc::new(Control::default()), |o| {
        o.models = Some(models);
        o.connect_live = live.map(|(why, live)| ConnectLive { why: why.map(str::to_string), bridge: "1.0.74".into(), live });
        configure(o)
    })
}
fn rows(h: &Harness) -> String {
    let lines = h.screen();
    let last = lines.iter().rposition(|l| !l.trim().is_empty()).unwrap_or(0);
    lines[..=last].iter().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n")
}

case!(a_first_run_signs_in_puts_the_bridge_in_and_waits_for_the_control_surface, async {
    let live = FakeLive::new(false);
    let models = unsigned();
    let h = setup(80, models.clone(), Some((Some(MISSING), live.clone())), |_| {});
    h.start().await;
    h.wait_for("How do you want to sign in?").await;
    let first = rows(&h);
    println!("--- sign in, 80 columns ---\n{first}");
    let kumi = first.lines().nth(1).unwrap();
    assert!(kumi.starts_with("  kumi") && kumi.ends_with(kumi_runtime::KUMI_VERSION), "{kumi}");
    assert_eq!(first.lines().nth(2).unwrap().trim(), kumi::tui::app::waveform(kumi::tui::app::WAVE_WIDTH, None), "still");
    for line in [
        "  Sign in             now",
        "  Connect to Live",
        "  Control Surface",
        "  How do you want to sign in?",
        "  › ChatGPT           your ChatGPT plan · opens your browser",
        "    Anthropic         paste an API key",
        "    OpenCode          paste an API key",
        "  ↑↓ choose · enter select · esc later",
    ] {
        assert!(first.lines().any(|l| l == line), "{line:?} in\n{first}");
    }
    // Anthropic: a pasted key, checked, then the provider's own first model.
    h.type_text("\x1b[B\r").await;
    h.wait_for("Paste your Anthropic API key").await;
    h.has("Sign in             paste a key");
    h.input.write("sk-ant-fixture");
    h.type_text("\r").await;
    h.wait_for("Anthropic · done").await;
    assert_eq!(models.model.borrow().as_deref(), Some("anthropic/claude-sonnet-5-5"), "the first in Anthropic's list");
    // Live was closed: the bridge goes in, Live opens, and the session connects through it.
    h.wait_for("waiting for Live").await;
    let surface = rows(&h);
    println!("--- control surface ---\n{surface}");
    for line in [
        "  Sign in             Anthropic · done",
        "  Connect to Live     bridge 1.0.74 · done",
        "  Control Surface     waiting for Live",
        "  In Live, open Settings › Link, Tempo & MIDI and set a",
        "  Control Surface to AbletonMcpBridge. Kumi notices by itself.",
        "  esc later",
    ] {
        assert!(surface.lines().any(|l| l == line), "{line:?} in\n{surface}");
    }
    assert_eq!(live.calls(), ["open?", "install", "start", "connect"]);
    h.emit(json!({"type":"connection","state":"connected"}));
    h.wait_for("You're set.").await;
    let set = rows(&h);
    println!("--- set ---\n{set}");
    h.has("Control Surface     Live 12.4 · connected");
    h.type_text("\r").await;
    h.wait_until_hidden("You're set.").await;
    h.has("Kumi talks to Claude Sonnet 5.5, Anthropic's first choice.");
    h.close().await;
});

case!(an_open_live_is_restarted_only_when_asked_and_esc_puts_setup_off, async {
    // "I'll restart it": Kumi waits for Live to close, and esc leaves setup for later.
    let live = FakeLive::new(true);
    live.closes.set(false);
    let h = setup(80, FakeModels::catalog(), Some((Some(MISSING), live.clone())), |_| {});
    h.start().await;
    h.wait_for("Restart Live now").await;
    let restart = rows(&h);
    println!("--- live open ---\n{restart}");
    for line in [
        "  Sign in             ChatGPT · done",
        "  Connect to Live     Live is open · restart needed",
        "  › Restart Live now",
        "    I'll restart it   Kumi waits",
    ] {
        assert!(restart.lines().any(|l| l == line), "{line:?} in\n{restart}");
    }
    for line in ["  Live loads the bridge when it starts.", "  Live will ask to save first."] {
        assert!(restart.lines().any(|l| l == line), "{line:?} in\n{restart}");
    }
    h.type_text("\x1b[B\r").await;
    h.wait_for("waiting for you to quit Live").await;
    h.type_text("\x1b").await;
    h.wait_for("Kumi chats without Live for now, and offers to connect it next time.").await;
    assert_eq!(live.calls(), ["open?", "closed?"], "nothing quit, nothing installed");
    h.close().await;
    // "Restart Live now": Live is asked to quit (it asks to save), then the bridge goes in and the same Live opens.
    let live = FakeLive::new(true);
    let h = setup(80, FakeModels::catalog(), Some((Some(MISSING), live.clone())), |_| {});
    h.start().await;
    h.wait_for("Restart Live now").await;
    h.type_text("\r").await;
    h.wait_for("waiting for Live").await;
    assert_eq!(live.calls(), ["open?", "quit", "closed?", "install", format!("start {LIVE}").as_str(), "connect"]);
    h.close().await;
});

case!(an_install_that_fails_says_why_and_can_be_tried_again, async {
    let live = FakeLive::new(false);
    live.installs.borrow_mut().push(Err("Kumi couldn't find Live's User Library. Open Live once so it makes one.".into()));
    let h = setup(80, FakeModels::catalog(), Some((Some(MISSING), live.clone())), |_| {});
    h.start().await;
    h.wait_for("Try again").await;
    let failed = rows(&h);
    println!("--- install failed ---\n{failed}");
    h.has("Connect to Live     didn't finish");
    h.has("Kumi couldn't find Live's User Library.");
    h.type_text("\r").await;
    h.wait_for("bridge 1.0.74 · done").await;
    assert_eq!(live.calls().iter().filter(|c| *c == "install").count(), 2);
    h.close().await;
});

case!(only_the_missing_steps_run_and_a_set_up_kumi_starts_straight_away, async {
    // Set up: no setup at all.
    let live = FakeLive::new(false);
    let h = setup(80, FakeModels::catalog(), Some((None, live.clone())), |_| {});
    h.start().await;
    h.connect();
    h.wait_for("Night Drive").await;
    assert!(!h.screen().iter().any(|l| l.contains("Sign in") || l.contains("Connect to Live")));
    assert!(live.calls().is_empty(), "no process looked at, nothing installed");
    h.close().await;
    // Only signing in is missing: the bridge shows as done, and Live connects as it stands.
    let live = FakeLive::new(false);
    let h = setup(80, unsigned(), Some((None, live.clone())), |_| {});
    h.start().await;
    h.wait_for("How do you want to sign in?").await;
    h.has("Connect to Live     bridge 1.0.74 · done");
    // Esc: later. No model picker opens; /login says how.
    h.type_text("\x1b").await;
    h.wait_for("Sign in when you're ready with /login").await;
    assert!(!h.screen().iter().any(|l| l.contains("Choose a model")));
    assert!(live.calls().is_empty());
    h.close().await;
    // Signed in, with no model chosen yet: the provider's own first choice, and no setup.
    let models = FakeModels::catalog();
    *models.model.borrow_mut() = None;
    let h = setup(80, models, Some((None, FakeLive::new(false))), |_| {});
    h.start().await;
    h.wait_for("Kumi talks to GPT-6 Astra, ChatGPT's first choice.").await;
    assert!(!h.screen().iter().any(|l| l.contains("How do you want to sign in?")));
    h.close().await;
});

case!(the_browser_sign_in_moves_the_waveform_and_narrow_or_plain_terminals_drop_it, async {
    let models = unsigned();
    let h = setup(80, models.clone(), Some((Some(MISSING), FakeLive::new(false))), |_| {});
    h.start().await;
    h.wait_for("How do you want to sign in?").await;
    h.type_text("\r").await;
    h.wait_for("Finish signing in in your browser.").await;
    h.has("Sign in             waiting for the browser");
    h.has("If it didn't open, open this link (c copies it):");
    h.has("https://auth.example.test/oauth/authorize");
    h.has("c copies the link · esc back");
    let wave = |h: &Harness| h.screen()[2].trim().to_string();
    let before = wave(&h);
    delay(250).await;
    assert_ne!(wave(&h), before, "it moves while Kumi waits for the browser");
    // Esc goes back to the choices; the waveform rests again.
    h.type_text("\x1b").await;
    h.wait_for("How do you want to sign in?").await;
    assert_eq!(wave(&h), kumi::tui::app::waveform(kumi::tui::app::WAVE_WIDTH, None));
    h.close().await;
    // Narrow: everything wraps within the window.
    let h = setup(44, unsigned(), Some((Some(MISSING), FakeLive::new(false))), |_| {});
    h.start().await;
    h.wait_for("How do you want to sign in?").await;
    let narrow = rows(&h);
    println!("--- 44 columns ---\n{narrow}");
    assert!(narrow.lines().all(|l| l.chars().count() <= 44), "{narrow}");
    h.has("Connect to Live");
    h.close().await;
    // NO_COLOR, and badges instead of glyphs: no waveform.
    for configure in [
        Box::new(|o: &mut TuiOptions| o.color_depth = Some(ColorDepth::None)) as Box<dyn FnOnce(&mut TuiOptions)>,
        Box::new(|o: &mut TuiOptions| o.icons = Some(IconStyle::Badges)),
    ] {
        let h = setup(80, unsigned(), Some((Some(MISSING), FakeLive::new(false))), configure);
        h.start().await;
        h.wait_for("How do you want to sign in?").await;
        let plain = rows(&h);
        assert!(!plain.contains('⣀'), "{plain}");
        assert_eq!(plain.lines().nth(3).unwrap().trim(), "Sign in             now", "{plain}");
        h.close().await;
    }
});
