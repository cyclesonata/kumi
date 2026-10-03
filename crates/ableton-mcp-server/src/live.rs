//! Port of `apps/mcp-server/src/live.ts`.
//!
//! Live-domain contract and deterministic simulator.
//!
//! The simulator is deliberately an adapter test double: it models stable
//! references and state transitions without claiming that Ableton Live is
//! installed or connected. A Remote Script/Extension can implement the same
//! contract at the protocol boundary.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::LazyLock;

use async_trait::async_trait;
use kumi_common::abort::Signal;
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::registry::{live_registry_hash, live_registry_operations, RegistryError};

pub const LIVE_PROTOCOL_VERSION: &str = "ableton-live/v1";
// SHA-256 of canonical sorted-key JSON, so negotiation is invariant to the
// checkout's LF/CRLF policy on macOS and Windows.
pub static LIVE_REGISTRY_HASH: LazyLock<&'static str> = LazyLock::new(live_registry_hash);
pub static LIVE_REGISTRY_OPERATIONS: LazyLock<&'static [String]> = LazyLock::new(live_registry_operations);

/// A string-valued enumeration, as the TypeScript's string unions: its text on the wire and in files.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(&self) -> &'static str { match self { $($name::$variant => $text),+ } }
            pub fn parse(text: &str) -> Option<$name> { match text { $($text => Some($name::$variant),)+ _ => None } }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.as_str()) }
        }
    };
}

string_enum! {
    /// What a connected Live can do, as the bridge advertises it.
    LiveCapability {
        SessionRead = "session.read", Tracks = "tracks", Scenes = "scenes", Clips = "clips", Notes = "notes",
        SessionDiscovery = "session.discovery", SessionStructure = "session.structure", SessionMidiClipCreate = "session.midi_clip.create", SessionMidiClipDelete = "session.midi_clip.delete", SessionMidiNoteRead = "session.midi_note.read", SessionMidiNoteWrite = "session.midi_note.write",
        ArrangementRead = "arrangement.read", ArrangementWrite = "arrangement.write", Audio = "audio", AudioCaptureResampling = "audio.capture.resampling", Warp = "warp", Takes = "takes",
        Automation = "automation", Devices = "devices", Racks = "racks", Chains = "chains", Parameters = "parameters", Browser = "browser",
        DeviceParameterWrite = "device.parameter.write",
        Routing = "routing", Recording = "recording", Projects = "projects", Mixing = "mixing", Transport = "transport", Max = "max", Osc = "osc", View = "view", Tuning = "tuning", Groove = "groove",
        RealtimeEvents = "realtime.events", Plugins = "plugins", Subscriptions = "subscriptions", Reconnect = "reconnect",
    }
}

pub const LIVE_CAPABILITIES: &[LiveCapability] = LiveCapability::ALL;

pub const LIVE_UNAVAILABLE_CAPABILITIES: &[LiveCapability] = &[
    LiveCapability::ArrangementRead,
    LiveCapability::ArrangementWrite,
    LiveCapability::Audio,
    LiveCapability::AudioCaptureResampling,
    LiveCapability::Warp,
    LiveCapability::Takes,
    LiveCapability::Automation,
    LiveCapability::Devices,
    LiveCapability::Racks,
    LiveCapability::Chains,
    LiveCapability::Parameters,
    LiveCapability::Browser,
    LiveCapability::Routing,
    LiveCapability::Recording,
    LiveCapability::Projects,
    LiveCapability::Mixing,
    LiveCapability::Max,
    LiveCapability::Osc,
    LiveCapability::RealtimeEvents,
    LiveCapability::Plugins,
];

pub const SIMULATOR_CAPABILITIES: &[LiveCapability] = &[
    LiveCapability::SessionRead,
    LiveCapability::Tracks,
    LiveCapability::Scenes,
    LiveCapability::Clips,
    LiveCapability::Notes,
    LiveCapability::SessionDiscovery,
    LiveCapability::SessionStructure,
    LiveCapability::SessionMidiClipCreate,
    LiveCapability::SessionMidiClipDelete,
    LiveCapability::SessionMidiNoteRead,
    LiveCapability::SessionMidiNoteWrite,
    LiveCapability::ArrangementRead,
    LiveCapability::ArrangementWrite,
    LiveCapability::Transport,
    LiveCapability::Devices,
    LiveCapability::Parameters,
    LiveCapability::DeviceParameterWrite,
    LiveCapability::Subscriptions,
    LiveCapability::Reconnect,
    LiveCapability::View,
    LiveCapability::Warp,
    LiveCapability::Takes,
    LiveCapability::Tuning,
    LiveCapability::Groove,
];

/// Capability derivation shared by the remote adapter's status validation and
/// the simulator's advertisement: a capability is advertised only when its
/// exact negotiated operations are present.
pub fn live_capabilities_for_operations<S: AsRef<str>>(operations: &[S]) -> Vec<LiveCapability> {
    let has = |operation: &str| operations.iter().any(|item| item.as_ref() == operation);
    let all = |required: &[&str]| required.iter().all(|operation| has(operation));
    let any = |required: &[&str]| required.iter().any(|operation| has(operation));
    let readable_hierarchy = all(&["snapshot", "discover", "get"]);
    let requirement = |capability: LiveCapability| -> bool {
        match capability {
            LiveCapability::SessionRead => readable_hierarchy && all(&["session.playback"]),
            LiveCapability::Tracks | LiveCapability::Scenes | LiveCapability::Clips | LiveCapability::Notes => readable_hierarchy,
            LiveCapability::SessionDiscovery => all(&["discover"]),
            LiveCapability::SessionStructure => any(&["track.create", "track.delete", "scene.create", "scene.delete"]),
            LiveCapability::SessionMidiClipCreate => all(&["clip.create"]),
            LiveCapability::SessionMidiClipDelete => all(&["clip.delete"]),
            LiveCapability::SessionMidiNoteRead => readable_hierarchy,
            LiveCapability::SessionMidiNoteWrite => all(&["note.add", "note.add-batch"]),
            LiveCapability::ArrangementRead => any(&["locator.add", "arrangement.clip.delete", "arrangement.automation.read"]),
            LiveCapability::ArrangementWrite => any(&[
                "locator.add",
                "locator.delete",
                "arrangement.clip.create",
                "arrangement.audio-clip.create",
                "arrangement.clip.delete",
            ]),
            LiveCapability::Audio => all(&["audio.clip.set"]),
            LiveCapability::AudioCaptureResampling => {
                all(&["audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.cleanup"])
            }
            LiveCapability::Warp => all(&["audio.warp-marker.read"]),
            LiveCapability::Takes => all(&["audio.take-lane.read"]),
            LiveCapability::Automation => all(&["automation.envelope.read"]),
            LiveCapability::Devices | LiveCapability::Racks | LiveCapability::Chains | LiveCapability::Parameters => readable_hierarchy,
            LiveCapability::Browser => all(&["browser.search"]),
            LiveCapability::DeviceParameterWrite => all(&["device.parameter.set"]),
            LiveCapability::Routing => all(&["routing.set"]),
            LiveCapability::Recording => any(&["recording.session", "recording.arrangement"]),
            LiveCapability::Projects => all(&["snapshot"]),
            LiveCapability::Mixing => all(&["mixer.set"]),
            LiveCapability::Transport => all(&["transport.set", "tempo.set"]),
            LiveCapability::Tuning => any(&["tuning.read", "tuning.set"]),
            LiveCapability::Groove => all(&["groove.read"]),
            LiveCapability::Max => false,
            LiveCapability::View => any(&["view.set", "view.control"]),
            LiveCapability::Osc | LiveCapability::RealtimeEvents => all(&["realtime.arm", "realtime.disarm", "realtime.stats"]),
            LiveCapability::Plugins => readable_hierarchy,
            LiveCapability::Subscriptions => all(&["subscribe"]),
            LiveCapability::Reconnect => all(&["reconnect"]),
        }
    };
    LIVE_CAPABILITIES.iter().copied().filter(|capability| requirement(*capability)).collect()
}

string_enum! {
    /// The kinds of simulator-local references (`kind:key`).
    LiveObjectKind {
        Set = "set", Track = "track", Scene = "scene", Clip = "clip", ClipSlot = "clip-slot", SessionPlayback = "session-playback", ArrangementClip = "arrangement-clip",
        TakeLane = "take-lane", TakeLaneClip = "take-lane-clip", Groove = "groove", Device = "device", Parameter = "parameter", Note = "note", Automation = "automation",
        Locator = "locator", Chain = "chain", DrumPad = "drum_pad",
    }
}

/// Opaque references are simulator-local (`kind:key`) or production mapper
/// references (`epoch:wire_kind:key`, the wire kinds being the object kinds above plus `clip_slot`,
/// `arrangement_clip`, `take_lane`, `take_lane_clip`, `groove`, `routing_choice`, `return_track`,
/// `main_track` and `browser_item`). Callers must never parse authority from either form; the adapter
/// performs epoch and object-identity checks.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LiveRef(pub String);

impl LiveRef {
    /// A simulator reference: `${kind}:${id}`.
    pub fn new(kind: LiveObjectKind, id: &str) -> LiveRef {
        LiveRef(format!("{}:{}", kind.as_str(), id))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// The kind this reference names (see [`ref_kind`]).
    pub fn kind(&self) -> Option<&str> {
        ref_kind(&self.0)
    }
    /// The track a positional Remote Script reference sits under (see [`track_index_of_ref`]).
    pub fn track_index(&self) -> Option<usize> {
        track_index_of_ref(&self.0)
    }
}

impl std::ops::Deref for LiveRef {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}
impl AsRef<str> for LiveRef {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
impl std::borrow::Borrow<str> for LiveRef {
    fn borrow(&self) -> &str {
        &self.0
    }
}
impl From<&str> for LiveRef {
    fn from(text: &str) -> LiveRef {
        LiveRef(text.to_string())
    }
}
impl From<String> for LiveRef {
    fn from(text: String) -> LiveRef {
        LiveRef(text)
    }
}
impl From<LiveRef> for String {
    fn from(reference: LiveRef) -> String {
        reference.0
    }
}
impl PartialEq<str> for LiveRef {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}
impl PartialEq<&str> for LiveRef {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}
impl PartialEq<String> for LiveRef {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}
impl PartialEq<LiveRef> for str {
    fn eq(&self, other: &LiveRef) -> bool {
        self == other.0
    }
}
impl PartialEq<LiveRef> for &str {
    fn eq(&self, other: &LiveRef) -> bool {
        *self == other.0
    }
}
impl std::fmt::Display for LiveRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

string_enum! {
    LiveMonitoringState { In = "in", Auto = "auto", Off = "off" }
}

string_enum! {
    LiveDiscoveryKind {
        Set = "set", Track = "track", ReturnTrack = "return-track", MainTrack = "main-track", Scene = "scene", ClipSlot = "clip-slot", SessionClip = "session-clip",
        ArrangementClip = "arrangement-clip", Note = "note", Locator = "locator", Device = "device", Parameter = "parameter", Selection = "selection",
        RoutingChoice = "routing-choice", SessionPlayback = "session-playback",
    }
}

/// A `foo?: T | null` field: absent, null, or a value. The three are kept apart because rows from Live
/// are fingerprinted as they come, and a key that is there with `null` hashes differently from one that
/// isn't.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Maybe<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Maybe<T> {
    /// `value ?? null` read as an option: the value, or none whether absent or null.
    pub fn value(&self) -> Option<&T> {
        match self {
            Maybe::Value(value) => Some(value),
            _ => None,
        }
    }
    pub fn is_absent(&self) -> bool {
        matches!(self, Maybe::Absent)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Maybe::Null)
    }
    /// `x ?? null` written back: a value, or null.
    pub fn null_or(value: Option<T>) -> Maybe<T> {
        match value {
            Some(value) => Maybe::Value(value),
            None => Maybe::Null,
        }
    }
    pub fn some(value: T) -> Maybe<T> {
        Maybe::Value(value)
    }
    pub fn into_option(self) -> Option<T> {
        match self {
            Maybe::Value(value) => Some(value),
            _ => None,
        }
    }
    pub fn cloned(&self) -> Option<T>
    where
        T: Clone,
    {
        self.value().cloned()
    }
    /// `x ?? null` as JSON: the value, or null.
    pub fn to_json(&self) -> Value
    where
        T: Serialize,
    {
        self.value().map(|value| serde_json::to_value(value).unwrap_or(Value::Null)).unwrap_or(Value::Null)
    }
}

impl<T: Serialize> Serialize for Maybe<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Maybe::Value(value) => value.serialize(serializer),
            Maybe::Absent | Maybe::Null => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Maybe<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Maybe<T>, D::Error> {
        Ok(Maybe::null_or(Option::<T>::deserialize(deserializer)?))
    }
}

/// `x ?? null` as JSON for a plain optional.
pub fn null_or_json<T: Serialize>(value: &Option<T>) -> Value {
    value.as_ref().map(|value| serde_json::to_value(value).unwrap_or(Value::Null)).unwrap_or(Value::Null)
}

/// What an operation runs under: its cancellation, deadline and transaction identity.
#[derive(Debug, Clone, Default)]
pub struct LiveOperationContext {
    pub signal: Option<Signal>,
    pub deadline_ms: f64,
    /// Stable host transaction authority; the remote adapter derives per-operation replay keys from it.
    pub idempotency_key: Option<String>,
    pub transaction_id: Option<String>,
}

impl LiveOperationContext {
    pub fn with_deadline(deadline_ms: f64) -> LiveOperationContext {
        LiveOperationContext { deadline_ms, ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDiscoveryRequest {
    pub kind: LiveDiscoveryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

impl LiveDiscoveryRequest {
    pub fn of(kind: LiveDiscoveryKind) -> LiveDiscoveryRequest {
        LiveDiscoveryRequest { kind, parent: None, filter: None, fields: None, budget: None, limit: None, cursor: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDiscoveryResult {
    pub epoch: i64,
    pub items: Vec<Map<String, Value>>,
    pub truncated: bool,
    pub revision: String,
    pub kind: LiveDiscoveryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlaybackTarget {
    pub track_ref: LiveRef,
    pub clip_slot_ref: LiveRef,
    pub scene_ref: LiveRef,
    pub scene_index: usize,
    pub clip_ref: Option<LiveRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchQuantization {
    /// A string, a number or null.
    pub raw: Value,
    pub normalized: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportLoop {
    pub enabled: Option<bool>,
    pub start: Option<f64>,
    pub length: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTransport {
    pub playing: Option<bool>,
    pub arrangement_record: Option<bool>,
    pub session_record: Option<bool>,
    pub position: Option<f64>,
    pub launch_quantization: LaunchQuantization,
    #[serde(rename = "loop")]
    pub loop_: TransportLoop,
    pub punch_in: Option<bool>,
    pub punch_out: Option<bool>,
    pub metronome: Option<bool>,
    pub count_in: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlaybackState {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub epoch: i64,
    pub revision: String,
    pub transport: SessionTransport,
    pub fired_targets: Vec<SessionPlaybackTarget>,
    pub playing_targets: Vec<SessionPlaybackTarget>,
}

string_enum! {
    LiveAdapterKind { Simulator = "simulator", RemoteScript = "remote-script", Extension = "extension", Unavailable = "unavailable", OfflineFile = "offline-file" }
}

string_enum! {
    LiveProvenance { RealLive = "real-live", FakeLive = "fake-live", Simulator = "simulator", Unknown = "unknown" }
}

/// Best-effort read-only runtime evidence reported by the adapter; every field may be unprobed (null).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEnvironment {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub live_version: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub live_edition: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub os: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub api: Maybe<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub connected: bool,
    pub adapter: LiveAdapterKind,
    pub epoch: Option<i64>,
    pub protocol: String,
    pub capabilities: Vec<LiveCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operations: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<LiveProvenance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub willington_kinds: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<LiveEnvironment>,
}

impl LiveStatus {
    /// Whether `operation` was negotiated (`status.operations?.includes(operation)`).
    pub fn has_operation(&self, operation: &str) -> bool {
        self.operations.as_ref().map(|operations| operations.iter().any(|item| item == operation)).unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub pitch: f64,
    pub start: f64,
    pub duration: f64,
    pub velocity: f64,
    pub channel: f64,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub mute: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub probability: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub velocity_deviation: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub release_velocity: Maybe<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Note {
    pub fn new(pitch: f64, start: f64, duration: f64, velocity: f64, channel: f64) -> Note {
        Note {
            pitch,
            start,
            duration,
            velocity,
            channel,
            id: Maybe::Absent,
            mute: Maybe::Absent,
            probability: Maybe::Absent,
            velocity_deviation: Maybe::Absent,
            release_velocity: Maybe::Absent,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPoint {
    pub time: f64,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<LiveRef>,
    pub name: String,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub automatable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub default_value: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub original_name: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub state: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub value_items: Maybe<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A rack chain's own mixer.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainMixer {
    pub volume: Option<f64>,
    pub pan: Option<f64>,
    pub sends: Vec<Option<f64>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub volume_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub panning_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_refs: Option<Vec<LiveRef>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub chain_activator_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixer_identity: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChain {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub parent_ref: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    /// Absent on a chain the simulator makes for a pad's sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub mute: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub solo: Maybe<bool>,
    pub devices: Vec<Device>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub auto_color: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_audio_input: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_audio_output: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_midi_input: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_midi_output: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub muted_via_solo: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub in_note: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub out_note: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub choke_group: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixer: Option<ChainMixer>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumPad {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub parent_ref: LiveRef,
    pub index: usize,
    pub name: String,
    pub mute: Option<bool>,
    pub chains: Vec<DeviceChain>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub note: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub solo: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

string_enum! {
    DeviceKind { Instrument = "instrument", AudioEffect = "audio-effect", MidiEffect = "midi-effect", Plugin = "plugin", Rack = "rack", Device = "device" }
}

/// A rack macro row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Macro {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_collapsed: Maybe<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceComparison {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub capability: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub active_side: Maybe<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RackView {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub selected_chain_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub selected_pad_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub pad_scroll_position: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub show_chain_devices: Maybe<bool>,
}

/// A device row. The device-family rows (`drift`, `eq8`, `hybridReverb`, `meld`, `drumCell`, `looper`,
/// `plugin`, `maxDevice`) are kept as the JSON objects Live sends; the TypeScript declared their fields as
/// `drift: { modSources?, modTargets?, pitchBendRange?, voiceCount?, voiceMode?, voiceCountList?, voiceModeList? }`,
/// `eq8: { editMode?, globalMode?, oversample?, selectedBand? }`, `hybridReverb: { irCategory?, irFile?,
/// irCategoryList?, irFileList?, attack?, decay?, size? }`, `meld: { engine?, unison?, monoPoly?, polyphony? }`,
/// `drumCell: { gain? }`, `looper: { overdubAfterRecord?, recordLengthIndex?, loopLength?, tempo?, state? }`,
/// `plugin: { presets?, selectedPresetIndex?, isEditorOpen? }` and `maxDevice: { audioIns?, audioOuts?, midiIns?,
/// midiOuts? }`, every one nullable. Other device-specific rows (`sample`, `wavetable`, `roar`, `deviceIo`...)
/// come in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<LiveRef>,
    pub name: String,
    pub kind: DeviceKind,
    pub parameters: Vec<Parameter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub can_have_chains: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub can_have_drum_pads: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chains: Option<Vec<DeviceChain>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drum_pads: Option<Vec<DrumPad>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macros: Option<Vec<Macro>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variation_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_selector: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<DeviceView>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub latency_samples: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub latency_ms: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub parameter_bank: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<DeviceComparison>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_chains: Option<Vec<LiveRef>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub visible_macro_count: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eq8: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hybrid_reverb: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meld: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drum_cell: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub looper: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_device: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub selected_variation_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub macro_mapped: Maybe<Vec<bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rack_view: Option<RackView>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Device {
    /// A bare device row: `{ ref, name, kind, parameters: [] }` and nothing else set.
    pub fn new(ref_: LiveRef, name: &str, kind: DeviceKind) -> Device {
        Device {
            ref_,
            parent_ref: None,
            name: name.to_string(),
            kind,
            parameters: Vec::new(),
            object_identity: None,
            enabled: None,
            class_name: None,
            can_have_chains: Maybe::Absent,
            can_have_drum_pads: Maybe::Absent,
            chains: None,
            drum_pads: None,
            macros: None,
            variation_count: None,
            chain_selector: None,
            view: None,
            latency_samples: Maybe::Absent,
            latency_ms: Maybe::Absent,
            parameter_bank: Maybe::Absent,
            comparison: None,
            return_chains: None,
            visible_macro_count: Maybe::Absent,
            drift: None,
            eq8: None,
            hybrid_reverb: None,
            meld: None,
            drum_cell: None,
            looper: None,
            plugin: None,
            max_device: None,
            selected_variation_index: Maybe::Absent,
            macro_mapped: Maybe::Absent,
            rack_view: None,
            extra: Map::new(),
        }
    }

    /// A device-family row by its key: a declared family (`drift`, `looper`...) or one kept in `extra`.
    pub fn family_row(&self, key: &str) -> Option<&Map<String, Value>> {
        match key {
            "drift" => self.drift.as_ref(),
            "eq8" => self.eq8.as_ref(),
            "hybridReverb" => self.hybrid_reverb.as_ref(),
            "meld" => self.meld.as_ref(),
            "drumCell" => self.drum_cell.as_ref(),
            "looper" => self.looper.as_ref(),
            "plugin" => self.plugin.as_ref(),
            "maxDevice" => self.max_device.as_ref(),
            other => self.extra.get(other).and_then(Value::as_object),
        }
    }

    pub fn family_row_mut(&mut self, key: &str) -> Option<&mut Map<String, Value>> {
        match key {
            "drift" => self.drift.as_mut(),
            "eq8" => self.eq8.as_mut(),
            "hybridReverb" => self.hybrid_reverb.as_mut(),
            "meld" => self.meld.as_mut(),
            "drumCell" => self.drum_cell.as_mut(),
            "looper" => self.looper.as_mut(),
            "plugin" => self.plugin.as_mut(),
            "maxDevice" => self.max_device.as_mut(),
            other => self.extra.get_mut(other).and_then(Value::as_object_mut),
        }
    }

    /// `device[key] ??= {}` for a declared family row.
    pub fn family_row_or_insert(&mut self, key: &str) -> &mut Map<String, Value> {
        match key {
            "drift" => self.drift.get_or_insert_with(Map::new),
            "eq8" => self.eq8.get_or_insert_with(Map::new),
            "hybridReverb" => self.hybrid_reverb.get_or_insert_with(Map::new),
            "meld" => self.meld.get_or_insert_with(Map::new),
            "drumCell" => self.drum_cell.get_or_insert_with(Map::new),
            "looper" => self.looper.get_or_insert_with(Map::new),
            "plugin" => self.plugin.get_or_insert_with(Map::new),
            "maxDevice" => self.max_device.get_or_insert_with(Map::new),
            other => {
                let entry = self.extra.entry(other.to_string()).or_insert_with(|| Value::Object(Map::new()));
                if !entry.is_object() {
                    *entry = Value::Object(Map::new());
                }
                entry.as_object_mut().expect("an object")
            }
        }
    }
}

string_enum! {
    ClipKind { Midi = "midi", Audio = "audio" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipGroove {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpMarker {
    pub beat_time: f64,
    pub sample_time: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipView {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub grid_quantization: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub grid_is_triplet: Maybe<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    pub kind: ClipKind,
    pub start: f64,
    pub length: f64,
    pub notes: Vec<Note>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_revision: Option<String>,
    pub warp: bool,
    pub takes: Vec<String>,
    pub automation: Vec<AutomationPoint>,
    /// Envelopes by parameter reference, each a list of automation points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelopes: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_audio: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub gain: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub pitch_coarse: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub pitch_fine: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub warp_mode: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub warping: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fade_in_length: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fade_out_length: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_audio_fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub loop_start: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub loop_end: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub file_path: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub muted: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub looping: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_take_lane_clip: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub groove: Maybe<ClipGroove>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_groove: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub launch_mode: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub launch_quantization: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub legato: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub playing_position: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_playing: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_triggered: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_recording: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub ram_mode: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub signature_numerator: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub signature_denominator: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub velocity_amount: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub will_record_on_start: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fire_button_state: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub end_time: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub available_warp_modes: Maybe<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub sample_length: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub warp_markers: Maybe<Vec<WarpMarker>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_view: Option<ClipView>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Clip {
    /// A bare clip row: `{ ref, name, kind, start, length, notes: [], warp, takes: [], automation: [] }`.
    pub fn new(ref_: LiveRef, name: &str, kind: ClipKind, start: f64, length: f64) -> Clip {
        Clip {
            ref_,
            object_identity: None,
            name: name.to_string(),
            kind,
            start,
            length,
            notes: Vec::new(),
            notes_revision: None,
            warp: false,
            takes: Vec::new(),
            automation: Vec::new(),
            envelopes: None,
            is_audio: Maybe::Absent,
            gain: Maybe::Absent,
            pitch_coarse: Maybe::Absent,
            pitch_fine: Maybe::Absent,
            warp_mode: Maybe::Absent,
            warping: Maybe::Absent,
            fade_in_length: Maybe::Absent,
            fade_out_length: Maybe::Absent,
            available_audio_fields: None,
            loop_start: Maybe::Absent,
            loop_end: Maybe::Absent,
            file_path: Maybe::Absent,
            muted: Maybe::Absent,
            color_index: Maybe::Absent,
            looping: Maybe::Absent,
            is_take_lane_clip: Maybe::Absent,
            groove: Maybe::Absent,
            has_groove: Maybe::Absent,
            launch_mode: Maybe::Absent,
            launch_quantization: Maybe::Absent,
            legato: Maybe::Absent,
            playing_position: Maybe::Absent,
            is_playing: Maybe::Absent,
            is_triggered: Maybe::Absent,
            is_recording: Maybe::Absent,
            ram_mode: Maybe::Absent,
            signature_numerator: Maybe::Absent,
            signature_denominator: Maybe::Absent,
            velocity_amount: Maybe::Absent,
            will_record_on_start: Maybe::Absent,
            fire_button_state: Maybe::Absent,
            end_time: Maybe::Absent,
            available_warp_modes: Maybe::Absent,
            sample_length: Maybe::Absent,
            warp_markers: Maybe::Absent,
            clip_view: None,
            extra: Map::new(),
        }
    }

    /// The envelope at `parameter_ref`, if the clip has one (its points, parsed).
    pub fn envelope(&self, parameter_ref: &str) -> Option<Vec<AutomationPoint>> {
        self.envelopes.as_ref()?.get(parameter_ref).map(|points| serde_json::from_value(points.clone()).unwrap_or_default())
    }

    /// `clip.envelopes[parameterRef] = points`.
    pub fn set_envelope(&mut self, parameter_ref: &str, points: &[AutomationPoint]) {
        self.envelopes
            .get_or_insert_with(Map::new)
            .insert(parameter_ref.to_string(), serde_json::to_value(points).unwrap_or(Value::Array(Vec::new())));
    }

    /// The clip as a JSON row.
    pub fn to_row(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// `(clip as Record<string, unknown>)[field]`: a field by its wire name, absent when unset.
    pub fn field(&self, name: &str) -> Option<Value> {
        self.to_row().as_object().and_then(|row| row.get(name).cloned())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingState {
    pub input_type: Option<String>,
    pub input_sub_routing: Option<String>,
    pub output_type: Option<String>,
    pub output_sub_routing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_input_types: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_input_channels: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_output_types: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_output_channels: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerState {
    pub volume: Option<f64>,
    pub pan: Option<f64>,
    pub cue_volume: Option<f64>,
    pub mute: Option<bool>,
    pub solo: Option<bool>,
    pub sends: Vec<Option<f64>>,
    /// Live's own text for each value ("-3.2 dB", "25L"), when the adapter provides it.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub volume_display: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub pan_display: Maybe<String>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub cue_volume_display: Maybe<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_displays: Option<Vec<Option<String>>>,
    pub volume_ref: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub volume_identity: Maybe<String>,
    pub pan_ref: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub pan_identity: Maybe<String>,
    pub cue_ref: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub cue_identity: Maybe<String>,
    pub send_refs: Vec<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_identities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixer_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_activator: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crossfader: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panning_left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panning_right: Option<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub track_activator_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub crossfader_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub crossfade_assign: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub panning_mode: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub panning_left_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub panning_right_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub song_tempo_ref: Maybe<LiveRef>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSlot {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub parent_ref: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub scene_index: usize,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub clip_ref: Maybe<LiveRef>,
    pub empty: bool,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub controls_other_clips: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub has_stop_button: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_group_slot: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub playing_status: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub will_record_on_start: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fire_button_state: Maybe<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ClipSlot {
    /// An empty slot: `{ ref, parentRef, objectIdentity, sceneIndex, clipRef: null, empty: true }`.
    pub fn empty(ref_: LiveRef, parent_ref: LiveRef, object_identity: &str, scene_index: usize) -> ClipSlot {
        ClipSlot {
            ref_,
            parent_ref,
            object_identity: Some(object_identity.to_string()),
            scene_index,
            clip_ref: Maybe::Null,
            empty: true,
            color_index: Maybe::Absent,
            controls_other_clips: Maybe::Absent,
            has_stop_button: Maybe::Absent,
            is_group_slot: Maybe::Absent,
            playing_status: Maybe::Absent,
            will_record_on_start: Maybe::Absent,
            fire_button_state: Maybe::Absent,
            extra: Map::new(),
        }
    }

    /// The clip in the slot, if any (`slot.clipRef`, null or absent otherwise).
    pub fn clip(&self) -> Option<&LiveRef> {
        self.clip_ref.value()
    }
}

string_enum! {
    TrackKind { Audio = "audio", Midi = "midi", Group = "group", Return = "return", Main = "main", Master = "master", Regular = "regular" }
}

string_enum! {
    TrackMedia { Midi = "midi", Audio = "audio" }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub selected_device_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub device_insert_mode: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_collapsed: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_showing_chains: Maybe<bool>,
}

/// A track row. A focused read lists the tracks outside its focus as light rows (`light: true`): identity,
/// name, kind, arm, colour and group only, with empty clips, slots, devices and lanes and no mixer or routing.
/// `volume`, `pan`, `mute`, `solo` and `sends` are absent on a light row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<TrackMedia>,
    pub name: String,
    pub kind: TrackKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
    pub armed: Option<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub monitoring_state: Maybe<LiveMonitoringState>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub playing_slot_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fired_slot_index: Maybe<i64>,
    pub clips: Vec<Clip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_slots: Option<Vec<ClipSlot>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub mixer: Maybe<MixerState>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub routing: Maybe<RoutingState>,
    pub devices: Vec<Device>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sends: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_lanes: Option<Vec<TakeLane>>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub group_track_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_visible: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_selected: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_frozen: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fold_state: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub implicit_arm: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub back_to_arranger: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub muted_via_solo: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub input_meter_left: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub input_meter_right: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub input_meter_level: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub output_meter_left: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub output_meter_right: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub output_meter_level: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub performance_impact: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<TrackView>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Track {
    /// A bare track row: `{ ref, name, kind, volume, pan, mute, solo, armed, clips: [], devices: [], sends }`.
    pub fn new(ref_: LiveRef, name: &str, kind: TrackKind) -> Track {
        Track {
            ref_,
            object_identity: None,
            light: None,
            parent_ref: None,
            media_kind: None,
            name: name.to_string(),
            kind,
            volume: Some(0.85),
            pan: Some(0.0),
            mute: Some(false),
            solo: Some(false),
            armed: Some(false),
            monitoring_state: Maybe::Absent,
            playing_slot_index: Maybe::Absent,
            fired_slot_index: Maybe::Absent,
            clips: Vec::new(),
            clip_slots: None,
            mixer: Maybe::Absent,
            routing: Maybe::Absent,
            devices: Vec::new(),
            sends: Some(vec![0.0, 0.0]),
            input: None,
            output: None,
            take_lanes: None,
            group_track_ref: Maybe::Absent,
            is_visible: Maybe::Absent,
            is_selected: Maybe::Absent,
            is_frozen: Maybe::Absent,
            fold_state: Maybe::Absent,
            implicit_arm: Maybe::Absent,
            back_to_arranger: Maybe::Absent,
            muted_via_solo: Maybe::Absent,
            color_index: Maybe::Absent,
            color: Maybe::Absent,
            input_meter_left: Maybe::Absent,
            input_meter_right: Maybe::Absent,
            input_meter_level: Maybe::Absent,
            output_meter_left: Maybe::Absent,
            output_meter_right: Maybe::Absent,
            output_meter_level: Maybe::Absent,
            performance_impact: Maybe::Absent,
            view: None,
            extra: Map::new(),
        }
    }

    pub fn is_light(&self) -> bool {
        self.light == Some(true)
    }

    /// `track.clipSlots ?? []`.
    pub fn slots(&self) -> &[ClipSlot] {
        self.clip_slots.as_deref().unwrap_or(&[])
    }

    /// `track.takeLanes ?? []`.
    pub fn lanes(&self) -> &[TakeLane] {
        self.take_lanes.as_deref().unwrap_or(&[])
    }

    /// The track as a JSON row.
    pub fn to_row(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeLane {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_ref: Option<LiveRef>,
    pub name: String,
    pub index: usize,
    pub clips: Vec<Clip>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    pub index: usize,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub color_index: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_empty: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub is_triggered: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub tempo: Maybe<f64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub tempo_enabled: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub signature_numerator: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub signature_denominator: Maybe<i64>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub time_signature_enabled: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub fire_button_state: Maybe<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggerable: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Scene {
    /// A bare scene row: `{ ref, objectIdentity, name, index }`.
    pub fn new(ref_: LiveRef, object_identity: &str, name: &str, index: usize) -> Scene {
        Scene {
            ref_,
            object_identity: Some(object_identity.to_string()),
            name: name.to_string(),
            index,
            color_index: Maybe::Absent,
            is_empty: Maybe::Absent,
            is_triggered: Maybe::Absent,
            tempo: Maybe::Absent,
            tempo_enabled: Maybe::Absent,
            signature_numerator: Maybe::Absent,
            signature_denominator: Maybe::Absent,
            time_signature_enabled: Maybe::Absent,
            fire_button_state: Maybe::Absent,
            triggerable: None,
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLoop {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
}

/// The Set row (`snapshot.set`), with whatever else Live says of it in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSet {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "loop")]
    pub loop_: Option<SetLoop>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Locator {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    pub position: f64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrangement {
    pub length: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator_revision: Option<String>,
    pub locators: Vec<Locator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clips: Option<Vec<Map<String, Value>>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementClipEntry {
    pub clip: Clip,
    pub track_ref: LiveRef,
}

string_enum! {
    BrowserEntryKind { Device = "device", Sample = "sample", Preset = "preset" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEntry {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    pub name: String,
    pub kind: BrowserEntryKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    pub visible_view: Option<String>,
    pub follow: Option<bool>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub draw_mode: Maybe<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub track_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub scene_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub slot_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub detail_clip_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub device_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub parameter_ref: Maybe<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub chain_ref: Maybe<LiveRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quantization {
    pub name: String,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSongState {
    pub visible_tracks: Vec<LiveRef>,
    pub appointed_device: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub select_on_launch: Maybe<bool>,
    pub song_length: Option<f64>,
    pub start_time: Option<f64>,
    pub signature_numerator: Option<i64>,
    pub signature_denominator: Option<i64>,
    pub swing_amount: Option<f64>,
    pub overdub: Option<bool>,
    pub arrangement_overdub: Option<bool>,
    pub back_to_arranger: Option<bool>,
    pub can_capture_midi: Option<bool>,
    pub can_undo: Option<bool>,
    pub can_redo: Option<bool>,
    pub exclusive_arm: Option<bool>,
    pub exclusive_solo: Option<bool>,
    pub is_counting_in: Option<bool>,
    pub tempo_follower_enabled: Option<bool>,
    pub re_enable_automation_enabled: Option<bool>,
    pub session_record: Option<bool>,
    pub session_automation_record: Option<bool>,
    pub clip_trigger_quantization: Option<Quantization>,
    pub midi_recording_quantization: Option<Quantization>,
    pub is_ableton_link_enabled: Option<bool>,
    pub is_ableton_link_start_stop_sync_enabled: Option<bool>,
    pub tempo_follower: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTuning {
    pub note: i64,
    pub deviation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningSystem {
    pub name: String,
    pub lowest_note: Option<Map<String, Value>>,
    pub highest_note: Option<Map<String, Value>>,
    pub reference_pitch: Option<Map<String, Value>>,
    pub pseudo_octave_in_cents: Option<f64>,
    pub note_tunings: Vec<NoteTuning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub root_note: Option<i64>,
    pub scale_name: Option<String>,
    pub scale_mode: Option<bool>,
    pub scale_intervals: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub system: TuningSystem,
    pub scale: Scale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Groove {
    #[serde(rename = "ref")]
    pub ref_: LiveRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_identity: Option<String>,
    pub name: String,
    pub base: Option<f64>,
    pub quantization_amount: Option<f64>,
    pub random_amount: Option<f64>,
    pub timing_amount: Option<f64>,
    pub velocity_amount: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroovePool {
    pub amount: Option<f64>,
    pub grooves: Vec<Groove>,
}

string_enum! {
    /// The top-level parts a snapshot read can be limited to (the epoch always comes).
    LiveSnapshotPart { Set = "set", Tracks = "tracks", Scenes = "scenes", Arrangement = "arrangement", Playback = "playback", Selection = "selection" }
}

pub const LIVE_SNAPSHOT_PARTS: &[LiveSnapshotPart] = LiveSnapshotPart::ALL;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshotWindow {
    pub from: usize,
    pub count: usize,
}

/// What one snapshot read builds, so that a read costs what an operation touches instead of the whole Set.
/// Empty: the whole Set. `tracks`/`scenes`: only those whole rows, the track index running over regular and
/// group tracks, then returns, then main. `focus`: every track in order, whole for the listed indices and
/// light for the rest, with the Arrangement clips of the focus tracks only. `parts`: only those top-level
/// parts; the others are absent. The result's `window` says what was honoured. A Remote Script from before
/// these arguments answers with the whole Set whatever is asked (and no `window`), so a request only ever
/// makes a read cheaper: nothing may rely on a row being light.
///
/// The same shape is a snapshot's `window`: what the Remote Script honoured of the read's arguments.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<LiveSnapshotWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenes: Option<LiveSnapshotWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<Vec<usize>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<LiveSnapshotPart>>,
}

impl LiveSnapshotRequest {
    /// `Object.keys(request).length === 0`: a read of the whole Set.
    pub fn is_empty(&self) -> bool {
        self.tracks.is_none() && self.scenes.is_none() && self.focus.is_none() && self.parts.is_none()
    }
    pub fn focused(focus: Vec<usize>) -> LiveSnapshotRequest {
        LiveSnapshotRequest { focus: Some(focus), ..Default::default() }
    }
    pub fn of_parts(parts: Vec<LiveSnapshotPart>) -> LiveSnapshotRequest {
        LiveSnapshotRequest { parts: Some(parts), ..Default::default() }
    }
    pub fn track_window(from: usize, count: usize) -> LiveSnapshotRequest {
        LiveSnapshotRequest { tracks: Some(LiveSnapshotWindow { from, count }), ..Default::default() }
    }
}

/// The whole Set as the simulator keeps it and as a read returns it (every part optional: a read limited to
/// `parts` leaves the others out, and `epoch`, `trackCount`, `sceneCount` and `window` come with a read).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<LiveSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenes: Option<Vec<Scene>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement: Option<Arrangement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement_clips: Option<Vec<ArrangementClipEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<Vec<BrowserEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<SessionPlaybackState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<LiveRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<LiveView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Selection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song: Option<LiveSongState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning: Option<Tuning>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groove_pool: Option<GroovePool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<i64>,
    /// How many tracks and scenes the Set holds, whatever the read returned of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_count: Option<usize>,
    /// What the Remote Script honoured of the read's arguments; absent, the read was of the whole Set (what a
    /// Remote Script from before the arguments returns whatever it is asked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<LiveSnapshotRequest>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl LiveSnapshot {
    /// `snapshot.tracks`, or none when the read left them out.
    pub fn tracks(&self) -> &[Track] {
        self.tracks.as_deref().unwrap_or(&[])
    }
    pub fn tracks_mut(&mut self) -> &mut Vec<Track> {
        self.tracks.get_or_insert_with(Vec::new)
    }
    pub fn scenes(&self) -> &[Scene] {
        self.scenes.as_deref().unwrap_or(&[])
    }
    pub fn scenes_mut(&mut self) -> &mut Vec<Scene> {
        self.scenes.get_or_insert_with(Vec::new)
    }
    /// `snapshot.arrangementClips ?? []`.
    pub fn arrangement_clips(&self) -> &[ArrangementClipEntry] {
        self.arrangement_clips.as_deref().unwrap_or(&[])
    }
    /// `snapshot.arrangement?.clips ?? []`.
    pub fn arrangement_clip_rows(&self) -> &[Map<String, Value>] {
        self.arrangement.as_ref().and_then(|arrangement| arrangement.clips.as_deref()).unwrap_or(&[])
    }
    /// Whether the answer holds `part` (`part in value`).
    pub fn has_part(&self, part: LiveSnapshotPart) -> bool {
        match part {
            LiveSnapshotPart::Set => self.set.is_some(),
            LiveSnapshotPart::Tracks => self.tracks.is_some(),
            LiveSnapshotPart::Scenes => self.scenes.is_some(),
            LiveSnapshotPart::Arrangement => self.arrangement.is_some(),
            LiveSnapshotPart::Playback => self.playback.is_some(),
            LiveSnapshotPart::Selection => self.selection.is_some(),
        }
    }
}

/// The largest track or scene index a read may name (the registry's bound).
pub const MAX_SNAPSHOT_INDEX: usize = 100_000;

/// A request as the registry bounds it; anything else is refused before it is read.
pub fn validate_snapshot_request(request: &LiveSnapshotRequest) -> Result<(), LiveError> {
    let index = |value: usize| value <= MAX_SNAPSHOT_INDEX;
    for window in [&request.tracks, &request.scenes].into_iter().flatten() {
        if !index(window.from) || !index(window.count) || window.count < 1 {
            return Err(LiveError::RangeError("snapshot window is invalid".into()));
        }
    }
    if let Some(focus) = &request.focus {
        if !focus.iter().all(|value| index(*value)) || focus.iter().collect::<HashSet<_>>().len() != focus.len() {
            return Err(LiveError::RangeError("snapshot focus is invalid".into()));
        }
    }
    if let Some(parts) = &request.parts {
        if parts.len() > LIVE_SNAPSHOT_PARTS.len() || parts.iter().collect::<HashSet<_>>().len() != parts.len() {
            return Err(LiveError::RangeError("snapshot parts are invalid".into()));
        }
    }
    Ok(())
}

/// A request given as JSON (a tool's arguments, a wire frame), checked as the TypeScript checked the raw
/// object: only the four keys, integer indices within bounds, known parts.
pub fn snapshot_request_from_value(value: &Value) -> Result<LiveSnapshotRequest, LiveError> {
    let object = match value {
        Value::Object(object) if object.keys().all(|key| ["tracks", "scenes", "focus", "parts"].contains(&key.as_str())) => object,
        _ => return Err(LiveError::RangeError("snapshot request is invalid".into())),
    };
    let index = |value: Option<&Value>| -> Option<usize> {
        let number = value?.as_f64()?;
        (number.fract() == 0.0 && number >= 0.0 && number <= MAX_SNAPSHOT_INDEX as f64).then_some(number as usize)
    };
    let mut request = LiveSnapshotRequest::default();
    for (key, slot) in [("tracks", &mut request.tracks), ("scenes", &mut request.scenes)] {
        if let Some(window) = object.get(key) {
            let parsed = window
                .as_object()
                .filter(|window| window.keys().all(|key| key == "from" || key == "count"))
                .and_then(|window| Some(LiveSnapshotWindow { from: index(window.get("from"))?, count: index(window.get("count"))? }))
                .filter(|window| window.count >= 1);
            match parsed {
                Some(window) => *slot = Some(window),
                None => return Err(LiveError::RangeError("snapshot window is invalid".into())),
            }
        }
    }
    if let Some(focus) = object.get("focus") {
        let parsed = focus.as_array().and_then(|items| items.iter().map(|item| index(Some(item))).collect::<Option<Vec<usize>>>());
        match parsed {
            Some(items) if items.iter().collect::<HashSet<_>>().len() == items.len() => request.focus = Some(items),
            _ => return Err(LiveError::RangeError("snapshot focus is invalid".into())),
        }
    }
    if let Some(parts) = object.get("parts") {
        let parsed = parts
            .as_array()
            .and_then(|items| items.iter().map(|item| item.as_str().and_then(LiveSnapshotPart::parse)).collect::<Option<Vec<_>>>());
        match parsed {
            Some(items) if items.len() <= LIVE_SNAPSHOT_PARTS.len() && items.iter().collect::<HashSet<_>>().len() == items.len() => {
                request.parts = Some(items)
            }
            _ => return Err(LiveError::RangeError("snapshot parts are invalid".into())),
        }
    }
    Ok(request)
}

/// The parts a whole-Set answer holds.
const WHOLE_SET_PARTS: [LiveSnapshotPart; 5] =
    [LiveSnapshotPart::Set, LiveSnapshotPart::Tracks, LiveSnapshotPart::Scenes, LiveSnapshotPart::Arrangement, LiveSnapshotPart::Playback];

/// A snapshot answer checked against what was asked, now that the protocol leaves every part optional.
/// Without a `window` it is the whole Set: every part, every row whole (what a Remote Script from before
/// snapshot arguments answers to anything). With one, the window may only echo what was asked; the answer
/// holds exactly the parts it names (all of them when it names none), a focus lists every track with only
/// the focus tracks whole, and a window holds only its rows. Anything else is refused here, never passed on
/// as a snapshot.
pub fn check_snapshot_answer(answer: LiveSnapshot, request: &LiveSnapshotRequest) -> Result<LiveSnapshot, LiveError> {
    let err = |text: String| Err(LiveError::Error(text));
    let rows = answer.tracks.as_deref();
    let Some(window) = &answer.window else {
        let missing: Vec<&str> = WHOLE_SET_PARTS.iter().filter(|part| !answer.has_part(**part)).map(|part| part.as_str()).collect();
        if !missing.is_empty() {
            return err(format!("snapshot answer without a window isn't the whole Set: it lacks {}", missing.join(", ")));
        }
        if rows.map(|rows| rows.iter().any(Track::is_light)).unwrap_or(true) {
            return err("snapshot answer without a window isn't the whole Set: its tracks aren't all whole".into());
        }
        return Ok(answer);
    };
    for (key, honoured, asked) in [
        ("tracks", window.tracks.is_some(), request.tracks.is_some()),
        ("scenes", window.scenes.is_some(), request.scenes.is_some()),
        ("focus", window.focus.is_some(), request.focus.is_some()),
        ("parts", window.parts.is_some(), request.parts.is_some()),
    ] {
        if honoured && !asked {
            return err(format!("snapshot window says it honoured {key}, which wasn't asked"));
        }
    }
    if let Some(parts) = &window.parts {
        let asked = request.parts.as_deref().unwrap_or(&[]);
        if parts.len() != asked.len() || !parts.iter().all(|part| asked.contains(part)) {
            return err("snapshot window's parts aren't the parts asked".into());
        }
    }
    if let Some(focus) = &window.focus {
        let asked = request.focus.as_deref().unwrap_or(&[]);
        if !focus.iter().all(|index| asked.contains(index)) {
            return err("snapshot window's focus isn't the focus asked".into());
        }
    }
    for (key, honoured, asked) in [("tracks", &window.tracks, &request.tracks), ("scenes", &window.scenes, &request.scenes)] {
        if let Some(honoured) = honoured {
            let asked = asked.as_ref().copied().unwrap_or(LiveSnapshotWindow { from: usize::MAX, count: 0 });
            if honoured.from != asked.from || !(honoured.count >= 1 && honoured.count <= asked.count) {
                return err(format!("snapshot window's {key} aren't the {key} asked"));
            }
        }
    }
    for part in LIVE_SNAPSHOT_PARTS {
        let listed = match &window.parts {
            Some(parts) => parts.contains(part),
            None => *part != LiveSnapshotPart::Selection,
        };
        if listed && !answer.has_part(*part) {
            return err(format!("snapshot answer lacks its {part}"));
        }
        if window.parts.is_some() && !listed && answer.has_part(*part) {
            return err(format!("snapshot answer holds {part}, which wasn't asked"));
        }
    }
    let counted =
        |count: Option<usize>, from: usize, size: usize| -> Option<usize> { count.map(|count| count.saturating_sub(from).min(size)) };
    if let Some(rows) = rows {
        let from = window.tracks.map(|window| window.from).unwrap_or(0);
        let focus: Option<HashSet<usize>> = window.focus.as_ref().map(|focus| focus.iter().copied().collect());
        let expected = match (&window.tracks, &focus) {
            (Some(tracks), _) => counted(answer.track_count, from, tracks.count),
            (None, Some(_)) => answer.track_count,
            (None, None) => None,
        };
        if window.tracks.map(|tracks| rows.len() > tracks.count).unwrap_or(false)
            || expected.map(|expected| rows.len() != expected).unwrap_or(false)
        {
            return err("snapshot answer doesn't hold the track rows asked".into());
        }
        for (position, row) in rows.iter().enumerate() {
            let whole = focus.as_ref().map(|focus| focus.contains(&(from + position))).unwrap_or(true);
            if whole == row.is_light() {
                return err(format!(
                    "snapshot track {} is {}",
                    from + position,
                    if whole { "light, but was asked whole" } else { "whole, but was asked light" }
                ));
            }
        }
    }
    if let (Some(scenes), Some(rows)) = (&window.scenes, &answer.scenes) {
        let expected = counted(answer.scene_count, scenes.from, scenes.count);
        if rows.len() > scenes.count || expected.map(|expected| rows.len() != expected).unwrap_or(false) {
            return err("snapshot answer doesn't hold the scene rows asked".into());
        }
    }
    Ok(answer)
}

/// Whether a track plays audio or MIDI. The Remote Script's rows say what a track is (`kind`: regular, group,
/// return, main) apart from what it plays (`mediaKind`: audio, midi); older simulated rows said the second as
/// `kind`. None for a track that plays neither (a group).
pub fn track_media(track: &Track) -> Option<TrackMedia> {
    if track.kind == TrackKind::Group {
        return None;
    }
    if let Some(media) = track.media_kind {
        return Some(media);
    }
    match track.kind {
        TrackKind::Audio => Some(TrackMedia::Audio),
        TrackKind::Midi => Some(TrackMedia::Midi),
        _ => None,
    }
}

/// A track as a focused read lists it outside its focus: who it is, none of what it holds.
pub fn light_track_row(track: &Track, set_ref: Option<&LiveRef>) -> Track {
    Track {
        ref_: track.ref_.clone(),
        parent_ref: track.parent_ref.clone().or_else(|| set_ref.cloned()),
        object_identity: track.object_identity.clone(),
        name: track.name.clone(),
        kind: track.kind,
        media_kind: Some(track.media_kind.unwrap_or(if track.kind == TrackKind::Midi { TrackMedia::Midi } else { TrackMedia::Audio })),
        light: Some(true),
        armed: track.armed,
        color_index: Maybe::null_or(track.color_index.cloned()),
        group_track_ref: Maybe::null_or(track.group_track_ref.cloned()),
        clips: Vec::new(),
        clip_slots: Some(Vec::new()),
        devices: Vec::new(),
        take_lanes: Some(Vec::new()),
        mixer: Maybe::Null,
        routing: Maybe::Null,
        volume: None,
        pan: None,
        mute: None,
        solo: None,
        sends: None,
        monitoring_state: Maybe::Absent,
        playing_slot_index: Maybe::Absent,
        fired_slot_index: Maybe::Absent,
        input: None,
        output: None,
        is_visible: Maybe::Absent,
        is_selected: Maybe::Absent,
        is_frozen: Maybe::Absent,
        fold_state: Maybe::Absent,
        implicit_arm: Maybe::Absent,
        back_to_arranger: Maybe::Absent,
        muted_via_solo: Maybe::Absent,
        color: Maybe::Absent,
        input_meter_left: Maybe::Absent,
        input_meter_right: Maybe::Absent,
        input_meter_level: Maybe::Absent,
        output_meter_left: Maybe::Absent,
        output_meter_right: Maybe::Absent,
        output_meter_level: Maybe::Absent,
        performance_impact: Maybe::Absent,
        view: None,
        extra: Map::new(),
    }
}

string_enum! {
    /// Every event type: the Remote Script's (its _Subscription's, as the registry's subscribe types name them),
    /// Kumi's Live extension's `pointed` (a right-click on an object), and the simulator's own.
    LiveEventType {
        Transport = "transport", Object = "object", Reset = "reset", Selection = "selection", Name = "name", Mixer = "mixer", Parameter = "parameter", Structure = "structure",
        Pointed = "pointed", State = "state", Meter = "meter", Max = "max", Osc = "osc",
    }
}

/// What the Remote Script pushes to a subscription (its _Subscription), as the registry's subscribe types name them.
pub const REMOTE_SCRIPT_EVENT_TYPES: &[LiveEventType] = &[
    LiveEventType::Transport,
    LiveEventType::Object,
    LiveEventType::Reset,
    LiveEventType::Selection,
    LiveEventType::Name,
    LiveEventType::Mixer,
    LiveEventType::Parameter,
    LiveEventType::Structure,
];
/// Every event type: the Remote Script's, Kumi's Live extension's `pointed` (a right-click on an object), and the simulator's own.
pub const LIVE_EVENT_TYPES: &[LiveEventType] = LiveEventType::ALL;

string_enum! {
    LiveEventChannel { RemoteScript = "remote-script", Extension = "extension" }
}

/// One event from Live, numbered in its channel's own sequence; `coalesced` counts the events it stands for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub epoch: i64,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: LiveEventType,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub ref_: Option<LiveRef>,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<LiveEventChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coalesced: Option<u64>,
}

/// Every operation the bridge invokes on Live (the registry's invoke operations, and the simulator's older ones).
pub const LIVE_OPERATIONS: &[&str] = &[
    "willington.device.read",
    "willington.device.set",
    "clip.follow-actions.set",
    "arrangement.clip.create",
    "arrangement.clip.delete",
    "arrangement.clip.move",
    "arrangement.audio-clip.create",
    "arrangement.automation.read",
    "arrangement.automation.create",
    "arrangement.automation.delete",
    "arrangement.automation.point.insert",
    "arrangement.automation.point.delete",
    "audio.capture.cleanup",
    "audio.capture.emergency-stop",
    "audio.capture.inspect",
    "audio.capture.start",
    "audio.capture.status",
    "audio.capture.stop",
    "audio.clip.set",
    "audio.warp-marker.read",
    "audio.warp-marker.add",
    "audio.warp-marker.move",
    "audio.warp-marker.delete",
    "audio.take-lane.read",
    "audio.comp.read",
    "automation.envelope.clear",
    "automation.envelope.create",
    "automation.envelope.delete",
    "automation.envelope.read",
    "automation.point.delete",
    "automation.point.insert",
    "browser.inspect",
    "browser.load",
    "ownership.settle",
    "browser.roots",
    "browser.search",
    "browser.preview.start",
    "browser.preview.stop",
    "chain.set",
    "clip.action",
    "clip.create",
    "drum-pad.delete-all-chains",
    "drum-pad.load-sample",
    "drum-pad.load-samples",
    "device.parameters.set",
    "drum-pad.set",
    "rack.action",
    "rack.set",
    "rack.view.set",
    "clip.delete",
    "clip.duplicate",
    "clip.move",
    "clip.rename",
    "clip.set",
    "application.dialog",
    "clip.view.set",
    "device.bank.set",
    "drift.set",
    "drum-cell.set",
    "eq8.set",
    "hybrid-reverb.set",
    "looper.action",
    "looper.set",
    "meld.set",
    "plugin.set",
    "simpler.replace-sample",
    "device.comparison.save-to-slot",
    "device.delete",
    "device.enable",
    "device.insert",
    "device.move",
    "device.parameter.set",
    "device.rename",
    "device.view.set",
    "observe.poll",
    "observe.subscribe",
    "observe.unsubscribe",
    "parameter.re-enable-automation",
    "selection.set",
    "song.view.set",
    "chain-mixer.set",
    "compressor.sidechain.set",
    "device-io.set",
    "locator.add",
    "locator.delete",
    "locator.jump",
    "locator.jump-to",
    "locator.rename",
    "mixer.extended.set",
    "mixer.set",
    "note.add",
    "note.add-batch",
    "note.delete",
    "note.duplicate",
    "note.quantize",
    "note.read-by-id",
    "note.read-selected",
    "note.update",
    "project.bounce",
    "project.collect",
    "project.export",
    "project.new",
    "project.open",
    "project.save",
    "project.save-as",
    "authority.digest",
    "dev.lom-audit",
    "undo.step.begin",
    "undo.step.end",
    "song.undo",
    "song.redo",
    "render.offline",
    "arrangement.midi-clip.create",
    "clip.clear-range",
    "device.duplicate",
    "drum-pad.sample-chain",
    "project.import",
    "transaction.group",
    "performance.read",
    "realtime.arm",
    "realtime.disarm",
    "realtime.stats",
    "recording.arrangement",
    "recording.session",
    "routing.set",
    "scene.capture",
    "scene.create",
    "scene.delete",
    "scene.fire-selected",
    "scene.rename",
    "scene.set",
    "session.audio-clip.create",
    "session.audition-launch",
    "session.audition-stop",
    "session.capture-midi",
    "session.clip-launch",
    "session.clip-stop",
    "session.discover",
    "session.emergency-stop",
    "song.read",
    "song.set",
    "song.time-convert",
    "scene.duplicate",
    "tempo.set",
    "track.create",
    "track.create-return",
    "track.delete",
    "track.delete-return",
    "track.duplicate",
    "track.rename",
    "track.select-instrument",
    "track.set",
    "track.view.set",
    "transport.action",
    "transport.set",
    "groove.edit",
    "groove.read",
    "groove.set",
    "take-lane.create",
    "take-lane.rename",
    "take-lane.clip.create",
    "take-lane.audio-clip.create",
    "tuning.read",
    "tuning.set",
    "view.control",
    "view.set",
    "subscribe",
    "application.message",
    "automation.step.insert",
    "automation.value-at",
    "clip.time-convert",
    "data.get",
    "data.set",
    "device.action",
    "device.banks.read",
    "device.property.set",
    "fire-button.set",
    "note.delete-range",
    "note.select",
    "plugin.parameter-names",
    "sample.set",
    "sample.slice",
    "track.action",
    "wavetable.modulation.set",
    "wavetable.set",
    "python.run",
];

/// An operation's name (one of [`LIVE_OPERATIONS`] in production; the simulator refuses any other).
pub type LiveOperation = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveInvocation {
    pub operation: LiveOperation,
    pub args: Map<String, Value>,
}

impl LiveInvocation {
    pub fn new(operation: &str, args: Value) -> LiveInvocation {
        LiveInvocation { operation: operation.to_string(), args: args.as_object().cloned().unwrap_or_default() }
    }
}

/// What the Live domain throws: an `Error`, a `TypeError` or a `RangeError` (the host tells the last apart
/// for capture failures), or a refusal before dispatch.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LiveError {
    #[error("{0}")]
    Error(String),
    #[error("{0}")]
    TypeError(String),
    #[error("{0}")]
    RangeError(String),
    /// A mutation the bridge refused before dispatching it to Live (at its authority preflight or
    /// prepare, or for lacking cleanup ownership): nothing in Live changed.
    #[error("{0}")]
    MutationNotDispatched(String),
}

impl LiveError {
    pub fn message(&self) -> &str {
        match self {
            LiveError::Error(text) | LiveError::TypeError(text) | LiveError::RangeError(text) | LiveError::MutationNotDispatched(text) => {
                text
            }
        }
    }
    /// The JavaScript error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            LiveError::Error(_) => "Error",
            LiveError::TypeError(_) => "TypeError",
            LiveError::RangeError(_) => "RangeError",
            LiveError::MutationNotDispatched(_) => "LiveMutationNotDispatchedError",
        }
    }
    pub fn error(text: impl Into<String>) -> LiveError {
        LiveError::Error(text.into())
    }
    pub fn type_error(text: impl Into<String>) -> LiveError {
        LiveError::TypeError(text.into())
    }
    pub fn range_error(text: impl Into<String>) -> LiveError {
        LiveError::RangeError(text.into())
    }
}

impl From<RegistryError> for LiveError {
    fn from(error: RegistryError) -> LiveError {
        LiveError::Error(error.0)
    }
}
impl From<crate::follow_actions::FollowActionError> for LiveError {
    fn from(error: crate::follow_actions::FollowActionError) -> LiveError {
        LiveError::Error(error.0)
    }
}
impl From<serde_json::Error> for LiveError {
    fn from(error: serde_json::Error) -> LiveError {
        LiveError::Error(error.to_string())
    }
}
impl From<kumi_common::abort::Aborted> for LiveError {
    fn from(error: kumi_common::abort::Aborted) -> LiveError {
        LiveError::Error(error.to_string())
    }
}

pub type LiveListener = Rc<dyn Fn(&LiveEvent)>;
pub type Unsubscribe = Box<dyn Fn()>;
pub type StatusListener = Rc<dyn Fn(Option<&LiveStatus>)>;

pub trait LiveAdapter {
    fn status(&self) -> Result<LiveStatus, LiveError>;
    fn snapshot(&self) -> Result<LiveSnapshot, LiveError>;
    /// The object at `object_ref` as JSON, or none (`undefined`) when nothing is there.
    fn get(&self, object_ref: &LiveRef) -> Result<Option<Value>, LiveError>;
    fn invoke(&self, invocation: &LiveInvocation) -> Result<Value, LiveError>;
    fn subscribe(&self, listener: LiveListener) -> Result<Unsubscribe, LiveError>;
    fn reconnect(&self) -> Result<LiveStatus, LiveError>;
}

/// Promise-based boundary used by process-backed adapters. Synchronous methods
/// remain available for deterministic in-process compatibility tests.
///
/// The methods past `close` are the ones the TypeScript adapters offered optionally (the host looks for
/// them at runtime): each has a `has_*` flag that says whether the adapter really implements it.
#[async_trait(?Send)]
pub trait AsyncLiveAdapter: LiveAdapter {
    /// A snapshot of the Set; `request` limits what is built (see LiveSnapshotRequest).
    async fn snapshot_async(
        &self,
        context: Option<&LiveOperationContext>,
        request: Option<&LiveSnapshotRequest>,
    ) -> Result<LiveSnapshot, LiveError>;
    async fn discover_async(
        &self,
        request: &LiveDiscoveryRequest,
        context: Option<&LiveOperationContext>,
    ) -> Result<LiveDiscoveryResult, LiveError>;
    async fn get_async(&self, object_ref: &LiveRef, context: Option<&LiveOperationContext>) -> Result<Option<Value>, LiveError>;
    async fn invoke_async(&self, invocation: &LiveInvocation, context: Option<&LiveOperationContext>) -> Result<Value, LiveError>;
    async fn reconnect_async(&self, context: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError>;
    async fn close(&self) -> Result<(), LiveError>;

    /// `refreshStatusAsync`: a status read again from Live (the remote adapter and the router).
    fn has_refresh_status_async(&self) -> bool {
        false
    }
    async fn refresh_status_async(&self, _context: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError> {
        self.status()
    }
    /// `subscribeStatus`: told when the adapter's status changes shape.
    fn has_subscribe_status(&self) -> bool {
        false
    }
    fn subscribe_status(&self, _listener: StatusListener) -> Unsubscribe {
        Box::new(|| {})
    }
    /// `retireTransactionAsync(transactionId, context?, terminal = false)`: frees a transaction's replay ledger
    /// in the Remote Script; the result is `{ retired: number }`.
    fn has_retire_transaction_async(&self) -> bool {
        false
    }
    async fn retire_transaction_async(
        &self,
        _transaction_id: &str,
        _context: Option<&LiveOperationContext>,
        _terminal: bool,
    ) -> Result<Value, LiveError> {
        Err(LiveError::Error("retireTransactionAsync is unavailable".into()))
    }
    /// `retiresOnItsOwn`: the adapter retires changed transactions itself (single-tick mutations).
    fn retires_on_its_own(&self) -> bool {
        false
    }
    /// `expectStateDigest(transactionId, invocation)`: the state digest a preview fenced, kept for its change.
    fn has_expect_state_digest(&self) -> bool {
        false
    }
    fn expect_state_digest(&self, _transaction_id: &str, _invocation: &LiveInvocation) {}
}

/// Kinds of reference that name something outside every track (the Set, a scene, a locator...): reading
/// one needs no track rows.
const OUTSIDE_TRACK_KINDS: [&str; 9] =
    ["set", "scene", "locator", "groove", "session_playback", "session-playback", "selection", "browser_item", "browser-item"];
/// Kinds whose Remote Script path starts with their track's index.
const TRACK_PATH_KINDS: [&str; 11] = [
    "track",
    "clip_slot",
    "clip",
    "device",
    "chain",
    "drum_pad",
    "take_lane",
    "take_lane_clip",
    "arrangement_clip",
    "routing_choice",
    "parameter",
];

static REF_KIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[0-9]+:)?([a-z_-]+):").expect("a valid pattern"));
static POSITIONAL_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+:([a-z_]+):(.+)$").expect("a valid pattern"));
static NESTED_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+:[a-z_]+:").expect("a valid pattern"));
static SHORT_INDEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,6}$").expect("a valid pattern"));

/// The kind a reference names: `{epoch}:{kind}:{path}` from the Remote Script, `{kind}:{id}` from the simulator.
pub fn ref_kind(reference: &str) -> Option<&str> {
    REF_KIND.captures(reference).and_then(|captures| captures.get(1)).map(|kind| kind.as_str())
}

/// The track a positional Remote Script reference sits under, by the combined index (regular and group
/// tracks, then returns, then main): `{e}:track:3`, `{e}:clip_slot:3:5`, `{e}:clip:3:5`, `{e}:device:3:0:2`,
/// `{e}:chain:3:0`, `{e}:drum_pad:3:0:36`, `{e}:take_lane:3:1`, `{e}:take_lane_clip:3:1:0`,
/// `{e}:arrangement_clip:3:7`, `{e}:parameter:mixer:3:volume`, and a parameter or chain that names its
/// owner's reference (`{e}:parameter:{e}:device:3:0:2:5`, `{e}:parameter:{e}:chain:3:0:volume`).
/// None when the reference doesn't place itself on a track: the Set, a scene, a group-track or view
/// alias (`{e}:track:group:3`, `{e}:device:view:3`), a Set-level Arrangement clip, a simulator reference.
pub fn track_index_of_ref(reference: &str) -> Option<usize> {
    track_index_of_ref_at(reference, 0)
}

fn track_index_of_ref_at(reference: &str, depth: usize) -> Option<usize> {
    let captures = POSITIONAL_REF.captures(reference)?;
    if depth > 8 {
        return None;
    }
    let kind = captures.get(1)?.as_str();
    let path = captures.get(2)?.as_str();
    if NESTED_REF.is_match(path) {
        return if kind == "parameter" || kind == "chain" { track_index_of_ref_at(path, depth + 1) } else { None };
    }
    if !TRACK_PATH_KINDS.contains(&kind) {
        return None;
    }
    let parts: Vec<&str> = path.split(':').collect();
    let numeric = if kind == "parameter" {
        if parts.first() == Some(&"mixer") {
            parts.get(1).copied()
        } else {
            None
        }
    } else {
        parts.first().copied()
    };
    let numeric = numeric?;
    if !SHORT_INDEX.is_match(numeric) || (kind == "arrangement_clip" && parts.len() < 2) {
        return None;
    }
    let index: usize = numeric.parse().ok()?;
    (index <= MAX_SNAPSHOT_INDEX).then_some(index)
}

/// Every reference a whole track row owns: its own, its clips', slots', lanes', devices', parameters',
/// chains' and pads', and its mixers' parameters. References to other objects (a parent, a group) aren't.
pub fn refs_owned_by_track(track: &Value, owned: &mut dyn FnMut(&str)) {
    fn visit(value: &Value, mixer: bool, depth: usize, owned: &mut dyn FnMut(&str)) {
        if depth > 256 {
            return;
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(item, mixer, depth + 1, owned);
                }
            }
            Value::Object(object) => {
                for (key, item) in object {
                    if key == "ref" {
                        if let Value::String(text) = item {
                            owned(text);
                        }
                    } else if mixer && (key.ends_with("Ref") || key.ends_with("Refs")) && (item.is_string() || item.is_array()) {
                        let entries: Vec<&Value> = match item {
                            Value::Array(items) => items.iter().collect(),
                            other => vec![other],
                        };
                        for entry in entries {
                            if let Value::String(text) = entry {
                                owned(text);
                            }
                        }
                    } else if item.is_object() || item.is_array() {
                        visit(item, key == "mixer", depth + 1, owned);
                    }
                }
            }
            _ => {}
        }
    }
    visit(track, false, 0, owned);
}

/// Which tracks a view reads whole: the listed ones (every other one comes light), or all of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveViewScope {
    Indices(Vec<usize>),
    All,
}

/// A whole-Set read is paged by this many tracks, so that no one request builds a whole big Set on Live's
/// UI thread; the page is what keeps Live responsive, not a bound on the Set.
pub const WHOLE_SET_PAGE_TRACKS: usize = 16;
const MAX_REMEMBERED_OWNERS: usize = 250_000;
/// How many pages one discovery may take to its end (a page holds one item at least).
const MAX_DISCOVERY_PAGES: usize = 1_000_000;

// --- views ---

/// Reads of Live shaped to what an operation touches, assembling bounded track windows when needed.
pub struct LiveViews {
    pub track_count: Cell<usize>,
    owners: RefCell<HashMap<String, usize>>,
    adapter: Rc<dyn Fn() -> Rc<dyn AsyncLiveAdapter>>,
}

struct ViewAssembly {
    tracks: Vec<Track>,
    clips: Vec<Map<String, Value>>,
    held: Vec<ArrangementClipEntry>,
}

enum FillResult {
    Complete,
    Retry,
    Whole(LiveSnapshot),
}

impl ViewAssembly {
    fn new(first: &LiveSnapshot) -> Self {
        let mut assembly = Self { tracks: first.tracks().to_vec(), clips: Vec::new(), held: Vec::new() };
        assembly.keep(first);
        assembly
    }
    fn keep(&mut self, snapshot: &LiveSnapshot) {
        for clip in snapshot.arrangement.as_ref().and_then(|a| a.clips.as_ref()).into_iter().flatten() {
            if !self.clips.iter().any(|known| known.get("ref") == clip.get("ref")) {
                self.clips.push(clip.clone());
            }
        }
        for item in snapshot.arrangement_clips.iter().flatten() {
            if !self.held.iter().any(|known| known.clip.ref_ == item.clip.ref_) {
                self.held.push(item.clone());
            }
        }
    }
    fn assembled(mut self, mut first: LiveSnapshot, wanted: Option<&[LiveSnapshotPart]>, focus: Option<&[usize]>) -> LiveSnapshot {
        let order: HashMap<_, _> = self.tracks.iter().enumerate().map(|(i, t)| (t.ref_.as_str(), i)).collect();
        self.clips
            .sort_by_key(|clip| clip.get("trackRef").and_then(Value::as_str).and_then(|key| order.get(key)).copied().unwrap_or(usize::MAX));
        self.held.sort_by_key(|item| order.get(item.track_ref.as_str()).copied().unwrap_or(usize::MAX));
        if wanted.is_none_or(|parts| parts.contains(&LiveSnapshotPart::Arrangement)) {
            if let Some(arrangement) = &mut first.arrangement {
                arrangement.clips = Some(self.clips);
            }
        }
        if first.arrangement_clips.is_some() {
            first.arrangement_clips = Some(self.held);
        }
        first.tracks = Some(self.tracks);
        if let (Some(focus), Some(window)) = (focus, &mut first.window) {
            window.focus = Some(focus.to_vec());
        } else {
            first.window = None;
        }
        first
    }
}

impl LiveViews {
    pub fn new(adapter: impl Fn() -> Rc<dyn AsyncLiveAdapter> + 'static) -> Self {
        Self { track_count: Cell::new(0), owners: RefCell::new(HashMap::new()), adapter: Rc::new(adapter) }
    }
    pub async fn view(
        &self,
        context: Option<&LiveOperationContext>,
        scope: LiveViewScope,
        parts: Option<&[LiveSnapshotPart]>,
    ) -> Result<LiveSnapshot, LiveError> {
        let LiveViewScope::Indices(mut focus) = scope else { return self.whole_set(context, parts).await };
        focus.retain(|index| *index <= MAX_SNAPSHOT_INDEX);
        focus.sort_unstable();
        focus.dedup();
        let wanted = parts.map(unique_parts);
        let adapter = (self.adapter)();
        if wanted
            .as_ref()
            .is_some_and(|parts| !parts.contains(&LiveSnapshotPart::Tracks) && !parts.contains(&LiveSnapshotPart::Arrangement))
        {
            return self.read(&*adapter, context, LiveSnapshotRequest { parts: wanted, ..Default::default() }).await;
        }
        for _ in 0..3 {
            let first = self
                .read(&*adapter, context, LiveSnapshotRequest { focus: Some(focus.clone()), parts: wanted.clone(), ..Default::default() })
                .await?;
            let honoured = first.window.as_ref().and_then(|window| window.focus.as_ref());
            if honoured.is_none()
                || first.tracks.is_none()
                || focus.iter().all(|index| honoured.unwrap().contains(index) || *index >= first.tracks().len())
            {
                return Ok(first);
            }
            let mut assembly = ViewAssembly::new(&first);
            match self.fill(&*adapter, context, &first, &mut assembly, &focus, &Self::page_parts(wanted.as_deref())).await? {
                FillResult::Retry => continue,
                FillResult::Complete => return Ok(assembly.assembled(first, wanted.as_deref(), Some(&focus))),
                FillResult::Whole(whole) => return Ok(whole),
            }
        }
        Err(LiveError::error("the Set's tracks kept changing while they were read; read them again"))
    }
    pub async fn view_for(
        &self,
        context: Option<&LiveOperationContext>,
        refs: &[Value],
        parts: Option<&[LiveSnapshotPart]>,
        indices: &[usize],
    ) -> Result<LiveSnapshot, LiveError> {
        if parts.is_some_and(|parts| !parts.contains(&LiveSnapshotPart::Tracks)) {
            return self.view(context, LiveViewScope::Indices(vec![]), parts).await;
        }
        let mut focus = indices.to_vec();
        let mut unplaced = Vec::new();
        let mut unknown = false;
        for reference in refs.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()) {
            if ref_kind(reference).is_some_and(|kind| OUTSIDE_TRACK_KINDS.contains(&kind)) {
                continue;
            }
            if let Some(index) = track_index_of_ref(reference) {
                focus.push(index);
                continue;
            }
            if let Some(index) = self.owners.borrow().get(reference) {
                focus.push(*index);
            } else {
                unknown = true;
            }
            unplaced.push(reference.to_string());
        }
        if unknown && focus.is_empty() {
            return self.whole_set(context, parts).await;
        }
        let snapshot = self.view(context, LiveViewScope::Indices(focus), parts).await?;
        if unplaced.is_empty() || Self::whole_rows_hold(&snapshot, &unplaced) {
            Ok(snapshot)
        } else {
            self.whole_set(context, parts).await
        }
    }
    pub async fn whole_set(
        &self,
        context: Option<&LiveOperationContext>,
        parts: Option<&[LiveSnapshotPart]>,
    ) -> Result<LiveSnapshot, LiveError> {
        let wanted = parts.map(unique_parts);
        let adapter = (self.adapter)();
        if wanted.as_ref().is_some_and(|parts| !parts.contains(&LiveSnapshotPart::Tracks)) {
            return self.read(&*adapter, context, LiveSnapshotRequest { parts: wanted, ..Default::default() }).await;
        }
        for _ in 0..3 {
            let first = self
                .read(
                    &*adapter,
                    context,
                    LiveSnapshotRequest { focus: Some((0..WHOLE_SET_PAGE_TRACKS).collect()), parts: wanted.clone(), ..Default::default() },
                )
                .await?;
            if first.window.as_ref().and_then(|window| window.focus.as_ref()).is_none() || first.tracks.is_none() {
                return Ok(first);
            }
            if first.track_count.is_some_and(|count| count != first.tracks().len()) {
                continue;
            }
            let mut assembly = ViewAssembly::new(&first);
            let indices = (0..assembly.tracks.len()).collect::<Vec<_>>();
            match self.fill(&*adapter, context, &first, &mut assembly, &indices, &Self::page_parts(wanted.as_deref())).await? {
                FillResult::Retry => continue,
                FillResult::Complete => return Ok(assembly.assembled(first, wanted.as_deref(), None)),
                FillResult::Whole(whole) => return Ok(whole),
            }
        }
        Err(LiveError::error("the Set's tracks kept changing while it was read; read it again"))
    }
    pub async fn discover_all(
        &self,
        request: &LiveDiscoveryRequest,
        context: Option<&LiveOperationContext>,
        most: Option<usize>,
    ) -> Result<Vec<Map<String, Value>>, LiveError> {
        let adapter = (self.adapter)();
        let mut request = request.clone();
        let mut revision = None;
        let mut items = Vec::new();
        for _ in 0..MAX_DISCOVERY_PAGES {
            let page = adapter.discover_async(&request, context).await?;
            if revision.as_ref().is_some_and(|revision| revision != &page.revision) {
                return Err(LiveError::error(format!("the {} list changed while it was read; read it again", request.kind)));
            }
            revision = Some(page.revision);
            items.extend(page.items);
            if most.is_some_and(|most| items.len() >= most) {
                items.truncate(most.unwrap());
                return Ok(items);
            }
            if page.next_cursor.as_ref().is_none_or(String::is_empty) {
                return Ok(items);
            }
            if page.next_cursor == request.cursor {
                return Err(LiveError::error(format!("the {} list's cursor didn't move on", request.kind)));
            }
            request.cursor = page.next_cursor;
        }
        Err(LiveError::error(format!("the {} list didn't end", request.kind)))
    }
    async fn read(
        &self,
        adapter: &dyn AsyncLiveAdapter,
        context: Option<&LiveOperationContext>,
        request: LiveSnapshotRequest,
    ) -> Result<LiveSnapshot, LiveError> {
        let snapshot = adapter.snapshot_async(context, Some(&request)).await?;
        self.note(&snapshot);
        Ok(snapshot)
    }
    fn page_parts(wanted: Option<&[LiveSnapshotPart]>) -> Vec<LiveSnapshotPart> {
        wanted
            .unwrap_or(LIVE_SNAPSHOT_PARTS)
            .iter()
            .copied()
            .filter(|part| matches!(part, LiveSnapshotPart::Tracks | LiveSnapshotPart::Arrangement))
            .collect()
    }
    async fn fill(
        &self,
        adapter: &dyn AsyncLiveAdapter,
        context: Option<&LiveOperationContext>,
        first: &LiveSnapshot,
        assembly: &mut ViewAssembly,
        indices: &[usize],
        parts: &[LiveSnapshotPart],
    ) -> Result<FillResult, LiveError> {
        let mut pending = indices.iter().copied().filter(|i| assembly.tracks.get(*i).is_some_and(Track::is_light)).collect::<Vec<_>>();
        pending.sort_unstable();
        pending.dedup();
        let mut at = 0;
        while at < pending.len() {
            let from = pending[at];
            let mut count = 1;
            while count < WHOLE_SET_PAGE_TRACKS && pending.get(at + count) == Some(&(from + count)) {
                count += 1;
            }
            let page = self
                .read(
                    adapter,
                    context,
                    LiveSnapshotRequest {
                        tracks: Some(LiveSnapshotWindow { from, count }),
                        parts: Some(parts.to_vec()),
                        ..Default::default()
                    },
                )
                .await?;
            let Some(window) = &page.window else {
                return Ok(FillResult::Whole(page));
            };
            let delivered = window.tracks.map(|window| window.count).unwrap_or(0);
            if window.tracks.map(|window| window.from) != Some(from)
                || page.tracks.is_none()
                || delivered < 1
                || delivered > count
                || page.tracks().len() != delivered
                || page.epoch != first.epoch
                || first.track_count.is_some_and(|n| page.track_count != Some(n))
                || page.scene_count != first.scene_count
            {
                return Ok(FillResult::Retry);
            }
            for (offset, row) in page.tracks().iter().enumerate() {
                let Some(listed) = assembly.tracks.get_mut(from + offset) else {
                    return Ok(FillResult::Retry);
                };
                if row.is_light() || listed.ref_ != row.ref_ || listed.object_identity != row.object_identity {
                    return Ok(FillResult::Retry);
                }
                *listed = row.clone();
            }
            assembly.keep(&page);
            at += delivered;
        }
        Ok(FillResult::Complete)
    }
    pub async fn playback(&self, context: Option<&LiveOperationContext>) -> Result<SessionPlaybackState, LiveError> {
        let result = (self.adapter)().discover_async(&LiveDiscoveryRequest::of(LiveDiscoveryKind::SessionPlayback), context).await?;
        result
            .items
            .first()
            .cloned()
            .and_then(|row| serde_json::from_value(Value::Object(row)).ok())
            .ok_or_else(|| LiveError::error("authoritative Session playback is unavailable"))
    }
    fn note(&self, snapshot: &LiveSnapshot) {
        if let Some(count) = snapshot.track_count {
            self.track_count.set(count);
        } else if snapshot.window.is_none() && !snapshot.tracks().is_empty() {
            self.track_count.set(snapshot.tracks().len());
        }
        let mut owners = self.owners.borrow_mut();
        if owners.len() > MAX_REMEMBERED_OWNERS {
            owners.clear();
        }
        let offset = snapshot.window.as_ref().and_then(|window| window.tracks).map(|window| window.from).unwrap_or(0);
        let mut index_of = HashMap::new();
        for (position, track) in snapshot.tracks().iter().enumerate() {
            if track_index_of_ref(&track.ref_).is_some() {
                continue;
            }
            let index = offset + position;
            index_of.insert(track.ref_.as_str(), index);
            owners.insert(track.ref_.to_string(), index);
            if !track.is_light() {
                refs_owned_by_track(&track.to_row(), &mut |reference| {
                    owners.insert(reference.to_string(), index);
                });
            }
        }
        for clip in snapshot.arrangement.as_ref().and_then(|a| a.clips.as_ref()).into_iter().flatten() {
            if let (Some(index), Some(reference)) =
                (clip.get("trackRef").and_then(Value::as_str).and_then(|key| index_of.get(key)), clip.get("ref").and_then(Value::as_str))
            {
                owners.insert(reference.to_string(), *index);
            }
        }
        for item in snapshot.arrangement_clips.iter().flatten() {
            if let Some(index) = index_of.get(item.track_ref.as_str()) {
                owners.insert(item.clip.ref_.to_string(), *index);
            }
        }
    }
    fn whole_rows_hold(snapshot: &LiveSnapshot, refs: &[String]) -> bool {
        let mut owned = HashSet::new();
        let mut whole = HashSet::new();
        for track in snapshot.tracks().iter().filter(|track| !track.is_light()) {
            whole.insert(track.ref_.as_str());
            refs_owned_by_track(&track.to_row(), &mut |reference| {
                owned.insert(reference.to_string());
            });
        }
        for clip in snapshot.arrangement.as_ref().and_then(|a| a.clips.as_ref()).into_iter().flatten() {
            if clip.get("trackRef").and_then(Value::as_str).is_some_and(|reference| whole.contains(reference)) {
                if let Some(reference) = clip.get("ref").and_then(Value::as_str) {
                    owned.insert(reference.to_string());
                }
            }
        }
        for item in snapshot.arrangement_clips.iter().flatten() {
            if whole.contains(item.track_ref.as_str()) {
                owned.insert(item.clip.ref_.to_string());
            }
        }
        refs.iter().all(|reference| owned.contains(reference))
    }
}

fn unique_parts(parts: &[LiveSnapshotPart]) -> Vec<LiveSnapshotPart> {
    let mut unique = Vec::new();
    for part in parts {
        if !unique.contains(part) {
            unique.push(*part);
        }
    }
    unique
}

#[derive(Debug, Clone, Default)]
pub struct UnavailableLiveAdapter;
impl LiveAdapter for UnavailableLiveAdapter {
    fn status(&self) -> Result<LiveStatus, LiveError> {
        Ok(LiveStatus {
            connected: false,
            adapter: LiveAdapterKind::Unavailable,
            epoch: None,
            protocol: LIVE_PROTOCOL_VERSION.into(),
            capabilities: vec![],
            reason: Some("live-adapter-not-installed".into()),
            registry_hash: None,
            operations: None,
            provenance: None,
            willington_kinds: None,
            environment: None,
        })
    }
    fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        Err(LiveError::error("Live adapter unavailable"))
    }
    fn get(&self, _: &LiveRef) -> Result<Option<Value>, LiveError> {
        Err(LiveError::error("Live adapter unavailable"))
    }
    fn invoke(&self, _: &LiveInvocation) -> Result<Value, LiveError> {
        Err(LiveError::error("Live adapter unavailable"))
    }
    fn subscribe(&self, _: LiveListener) -> Result<Unsubscribe, LiveError> {
        Ok(Box::new(|| {}))
    }
    fn reconnect(&self) -> Result<LiveStatus, LiveError> {
        self.status()
    }
}
#[async_trait(?Send)]
impl AsyncLiveAdapter for UnavailableLiveAdapter {
    async fn snapshot_async(&self, _: Option<&LiveOperationContext>, _: Option<&LiveSnapshotRequest>) -> Result<LiveSnapshot, LiveError> {
        self.snapshot()
    }
    async fn discover_async(&self, _: &LiveDiscoveryRequest, _: Option<&LiveOperationContext>) -> Result<LiveDiscoveryResult, LiveError> {
        Err(LiveError::error("Live adapter unavailable"))
    }
    async fn get_async(&self, reference: &LiveRef, _: Option<&LiveOperationContext>) -> Result<Option<Value>, LiveError> {
        self.get(reference)
    }
    async fn invoke_async(&self, invocation: &LiveInvocation, _: Option<&LiveOperationContext>) -> Result<Value, LiveError> {
        self.invoke(invocation)
    }
    async fn reconnect_async(&self, _: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError> {
        self.reconnect()
    }
    async fn close(&self) -> Result<(), LiveError> {
        Ok(())
    }
}
