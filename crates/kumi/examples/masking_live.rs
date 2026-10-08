//! Opt-in check on real Live that masking reads through processing on Main (#289): it adds a "vocal" (Drift, a
//! melody) and a louder bed in the same register, puts a Limiter on Main, and judges the vocal cutting through over
//! the mix. Masking stays on the checklist (heard against the mix as it comes into Main's chain, by a second Kumi
//! Ears device first on Main), and that device is gone from Main after the listen, and after one stopped partway.
//! Then it takes everything back with Kumi's undo. No model and no sign-in. It works in the open Set (it never opens
//! or closes one): name it, and use a disposable one.
//!   cargo build --release -p ableton-mcp-server --bins
//!   cargo run --release -p kumi --example masking_live -- --set "<Set name>"
use futures::FutureExt;
use kumi::config::find_bridge_config;
use kumi_common::{
    abort::{self, Signal},
    js::string::{head, trim},
    time::now_ms,
};
use kumi_runtime::{
    core::contracts::ChangeState,
    create_ableton_integration,
    integrations::ableton::{connection::Connect, AbletonOptions},
    mcp::client,
    system::Env,
    ChangeRecord, Integration, JsonObject, KernelTool, Observation, RuntimeError, BRIDGE_TOOLS,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| argv.iter().position(|arg| arg == flag).and_then(|at| argv.get(at + 1)).map(|value| trim(value).to_owned());
    let Some(wanted) = value("--set").filter(|name| !name.is_empty()) else {
        eprintln!("Name the open Set, as Live shows it: cargo run --release -p kumi --example masking_live -- --set \"<Set name>\"");
        eprintln!("It adds two tracks and a Limiter on Main, judges, and undoes it all, so use a disposable Set.");
        std::process::exit(2);
    };
    let env: Env = std::env::vars().collect();
    let Some(bridge_config) = find_bridge_config(&env) else {
        eprintln!("The Ableton bridge isn't installed; run Kumi's bridge setup first.");
        std::process::exit(2);
    };
    let bridge = bridge_program();
    if !bridge.is_file() {
        eprintln!(
            "The Ableton bridge isn't built ({}); build it first: cargo build --release -p ableton-mcp-server --bins",
            bridge.display()
        );
        std::process::exit(2);
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
    let local = tokio::task::LocalSet::new();
    std::process::exit(local.block_on(&runtime, masking_live(wanted, bridge_config, bridge)));
}

fn bridge_program() -> PathBuf {
    let name = if cfg!(windows) { "ableton-mcp-server.exe" } else { "ableton-mcp-server" };
    let mut folder = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default();
    if folder.file_name().is_some_and(|name| name == "examples") {
        folder.pop();
    }
    folder.join(name)
}

fn connect_to(bridge: PathBuf, config: String) -> Connect {
    Rc::new(move |signal| {
        client::connect_mcp(client::Options {
            signal,
            bridge_config: Some(PathBuf::from(&config)),
            entry: Some(bridge.clone()),
            cwd: bridge.parent().map(Path::to_path_buf),
            allow_tools: BRIDGE_TOOLS.clone(),
            ..Default::default()
        })
        .boxed_local()
    })
}

struct Run {
    integration: Rc<dyn Integration>,
    observation: RefCell<Option<Observation>>,
    records: Rc<RefCell<Vec<ChangeRecord>>>,
    passed: RefCell<Vec<bool>>,
}

async fn masking_live(wanted: String, bridge_config: String, bridge: PathBuf) -> i32 {
    let records = Rc::new(RefCell::new(Vec::<ChangeRecord>::new()));
    let mut options = AbletonOptions::new(Rc::new(|_, _| {}));
    options.bridge_config = Some(bridge_config.clone());
    options.connect = Some(connect_to(bridge, bridge_config));
    options.on_change = Some({
        let records = records.clone();
        Rc::new(move |change: ChangeRecord| {
            let mut records = records.borrow_mut();
            match records.iter_mut().find(|record| record.id == change.id) {
                Some(record) => *record = change,
                None => records.push(change),
            }
        })
    });
    options.change_timeout_ms = Some(30_000);
    let run =
        Run { integration: create_ableton_integration(options), observation: RefCell::new(None), records, passed: RefCell::new(vec![]) };
    let code = match run.check(&wanted).await {
        Ok(()) => {
            let passed = run.passed.borrow();
            let good = passed.iter().filter(|ok| **ok).count();
            println!("\n{good} of {} passed.", passed.len());
            i32::from(good != passed.len())
        }
        Err(error) => {
            eprintln!("masking-live: {}", head(&error.message(), 300));
            1
        }
    };
    println!("\nUndo, newest first");
    run.undo_all().await;
    let _ = run.integration.close().await;
    code
}

impl Run {
    fn say(&self, ok: bool, what: &str) {
        self.passed.borrow_mut().push(ok);
        println!("  {}  {what}", if ok { "ok  " } else { "FAIL" });
    }

    async fn observe(&self) -> Result<Observation, RuntimeError> {
        let observation = self.integration.observe(signal(), None).await?;
        *self.observation.borrow_mut() = Some(observation.clone());
        Ok(observation)
    }

    async fn call(&self, name: &str, input: Value) -> Result<Value, String> {
        self.call_until(name, input, signal()).await
    }

    async fn call_until(&self, name: &str, input: Value, signal: Signal) -> Result<Value, String> {
        let tool: Option<Rc<dyn KernelTool>> =
            self.observation.borrow().as_ref().and_then(|seen| seen.tools.iter().find(|tool| tool.name() == name).cloned());
        let Some(tool) = tool else { return Err(format!("{name} isn't offered for this Set")) };
        let input = match input {
            Value::Object(input) => input,
            _ => JsonObject::new(),
        };
        match tool.execute(input, signal).await {
            Ok(result) if !result.is_error => Ok(serde_json::from_str(&result.text).unwrap_or(Value::String(result.text))),
            Ok(result) => Err(head(&result.text, 400)),
            Err(error) => Err(head(&error.message(), 400)),
        }
    }

    async fn rows(&self, kind: &str, extra: Value) -> Vec<Value> {
        let mut input = json!({"kind": kind, "limit": 100});
        input.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        self.call("live_discover", input)
            .await
            .map(|body| body["live"]["items"].as_array().cloned().unwrap_or_default())
            .unwrap_or_default()
    }

    /// A MIDI track playing `notes` (pitch and velocity, a quarter note each, two beats apart) through Drift, for
    /// eight bars in the Arrangement from its start.
    async fn part(&self, name: &str, notes: &[(i64, i64)]) -> Result<(), RuntimeError> {
        let added = self
            .call("add_tracks_and_scenes", json!({"tracks": [{"name": name, "kind": "midi"}], "scenes": []}))
            .await
            .map_err(RuntimeError::plain)?;
        let track = added["live"]["created"].as_array().and_then(|created| created.iter().find(|item| item["kind"] == "track").cloned());
        let track = track.ok_or_else(|| RuntimeError::plain("the new track didn't come back"))?;
        let rows: Vec<Value> = (0..8)
            .flat_map(|step| notes.iter().map(move |(pitch, velocity)| json!({"pitch": pitch + [0, 2, 4, 7, 9, 7, 4, 2][step], "start": step * 2, "duration": 1.75, "velocity": velocity})))
            .collect();
        self.call("write_midi_clip", json!({"trackRef": track["ref"], "sceneIndex": 0, "name": name, "length": 16, "notes": rows}))
            .await
            .map_err(RuntimeError::plain)?;
        let found = self.call("live_browser_search", json!({"category": "instruments", "query": "Drift", "limit": 1})).await;
        let item = found.ok().map(|found| found["live"]["items"][0].clone()).filter(|item| !item.is_null());
        let item = item.ok_or_else(|| RuntimeError::plain("Drift isn't in Live's browser"))?;
        self.call("load_device", json!({"itemId": item["id"], "trackRef": track["ref"]})).await.map_err(RuntimeError::plain)?;
        self.observe().await?;
        let tracks = self.rows("track", json!({"fields": ["name"]})).await;
        let track = tracks.iter().rfind(|row| row["name"] == name).cloned().ok_or_else(|| RuntimeError::plain("track gone"))?;
        let slots = self.rows("clip-slot", json!({"parent": track["ref"], "fields": ["clipRef"]})).await;
        let clip = slots.first().map(|slot| slot["clipRef"].clone()).filter(Value::is_string);
        let clip = clip.ok_or_else(|| RuntimeError::plain("the clip didn't come back"))?;
        for copy in 0..2 {
            self.call("duplicate_clip", json!({"clipRef": clip, "arrangementPosition": copy * 16})).await.map_err(RuntimeError::plain)?;
        }
        Ok(())
    }

    /// Main's devices now, by name.
    async fn main_devices(&self) -> Vec<String> {
        let main = self.rows("main-track", json!({"fields": ["name"]})).await;
        let Some(main) = main.first() else { return vec!["(Main not read)".into()] };
        let devices = self.rows("device", json!({"parent": main["ref"], "fields": ["name", "className"]})).await;
        devices.iter().map(|row| row["name"].as_str().unwrap_or("?").to_owned()).collect()
    }

    async fn check(&self, wanted: &str) -> Result<(), RuntimeError> {
        self.integration.start(signal()).await?;
        let observation = self.observe().await?;
        let context: Value = serde_json::from_str(&observation.context).unwrap_or(Value::Null);
        let set = context["set"]["name"].as_str().unwrap_or("?").to_owned();
        if set != wanted {
            println!("The open Set is “{set}”, not “{wanted}”; nothing was changed.");
            return Err(RuntimeError::plain("not the Set named"));
        }
        let tag = now_ms() % 10_000;
        let (vocal, bed) = (format!("Kumi Vocal {tag}"), format!("Kumi Bed {tag}"));
        println!("Two tracks of its own: “{vocal}” (a melody) and “{bed}” (louder chords in its register), Drift each");
        self.part(&vocal, &[(84, 90)]).await?;
        self.part(&bed, &[(83, 127), (86, 127), (88, 127), (91, 127)]).await?;
        let before = self.main_devices().await;
        let main = self.rows("main-track", json!({"fields": ["name"]})).await;
        let main = main.first().cloned().ok_or_else(|| RuntimeError::plain("Main wasn't read"))?;
        let found = self.call("live_browser_search", json!({"category": "audio_effects", "query": "Limiter", "limit": 1})).await;
        let item = found.ok().map(|found| found["live"]["items"][0].clone()).filter(|item| !item.is_null());
        let item = item.ok_or_else(|| RuntimeError::plain("Limiter isn't in Live's browser"))?;
        self.call("load_device", json!({"itemId": item["id"], "trackRef": main["ref"]})).await.map_err(RuntimeError::plain)?;
        self.observe().await?;
        let limited = self.main_devices().await;
        println!("Main's chain: {} → {}", before.join(", "), limited.join(", "));
        let goal = json!({"goal": {"focus": vocal, "problems": true}, "from_beat": 0, "beats": 32});

        println!("\nJudged over the mix, the vocal cutting through, with a Limiter on Main");
        match self.call_until("judge", goal.clone(), abort::timeout(600_000)).await {
            Ok(round) => {
                let text = round.to_string();
                let masking = round["rows"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"].as_str().is_some_and(|id| id.starts_with("masking"))));
                self.say(masking, &format!("masking is on the checklist: {}", head(&text, 300)));
                self.say(!text.contains("can't be read through Main's chain"), "no note that masking can't be read through Main");
            }
            Err(why) => self.say(false, &format!("the judge: {why}")),
        }
        let after = self.main_devices().await;
        self.say(after == limited, &format!("Main's chain after the listen: {}", after.join(", ")));
        let _ = self.call("judge", json!({"done": true})).await;

        println!("\nThe same, stopped partway through its listen");
        let stop = Signal::new();
        let stopping = stop.clone();
        tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            stopping.cancel();
        });
        let stopped = self.call_until("judge", goal, stop).await;
        println!("  (the judge answered: {})", head(&format!("{stopped:?}"), 200));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        self.observe().await?;
        let after = self.main_devices().await;
        self.say(after == limited, &format!("Main's chain after the stopped listen: {}", after.join(", ")));
        Ok(())
    }

    async fn undo_all(&self) {
        let records = self.records.borrow().clone();
        for record in records.iter().rev().filter(|record| record.state == ChangeState::Applied) {
            match self.integration.undo(Some(&record.id), signal()).await {
                Ok(after) => println!("  {:?} · {}", after.state, record.title),
                Err(error) => println!("  FAIL {}: {}", record.title, head(&error.message(), 200)),
            }
        }
    }
}

fn signal() -> Signal {
    abort::timeout(120_000)
}
