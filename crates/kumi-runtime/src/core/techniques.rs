//! Port of `packages/runtime/src/core/techniques.ts`.
//!
//! Not ported yet.

use regex::Regex;
use std::sync::LazyLock;
/// Requests to match something: "make it sound like this", "recreate this sound", "match the reference".
pub static MATCHING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(sounds? (more )?like|sound closer to|recreate|re-create|match(ing)?|like (this|the) reference|copy (this|that) sound)\b",
    )
    .unwrap()
});
