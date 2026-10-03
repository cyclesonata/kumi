//! Port of `packages/runtime/src/integrations/ableton/index.ts`.

pub mod actions;
pub mod arrange;
pub mod audition;
pub mod bridge_version;
pub mod changes;
pub mod context;
pub mod connection;
pub mod display;
pub mod fast;
pub mod focus;
pub mod fold;
mod inference;
pub mod references;
pub mod views;
pub mod pins;
mod concurrent;
pub use inference::create_inference_only_integration;
pub mod live_command;
pub mod more_changes;
pub mod plan_stream;
pub mod plugin_tool;
pub mod project;
pub mod samples;

/// The host-authorized bridge surface, ordered as in the source integration.
pub static BRIDGE_TOOLS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
    let data: serde_json::Value = serde_json::from_str(include_str!("assets/changes.json")).unwrap();
    let mut seen = std::collections::HashSet::new();
    crate::mcp::allowed_tools::MODEL_TOOLS
        .iter()
        .copied()
        .chain(data["hostTools"].as_array().unwrap().iter().filter_map(serde_json::Value::as_str))
        .chain([
            "live_project_info",
            "live_project_snapshot_export",
            "live_project_snapshot_diff",
            "live_project_backup_preview",
            "live_project_backup_apply",
            "live_run_python",
        ])
        .filter(|name| seen.insert((*name).to_owned()))
        .map(str::to_owned)
        .collect()
});
