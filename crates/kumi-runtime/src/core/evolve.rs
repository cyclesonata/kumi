//! Port of `packages/runtime/src/core/evolve.ts`.
//!
//! The goal mode's cheap monkeys: an evolutionary search over the knobs of a few candidate chains,
//! with no model call. Each slot is a track with its own chain; a candidate is a set of values for
//! that chain's knobs. Each generation proposes one trial per slot: a few knobs nudged around the
//! slot's best (the step shrinking as it fails, growing as it succeeds), now and then a crossover
//! with another slot of the same chain, now and then a fresh random draw to keep looking wide.
//! Selection keeps each slot's best (an elite per chain, so no one family takes over), and the
//! weakest slot, stuck for long, is reseeded from the leader. Structural leaps (new instruments,
//! topologies) are the model's, between generations.

use serde::{Deserialize, Serialize};

/// A knob a trial may move: its place, its range, and whether it moves in steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Knob {
    pub r#ref: String,
    pub device: String,
    pub name: String,
    pub min: f64,
    pub max: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slot {
    /// The track's name: slots are found again by it after a reconnect.
    pub name: String,
    pub label: String,
    /// What chain it is (its devices in order): crossover only between slots of one chain.
    pub chain: String,
    pub knobs: Vec<Knob>,
    /// The best values found for this slot, and their score.
    pub elite: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// How far a nudge goes, in the knob's own range (0–1), and generations without gain.
    pub sigma: f64,
    pub stale: u32,
    /// How many renders its best score is the mean of: a render varies, so a lucky one is heard again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heard: Option<u32>,
}
