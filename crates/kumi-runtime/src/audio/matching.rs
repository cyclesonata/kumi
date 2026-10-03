//! Port of `packages/runtime/src/audio/match.ts`.
//!
//! How close a render is to a reference, as one number to watch rise while matching a sound, and the
//! differences behind it, biggest first, in words the model can act on ("brighter above 4 kHz by
//! ~3 dB", "attack too slow", "too dense"). Each feature is a similarity from 0 to 1; the score is
//! their weighted mean, weighted for a single sound (timbre, envelope, pitch) or a section (balance,
//! density and rhythm too). The target is a similar character: a patch rarely matches a finished mix.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureName {
    Balance,
    Tilt,
    Brightness,
    Movement,
    Envelope,
    Pitch,
    Density,
    Width,
    Rhythm,
    Contour,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Feature {
    pub name: FeatureName,
    /// 0 to 100.
    pub similarity: f64,
    pub weight: f64,
    /// What to change, when it's far enough off to matter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<String>,
}

/// What a comparison weighs for: a single sound, or a section of a mix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Focus {
    Sound,
    Section,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralKind {
    MissingLow,
    ExcessLow,
    MissingTop,
    ExcessTop,
    MissingMids,
    ExcessMids,
    Envelope,
    Register,
    Pitched,
    Width,
    Density,
}

/// A gap no knob closes (a band 9 dB or more off, an attack three times off, the wrong register, far
/// too wide or narrow), when it's the largest part of what's lost: what it is, and the structural
/// change that closes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Structural {
    pub kind: StructuralKind,
    pub gap: String,
    pub r#move: String,
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Closeness {
    /// 0 to 100: the weighted mean of the features both sides have.
    pub score: f64,
    pub focus: Focus,
    pub features: Vec<Feature>,
    /// The biggest gaps, in words, biggest first.
    pub gaps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structural: Option<Structural>,
}

// The rest of audio/match.ts is ported by the audio agent.
