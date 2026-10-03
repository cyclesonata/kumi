//! Port of `packages/runtime/src/library/learn.ts`.
//! Learn changed sounds, presets and Sets, persisting progress as each batch finishes.
use super::{
    classify::{ClassFrom, SoundClass, SoundKind},
    presets::PresetCategory,
    sets::SetSummary,
    sources::Source,
    store::{Entry, Log, LogEntry},
};
use serde::{Deserialize, Serialize};
use std::path::Path;
pub const LOG_VERSION: u32 = 1;
macro_rules! sound_entry{($($name:ident:$type:ty),*$(,)?)=>{
    #[derive(Debug,Clone,Default,PartialEq,Serialize,Deserialize)]
    #[serde(rename_all="camelCase")]
    pub struct SoundEntry{#[serde(flatten)]pub file:Entry,$(#[serde(default,skip_serializing_if="Option::is_none")]pub $name:Option<$type>,)*}
};}
sound_entry! {seconds:f64,kind:SoundKind,r#class:SoundClass,class_from:ClassFrom,bpm:f64,key:String,note:String,loudness:f64,peak:f64,brightness:f64,flatness:f64,attack:f64,decay:f64,width:f64,onsets:f64,low:f64,high:f64,vector:String,features:u32,embedding:String,embedding_model:String,error:String}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PresetEntry {
    #[serde(flatten)]
    pub file: Entry,
    pub name: String,
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<PresetCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inside: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub source: String,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SetEntry {
    #[serde(flatten)]
    pub file: Entry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<SetSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
macro_rules! entry {
    ($type:ty) => {
        impl LogEntry for $type {
            fn path(&self) -> &str {
                &self.file.path
            }
        }
        impl std::ops::Deref for $type {
            type Target = Entry;
            fn deref(&self) -> &Entry {
                &self.file
            }
        }
    };
}
entry!(SoundEntry);
entry!(PresetEntry);
entry!(SetEntry);
pub struct LibraryLogs {
    pub sounds: Log<SoundEntry>,
    pub presets: Log<PresetEntry>,
    pub sets: Log<SetEntry>,
}
pub fn library_logs(dir: &str) -> LibraryLogs {
    let dir = Path::new(dir);
    LibraryLogs {
        sounds: Log::new(dir.join("sounds.jsonl"), "sounds", LOG_VERSION),
        presets: Log::new(dir.join("presets.jsonl"), "presets", LOG_VERSION),
        sets: Log::new(dir.join("sets.jsonl"), "sets", LOG_VERSION),
    }
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    pub known: usize,
    pub todo: usize,
    pub done: usize,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearnPhase {
    #[default]
    Looking,
    Presets,
    Sets,
    Sounds,
    Tidying,
    Done,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnProgress {
    pub phase: LearnPhase,
    pub sounds: Counts,
    pub presets: Counts,
    pub sets: Counts,
    pub failed: usize,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnPlan {
    pub dir: String,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub set_folders: Vec<String>,
    #[serde(default)]
    pub set_files: Vec<String>,
    #[serde(default)]
    pub plugin_presets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workers: Option<usize>,
}

/// Live's usual project folders and the parent folders of recently opened projects.
pub fn set_folders(recent: &[String], home: Option<&str>, platform: Option<&str>) -> Vec<String> {
    use super::sources::{current_platform, dirname, homedir, join};
    let default_home = home.is_none().then(homedir);
    let home = home.or(default_home.as_deref()).unwrap();
    let platform = platform.unwrap_or_else(|| current_platform());
    let mut folders = indexmap::IndexSet::new();
    if platform == "win32" {
        folders.insert(join(&join(home, "Documents"), "Ableton"));
    }
    folders.insert(join(home, "Music"));
    for file in recent {
        let project = dirname(file);
        let parent = dirname(&project);
        if parent != project && parent != home && parent.encode_utf16().count() > home.encode_utf16().count() {
            folders.insert(parent);
        }
    }
    folders.into_iter().collect()
}
pub fn plugin_preset_folders(home: Option<&str>, platform: Option<&str>) -> Vec<String> {
    use super::sources::{current_platform, homedir, join};
    let default_home = home.is_none().then(homedir);
    let home = home.or(default_home.as_deref()).unwrap();
    vec![match platform.unwrap_or_else(|| current_platform()) {
        "win32" => join(&join(home, "Documents"), "VST3 Presets"),
        "darwin" => join(&join(&join(home, "Library"), "Audio"), "Presets"),
        _ => join(&join(home, ".vst3"), "presets"),
    }]
}
