//! Port of `packages/runtime/src/core/goal.ts`.
//!
//! Goal mode (/goal): Kumi goes after a sound or part until it gets there, the producer stops it, or
//! a safety cap of hours. Code does most of the searching (evolve.rs: knobs nudged, crossed and
//! redrawn around the best, a generation of candidates rendered in one silent pass); the model makes
//! the structural leaps, every few generations or when the search stalls. A goal is kept on disk as it
//! goes, so it survives a restart and /goal picks it up again.

use serde::{Deserialize, Serialize};

use super::contracts::AuditionRequest;
use super::evolve::Slot;

/// Where a goal is: searching, left for later, or over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalRun {
    Running,
    Paused,
    Done,
}

/// A goal as kept on disk: what it's after, where the part is, and the search so far.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub version: u32,
    pub goal: String,
    /// The reference, the span and the focus, as the setup audition gave them (candidates by track name).
    pub request: AuditionRequest,
    /// The candidates play their Session clips (copied into the Arrangement for each render).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clips: Option<bool>,
    pub slots: Vec<Slot>,
    pub generation: u32,
    pub rendered: u32,
    pub trend: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<f64>,
    pub elapsed_ms: i64,
    pub status: GoalRun,
    /// What the model tried last (a leap), and where the best was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best_track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// Its lesson in the playbook, updated as the goal goes on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lesson: Option<String>,
}

/// A goal's state as the app shows it: the search's, or "starting" before it has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalPhase {
    Running,
    Paused,
    Done,
    Starting,
}

impl From<GoalRun> for GoalPhase {
    fn from(run: GoalRun) -> Self {
        match run {
            GoalRun::Running => Self::Running,
            GoalRun::Paused => Self::Paused,
            GoalRun::Done => Self::Done,
        }
    }
}

/// The best so far: its label and score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Best {
    pub label: String,
    pub score: f64,
}

/// What the app shows of a goal: the dashboard's numbers (a `{ type: "goal" }` session event).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStatus {
    pub state: GoalPhase,
    pub goal: String,
    pub generation: u32,
    pub rendered: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<Best>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<f64>,
    pub trend: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leader: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    pub elapsed_ms: i64,
    pub candidates: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best_track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}
