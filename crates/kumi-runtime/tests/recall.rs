//! Finding earlier conversations in every Set, and kept recipes, by their words.
use async_trait::async_trait;
use kumi_common::{abort, time::now_ms};
use kumi_runtime::{
    core::{
        contracts::{ConversationStore, KernelTool, SavedConversation},
        errors::RuntimeError,
        recall::*,
        recipes::{Recipe, RecipeStore},
    },
    integrations::ableton::project::create_conversation_store,
};
use serde_json::{json, Value};
use std::rc::Rc;

const NIGHT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAWN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DAY: i64 = 86_400_000;

fn exchange(said: &str, answer: &str, tools: &[&str]) -> Vec<Value> {
    let mut content: Vec<Value> =
        tools.iter().map(|tool| json!({"type":"tool-call","toolCallId":"call","toolName":tool,"input":{}})).collect();
    content.push(json!({"type":"text","text":answer}));
    vec![
        json!({"role":"user","content":[{"type":"text","text":format!("{said}\n\n<current_observation_untrusted>{{}}")}]}),
        json!({"role":"assistant","content":content}),
    ]
}
fn conversation(saved_at: i64, exchanges: Vec<Vec<Value>>, changes: Value) -> SavedConversation {
    let mut value = json!({"savedAt":saved_at,"checkpoint":{"version":1,"messages":exchanges.concat()}});
    if !changes.is_null() {
        value["changes"] = changes;
    }
    serde_json::from_value(value).unwrap()
}
struct Recipes(Vec<Recipe>);
#[async_trait(?Send)]
impl RecipeStore for Recipes {
    async fn list(&self) -> Result<Vec<Recipe>, RuntimeError> {
        Ok(self.0.clone())
    }
    async fn get(&self, name: &str) -> Result<Option<Recipe>, RuntimeError> {
        Ok(self.0.iter().find(|r| r.name == name).cloned())
    }
    async fn save(&self, _: &Recipe) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn remove(&self, _: &str) -> Result<bool, RuntimeError> {
        Ok(false)
    }
}
async fn search(tool: &Rc<dyn KernelTool>, query: &str) -> (bool, String) {
    let result = tool.execute(json!({"query":query}).as_object().unwrap().clone(), abort::never()).await.unwrap();
    (result.is_error, result.text)
}

#[tokio::test(flavor = "current_thread")]
async fn earlier_conversations_in_every_set_and_recipes_are_found_by_their_words() {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let store = create_conversation_store(&projects);
    let now = now_ms();
    let night = conversation(
        now - 6 * DAY,
        vec![
            exchange(
                "Make the vocal reverb chain warmer",
                "I put Hybrid Reverb after EQ Eight on Vocal and darkened its tail.",
                &["make_changes"],
            ),
            exchange("Now glue the drums", "A bus compressor on Drums, 2 dB of gain reduction.", &["make_changes"]),
        ],
        json!([
            {"id":"c1","family":"device","title":"Added “Hybrid Reverb” to “Lead Vocal”","state":"applied","at":1},
            {"id":"c2","family":"device","title":"Added “Shimmer” to “Lead Vocal”","state":"undone","at":2}
        ]),
    );
    store.save(NIGHT, "night1", &night).await.unwrap();
    // The Set's name comes from the start of its baseline, before pages that name other things.
    std::fs::write(
        projects.join(NIGHT).join("last-seen.json"),
        json!({"version":1,"path":"/Music/Night Drive.als","name":"Night Drive","savedAt":1,"artifactId":"a","pages":[{"records":[{"name":"Decoy"}]}]}).to_string(),
    )
    .unwrap();
    store
        .save(
            DAWN,
            "dawn01",
            &conversation(now - DAY, vec![exchange("Tune the kick", "Tuned the kick to F.", &["make_changes"])], Value::Null),
        )
        .await
        .unwrap();
    store
        .save(
            "unsaved",
            "loose1",
            &conversation(now - 2 * DAY, vec![exchange("ボーカルにリバーブを足して", "Hybrid Reverb を足しました。", &[])], Value::Null),
        )
        .await
        .unwrap();
    let recipes: Vec<Recipe> = serde_json::from_value(json!([
        {"version":1,"name":"Vocal chain","about":"EQ, compression and a short reverb for a vocal","params":[],"steps":[{"tool":"load_device"}],"created":1,"used":0},
        {"version":1,"name":"Drum bus","about":"glue compression on a return","params":[],"steps":[{"tool":"load_device"}],"created":1,"used":0}
    ]))
    .unwrap();
    let tool = |current: Option<(&str, &str)>| {
        let current = current.map(|(place, id)| (place.to_owned(), id.to_owned()));
        recall_tool(RecallOptions {
            conversations: Some(store.clone()),
            techniques: None,
            recipes: Some(Rc::new(Recipes(recipes.clone()))),
            current: Rc::new(move || current.clone()),
        })
    };
    let elsewhere = tool(Some((DAWN, "dawn01")));

    assert_eq!(query_words("the reverb chain from last week's vocal"), ["reverb", "chain", "vocal"]);
    let (error, text) = search(&elsewhere, "the reverb chain from last week's vocal").await;
    assert!(!error, "{text}");
    for expected in [
        "<earlier_conversations_untrusted>",
        "- In “Night Drive”, 6 days ago",
        "  The producer: Make the vocal reverb chain warmer",
        "  Kumi: I put Hybrid Reverb after EQ Eight on Vocal and darkened its tail. [used make_changes]",
        "Recipes (run one with run_recipe):\n- Vocal chain: EQ, compression and a short reverb for a vocal",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in\n{text}");
    }
    for absent in ["Tune the kick", "Now glue the drums", "Drum bus", "Decoy"] {
        assert!(!text.contains(absent), "{absent:?} in\n{text}");
    }
    // What a conversation changed is found too, under its first request.
    let (_, text) = search(&elsewhere, "hybrid reverb lead").await;
    assert!(text.contains("Kumi: Changed: Added “Hybrid Reverb” to “Lead Vocal”") && !text.contains("Shimmer"), "{text}");
    // Japanese and Chinese have no spaces between words: pairs of characters still find it.
    let (_, text) = search(&elsewhere, "ボーカルのリバーブ").await;
    assert!(text.contains("In a Set not saved yet, 2 days ago") && text.contains("ボーカルにリバーブを足して"), "{text}");
    // This Set is named, and the conversation going on now isn't searched: it's in the request already.
    let (_, text) = search(&tool(Some((NIGHT, "other"))), "glue drums").await;
    assert!(text.contains("- In “Night Drive” (this Set)"), "{text}");
    let (_, text) = search(&tool(Some((NIGHT, "night1"))), "glue drums").await;
    assert!(!text.contains("Now glue the drums") && text.contains("Drum bus"), "{text}");
    let (error, text) = search(&elsewhere, "granular shimmer").await;
    assert!(!error && text.starts_with("Nothing kept from before holds those words (granular, shimmer)"), "{text}");
    let (error, _) = search(&elsewhere, "the last week").await;
    assert!(error);
}
