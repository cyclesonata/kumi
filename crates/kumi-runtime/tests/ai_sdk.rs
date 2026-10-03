//! Differential request and stream checks against the exact installed TypeScript SDK.

use async_trait::async_trait;
use futures::StreamExt;
use kumi_runtime::ai::{
    error::LanguageModelError,
    http::{Fetch, FetchInit, Response},
    openai_compatible::{openai_compatible, CompatibleSettings},
    types::CallOptions,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    rc::Rc,
};
struct Fixture {
    events: String,
    request: Rc<RefCell<Value>>,
}
#[async_trait(?Send)]
impl Fetch for Fixture {
    async fn fetch(&self, url: &str, init: FetchInit) -> Result<Response, LanguageModelError> {
        *self.request.borrow_mut() = json!({"url":url,"body":serde_json::from_str::<Value>(init.body.as_ref().unwrap()).unwrap()});
        Ok(Response::text_response(200, self.events.clone()))
    }
}
fn oracle(test: &Value) -> Value {
    let mut command = Command::new("node");
    command
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/ai_sdk_oracle.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("SDK parity tests need Node and npm ci");
    child.stdin.take().unwrap().write_all(serde_json::to_string(test).unwrap().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn compatible(test: Value) {
    let expected = oracle(&test);
    let request = Rc::new(RefCell::new(Value::Null));
    let model = openai_compatible(CompatibleSettings {
        name: test.get("name").and_then(Value::as_str).unwrap_or("fixture").into(),
        model: test["model"].as_str().unwrap().into(),
        base_url: "http://fixture/v1".into(),
        api_key: Some("fixture-key".into()),
        headers: Default::default(),
        fetch: Rc::new(Fixture { events: test["events"].as_str().unwrap().into(), request: request.clone() }),
        include_usage: true,
    });
    let options: CallOptions = serde_json::from_value(test["options"].clone()).unwrap();
    let parts: Vec<_> = model.do_stream(options).await.unwrap().collect().await;
    assert_eq!(*request.borrow(), expected["request"], "request differs");
    let actual: Value = serde_json::from_str(&kumi_common::js::json::stringify(&serde_json::to_value(parts).unwrap())).unwrap();
    assert_eq!(actual, expected["parts"], "stream differs");
    assert_eq!(
        kumi_common::js::json::stringify(&request.borrow()["body"]),
        kumi_common::js::json::stringify(&expected["request"]["body"]),
        "request key order differs"
    );
}
fn sse(chunks: Vec<Value>) -> String {
    chunks.iter().map(|chunk| format!("data: {chunk}\n\n")).collect::<String>() + "data: [DONE]\n\n"
}
#[tokio::test]
async fn compatible_text_reasoning_usage_and_provider_options_match_the_sdk() {
    compatible(json!({"provider":"compatible","name":"fixture-local","model":"qwen3","options":{"prompt":[{"role":"system","content":"Produce."},{"role":"user","content":[{"type":"text","text":"Tempo?"}]}],"providerOptions":{"fixtureLocal":{"reasoningEffort":"high","custom":true}}},"events":sse(vec![
        json!({"id":"reply","created":10,"model":"qwen3","choices":[{"delta":{"reasoning_content":"Consider."},"finish_reason":null}]}),
        json!({"choices":[{"delta":{"content":"120."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":1,"accepted_prediction_tokens":2}}})])})).await;
}
#[tokio::test]
async fn compatible_tool_call_streams_replay_and_parallel_tool_indices_match_the_sdk() {
    compatible(json!({"provider":"compatible","model":"model","options":{"prompt":[{"role":"assistant","content":[{"type":"reasoning","text":"Read"},{"type":"tool-call","toolCallId":"before","toolName":"tempo","input":{}}]},{"role":"tool","content":[{"type":"tool-result","toolCallId":"before","toolName":"tempo","output":{"type":"text","value":"120"}}]}],"tools":[{"type":"function","name":"tempo","description":"Read","inputSchema":{"type":"object"}}],"toolChoice":{"type":"auto"}},"events":sse(vec![
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"{"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"tempo","arguments":"\"precise\":"}},{"index":1,"id":"c2","function":{"name":"play","arguments":"{}"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"true}"}}]},"finish_reason":"tool_calls"}]}),json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":10}})])})).await;
}
#[tokio::test]
async fn compatible_structured_content_metadata_and_function_call_ids_match_the_sdk() {
    compatible(json!({"provider":"compatible","model":"model","options":{"prompt":[{"role":"user","content":[{"type":"text","text":"Look","providerOptions":{"openaiCompatible":{"marker":true}}},{"type":"file","mediaType":"image/png","data":{"type":"data","data":"AQID"}}]}],"providerOptions":{"fixture":{"reasoningEffort":"medium"}}},"events":sse(vec![
        json!({"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"Think"}]},{"type":"text","text":"Look"}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"id":"one","function":{"name":"look","arguments":"{}"},"extra_content":{"google":{"thought_signature":"signature"}}}]},"finish_reason":"function_call"}]})])})).await;
}

#[tokio::test]
async fn compatible_optional_parameters_defaults_and_tool_choices_match_the_sdk() {
    let plain = sse(vec![json!({"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]})]);
    for choice in ["auto", "none", "required", "tool"] {
        let tool_choice = if choice == "tool" { json!({"type":"tool","toolName":"tempo"}) } else { json!({"type":choice}) };
        compatible(json!({"provider":"compatible","name":"custom-server","model":"model","options":{
            "prompt":[{"role":"user","content":[{"type":"text","text":"Hello"}]}],
            "maxOutputTokens":100,"temperature":0.5,"topP":0.9,"topK":5,"presencePenalty":0.2,"frequencyPenalty":0.1,"stopSequences":["end"],"seed":10,
            "responseFormat":{"type":"json","schema":{"type":"object"}},
            "providerOptions":{"openai-compatible":{"user":"first"},"openaiCompatible":{"reasoningEffort":"low"},"custom-server":{"user":"second"},"customServer":{"reasoningEffort":"high","custom":true}},
            "tools":[{"type":"function","name":"tempo","inputSchema":{"type":"object"},"strict":false}],"toolChoice":tool_choice
        },"events":plain})).await;
    }
}
