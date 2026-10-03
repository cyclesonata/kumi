//! Port of `packages/runtime/src/core/match-run.ts`.
//!
//! Match runs: for "make it sound like this", the harness decides when to stop, not the model. Each
//! time the model ends its answer, the run looks at the auditions so far (auditioning the current
//! best itself when something changed since), and either ends it (the target reached, no gain after
//! trying something genuinely different, or the budget spent) or sends the model back in with the
//! score, what's left of the budget and the biggest gaps. A first draft can't end a run.

use serde::{Deserialize, Serialize};

use super::goal::Best;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchStop {
    Reached,
    Plateau,
    Budget,
    NoAudition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchState {
    Running,
    Done,
}

/// What the app shows while a run works: its check, the best so far and where it started, and how long it's been (a `{ type: "match" }` session event).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchStatus {
    pub state: MatchState,
    pub check: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<Best>,
    pub elapsed_ms: i64,
    pub rounds_left: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<MatchStop>,
}
