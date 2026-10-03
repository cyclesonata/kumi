//! Privacy-preserving, bounded semantic Set snapshots.
use crate::project::ProjectError;
use kumi_common::js::{json, string};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, sync::LazyLock};
use unicode_normalization::UnicodeNormalization;

pub const SEMANTIC_PROJECT_SNAPSHOT_SCHEMA: &str = "ableton-mcp-semantic-set-snapshot/v1";
pub const SEMANTIC_PROJECT_MAX_RECORDS: usize = 12_000;
pub const SEMANTIC_PROJECT_MAX_PAGE_RECORDS: usize = 200;
pub const SEMANTIC_PROJECT_MAX_PAGE_BYTES: usize = 512 * 1024;
pub const SEMANTIC_PROJECT_MAX_BUNDLE_BYTES: usize = 1024 * 1024 * 1024;
pub const SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES: usize = 1024 * 1024 * 1024;
pub const SEMANTIC_PROJECT_MAX_PAGES: usize = 2048;
pub const SECTION_ORDER: [&str; 8] = ["set", "tracks", "scenes", "locators", "clips", "devices", "dependencies", "unavailable"];
pub type SemanticProjectArtifact = Value;
pub type SemanticProjectPage = Value;
pub type SemanticProjectRecord = Value;
pub type SemanticPrivacyProfile = str;
pub(crate) fn fail(message: impl Into<String>) -> ProjectError {
    ProjectError(message.into())
}
pub fn compare_semantic_strings(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
pub fn canonical_semantic_json(value: &Value) -> Result<String, ProjectError> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> Result<String, ProjectError> {
        *nodes += 1;
        if *nodes > 100_000_000 {
            return Err(fail("semantic artifact exceeds the canonical node bound"));
        }
        if depth > 24 {
            return Err(fail("semantic artifact exceeds the canonical depth bound"));
        }
        Ok(match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => json::stringify(value),
            Value::String(s) => {
                if string::utf16_len(s) > 4096 {
                    return Err(fail("semantic artifact string exceeds the bound"));
                }
                json::stringify(value)
            }
            Value::Array(rows) => {
                if rows.len() > 10_000_000 {
                    return Err(fail("semantic artifact array exceeds the bound"));
                }
                format!("[{}]", rows.iter().map(|row| visit(row, depth + 1, nodes)).collect::<Result<Vec<_>, _>>()?.join(","))
            }
            Value::Object(object) => {
                if object.len() > 64 || object.keys().any(|key| string::utf16_len(key) > 128) {
                    return Err(fail("semantic artifact object exceeds field or key bounds"));
                }
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort_by(|a, b| compare_semantic_strings(a, b));
                let mut rows = Vec::with_capacity(keys.len());
                for key in keys {
                    rows.push(format!("{}:{}", json::stringify(&json!(key)), visit(&object[key], depth + 1, nodes)?));
                }
                format!("{{{}}}", rows.join(","))
            }
        })
    }
    visit(value, 0, &mut 0)
}
pub(crate) fn digest(value: &Value) -> Result<String, ProjectError> {
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(canonical_semantic_json(value)?))))
}
fn short_digest(value: &Value) -> Result<String, ProjectError> {
    Ok(digest(value)?[7..27].to_owned())
}
fn bounded_string(value: &Value) -> String {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| string::head(&s.nfc().collect::<String>(), 512))
        .unwrap_or_else(|| "unavailable".into())
}
// JavaScript's \s (Unicode WhiteSpace + LineTerminator), deliberately excluding U+0085.
pub(crate) const JS_SPACE: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
fn regex(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\s", JS_SPACE).replace(r"\S", &format!("[^{0}]", &JS_SPACE[1..JS_SPACE.len() - 1]))).unwrap()
}
fn absolute_path(value: &str) -> bool {
    static PATH: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r#"(?i)^\s*[\\/]|(?:^|[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}"'(=])(?:[A-Za-z]:[\\/]|\\\\)|["'(=]\s*/|\s/\S|[A-Za-z][A-Za-z0-9+.-]*:[\\/]{1,2}"#,
        )
    });
    PATH.is_match(value)
}
fn authority(value: &str) -> bool {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)(?:reusable[-_ ]?(?:(?:mutation|access|authority|confirmation|recovery)[-_ ]?)?(?:token|secret|confirmation)|bearer\s+[A-Za-z0-9._-]{8,}|(?:access|authority|idempotency|recovery|preflight)[-_ ]?(?:token|secret|key)\s*[:=]?)",
        )
    });
    PATTERN.is_match(value)
}
fn live_reference(value: &str) -> bool {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)^(?:[0-9]+:)?(?:set|track|return[_-]track|main[_-]track|scene|clip[_-]slot|clip|session[_-]playback|arrangement[_-]clip|take[_-]lane(?:[_-]clip)?|groove|note|automation|locator|device|parameter|chain|drum[_-]pad|routing[_-]choice|browser[_-]item|selection):\S+$",
        )
    });
    PATTERN.is_match(value)
}
fn dynamic_string(profile: &str, kind: &str, value: &Value, strict_alias: bool) -> String {
    let normalized = bounded_string(value);
    if absolute_path(&normalized) || authority(&normalized) || live_reference(&normalized) || (profile == "strict" && strict_alias) {
        format!("{kind}-{}", short_digest(&json!([kind, normalized])).expect("bounded normalized name"))
    } else {
        normalized
    }
}
pub fn semantic_project_name(profile: &str, kind: &str, value: &Value) -> String {
    dynamic_string(profile, kind, value, true)
}
