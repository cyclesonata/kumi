//! Differential request and stream checks against the exact installed TypeScript SDK.

use async_trait::async_trait;
use futures::StreamExt;
use kumi_runtime::ai::{
    anthropic::{anthropic, AnthropicSettings},
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
fn difference(actual: &Value, expected: &Value, path: &str) -> String {
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                if b.get(key) != Some(value) {
                    return difference(value, b.get(key).unwrap_or(&Value::Null), &format!("{path}.{key}"));
                }
            }
            format!("{path}: different object fields")
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                if a != b {
                    return difference(a, b, &format!("{path}[{index}]"));
                }
            }
            format!("{path}: equal arrays")
        }
        _ => format!("{path}: {actual} != {expected}"),
    }
}
async fn compatible(test: Value) {
    let expected = oracle(&test);
    let request = Rc::new(RefCell::new(Value::Null));
    let fetch: Rc<dyn Fetch> = Rc::new(Fixture { events: test["events"].as_str().unwrap().into(), request: request.clone() });
    let model = if test["provider"] == "anthropic" {
        anthropic(AnthropicSettings {
            model: test["model"].as_str().unwrap().into(),
            base_url: "http://fixture/v1".into(),
            api_key: Some("fixture-key".into()),
            auth_token: None,
            headers: Default::default(),
            fetch,
        })
    } else {
        openai_compatible(CompatibleSettings {
            name: test.get("name").and_then(Value::as_str).unwrap_or("fixture").into(),
            model: test["model"].as_str().unwrap().into(),
            base_url: "http://fixture/v1".into(),
            api_key: Some("fixture-key".into()),
            headers: Default::default(),
            fetch,
            include_usage: true,
        })
    };
    let options: CallOptions = serde_json::from_value(test["options"].clone()).unwrap();
    let stream = model.do_stream(options).await;
    if let Some(expected_error) = expected.get("error") {
        let error = match stream {
            Err(error) => error,
            Ok(_) => panic!("expected SDK error {expected_error}"),
        };
        let actual = if let LanguageModelError::ApiCall(error) = error {
            json!({"message":error.message,"url":error.url,"requestBodyValues":error.request_body_values,"statusCode":error.status_code,"responseBody":error.response_body,"isRetryable":error.is_retryable})
        } else {
            json!({"message":error.to_string()})
        };
        let actual: Value = serde_json::from_str(&kumi_common::js::json::stringify(&actual)).unwrap();
        assert_eq!(actual, *expected_error);
        return;
    }
    let parts: Vec<_> = stream.unwrap().collect().await;
    assert_eq!(*request.borrow(), expected["request"], "request differs");
    let actual: Value = serde_json::from_str(&kumi_common::js::json::stringify(&serde_json::to_value(parts).unwrap())).unwrap();
    assert!(actual == expected["parts"], "stream differs: {}", difference(&actual, &expected["parts"], "parts"));
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

fn anthropic_events(blocks: Vec<Value>, reason: &str) -> String {
    let mut events = vec![
        json!({"type":"message_start","message":{"id":"message-1","type":"message","role":"assistant","model":"claude-opus-4-6","content":[],"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":4,"cache_creation_input_tokens":2},"stop_reason":null,"stop_sequence":null}}),
    ];
    events.extend(blocks);
    events.push(json!({"type":"message_delta","delta":{"stop_reason":reason,"stop_sequence":null},"usage":{"output_tokens":5,"output_tokens_details":{"thinking_tokens":2}}}));
    events.push(json!({"type":"message_stop"}));
    sse(events)
}
#[tokio::test]
async fn anthropic_cached_prompt_signed_reasoning_and_usage_match_the_sdk() {
    compatible(json!({"provider":"anthropic","model":"claude-opus-4-6","options":{
        "prompt":[{"role":"system","content":"Produce.","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}},
        {"role":"user","content":[{"type":"text","text":"Start"}]},
        {"role":"assistant","content":[{"type":"reasoning","text":"Think","providerOptions":{"anthropic":{"signature":"earlier"}}},{"type":"tool-call","toolCallId":"before","toolName":"tempo","input":{}},{"type":"text","text":"Checking."}]},
        {"role":"tool","content":[{"type":"tool-result","toolCallId":"before","toolName":"tempo","output":{"type":"text","value":"120"}}],"providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}}],
        "tools":[{"type":"function","name":"tempo","description":"Read","inputSchema":{"type":"object"}}],"toolChoice":{"type":"auto"},"providerOptions":{"anthropic":{"effort":"high"}}
    },"events":anthropic_events(vec![
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Consider."}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"120."}}),
        json!({"type":"content_block_stop","index":1}),
    ],"end_turn")})).await;
}
#[tokio::test]
async fn anthropic_tool_fragments_images_and_caller_metadata_match_the_sdk() {
    compatible(json!({"provider":"anthropic","model":"claude-sonnet-4-5","options":{
        "prompt":[{"role":"user","content":[{"type":"text","text":"Look"},{"type":"file","mediaType":"image/png","data":{"type":"data","data":"AQID"}}]},
        {"role":"assistant","content":[{"type":"reasoning","text":"hidden","providerOptions":{"anthropic":{"redactedData":"encrypted"}}},{"type":"tool-call","toolCallId":"before","toolName":"look","input":{"area":1},"providerOptions":{"anthropic":{"caller":{"type":"code_execution_20250825","toolId":"exec"}}}}]},
        {"role":"tool","content":[{"type":"tool-result","toolCallId":"before","toolName":"look","output":{"type":"content","value":[{"type":"text","text":"View"},{"type":"file","mediaType":"image/png","data":{"type":"data","data":"AQID"}}]}}]}],
        "tools":[{"type":"function","name":"look","inputSchema":{"type":"object"},"strict":true}],"toolChoice":{"type":"required"}
    },"events":anthropic_events(vec![
        json!({"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"secret"}}),json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"look","input":{},"caller":{"type":"code_execution_20250825","tool_id":"exec"}}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"area\":"}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"2}"}}),json!({"type":"content_block_stop","index":1}),
    ],"tool_use")})).await;
}
#[tokio::test]
async fn anthropic_model_limits_cache_breakpoints_and_choices_match_the_sdk() {
    for model in ["claude-opus-4-6", "claude-opus-5-5", "claude-3-7-sonnet-latest", "claude-future", "unknown"] {
        compatible(json!({"provider":"anthropic","model":model,"options":{
            "prompt":[{"role":"system","content":"First","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}},{"role":"system","content":"Second","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}},{"role":"user","content":[{"type":"text","text":"Ask","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}}]},{"role":"assistant","content":[{"type":"reasoning","text":"No signature"},{"type":"text","text":"  Answer  ","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}}]}],
            "temperature":2,"topP":0.5,"topK":20,"frequencyPenalty":1,"presencePenalty":1,"seed":1,
            "tools":[{"type":"function","name":"tempo","inputSchema":{"type":"object"},"strict":false,"providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}}],"toolChoice":{"type":"tool","toolName":"tempo"}
        },"events":anthropic_events(vec![],"max_tokens")})).await;
    }
}
#[tokio::test]
async fn anthropic_stream_errors_after_metadata_preserve_provider_fields() {
    compatible(json!({"provider":"anthropic","model":"claude-haiku-4-5","options":{"prompt":[{"role":"user","content":[{"type":"text","text":"Hi"}]}]},"events":sse(vec![
        json!({"type":"message_start","message":{"id":"message-1","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
        json!({"type":"error","error":{"type":"overloaded_error","message":"Busy"}})
    ])})).await;
}
#[tokio::test]
async fn anthropic_initial_errors_become_retryable_api_errors_like_the_sdk() {
    for kind in ["overloaded_error", "authentication_error", "rate_limit_error", "unknown"] {
        compatible(json!({"provider":"anthropic","model":"claude-haiku-4-5","options":{"prompt":[],"includeRawChunks":true},"events":sse(vec![json!({"type":"error","error":{"type":kind,"message":"Failed"}})])})).await;
    }
}
#[tokio::test]
async fn anthropic_prepopulated_tools_compaction_iterations_and_metadata_match_the_sdk() {
    compatible(json!({"provider":"anthropic","model":"claude-opus-4-6","options":{"prompt":[],"includeRawChunks":true},"events":sse(vec![
        json!({"type":"message_start","message":{"id":"m1","model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":1},"content":[{"type":"tool_use","id":"early","name":"tempo","input":{"unit":"bpm"}}],"container":{"id":"container","expires_at":"later"}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"compaction","content":"Summary","signature":"sig"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":{"type":"refusal","category":"test","explanation":"why","recommended_model":"other"}},"usage":{"output_tokens":9,"iterations":[{"type":"compaction","input_tokens":10,"output_tokens":2},{"type":"message","input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}]},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_tool_uses":2,"cleared_input_tokens":10}]}}),
        json!({"type":"message_stop"})
    ])})).await;
}
