//! Port of `packages/runtime/src/index.ts`: the crate root.

pub mod ai;
pub mod audio;
pub mod auth;
pub mod command;
pub mod core;
pub mod devices;
pub mod ears;
pub mod hands;
pub mod integrations;
pub mod kernel;
pub mod library;
pub mod mcp;
pub mod plugins;
pub mod providers;
pub mod system;
pub mod version;
pub mod video;
pub mod voice;
pub mod web;

pub use core::contracts::{
    ArrangementStrip, AuditionEvent, AuditionRequest, AuditionResult, CatchUp, ChainNode, ChangeFamily, ChangeRecord, ClipNote, ClipView,
    ConnectionState, ConversationStore, ConversationSummary, DeviceNode, DevicePlacement, DeviceTree, DisconnectCause, HeardEvent,
    Integration, IntegrationFactory, JsonObject, Kernel, KernelCheckpoint, KernelEvent, KernelFactory, KernelOptions, KernelTool,
    LibraryEvent, LibraryStatus, LiveFocus, LiveTransport, Memory, MemoryEvent, MemoryNote, MemoryScope, MemoryStore, Observation,
    PinnedNode, RecipeEvent, RecipeSummary, SavedConversation, SessionController, SessionEvent, SessionStatus, SessionStrip, StreamingCall,
    TechniqueEvent, TechniqueSummary, ToolImage, ToolResult, TranscriptLine, TurnResult, TurnState, Usage, WatchedEvent, WebEvent,
};
pub use core::memory::{create_memory_store, memory_instructions, FORGET_TOOL, MAX_NOTE, MAX_NOTES, REMEMBER_TOOL};
// TODO(port): re-exports from core/techniques
pub use core::gaps::{gap_tools, GAP_GUIDANCE, GAP_TOOL};
// TODO(port): re-exports from audio (analyzeFile, closeness, compare, hear, Analysis, Comparison)
pub use audio::matching::Closeness;
// TODO(port): re-exports from audio/tools
// TODO(port): re-exports from video/tool
// TODO(port): re-exports from web/tool
// TODO(port): re-exports from web/net
// TODO(port): re-exports from library
// TODO(port): re-exports from video
// TODO(port): re-exports from video/programs
// TODO(port): re-exports from voice
pub use command::{INSTALLED, KUMI, KUMI_REPAIR, KUMI_START};
pub use core::errors::{FailureKind, KumiError, RuntimeError};
pub use core::recipes::{
    create_recipe_store, recipe_instructions, recipe_tools, slug, Recipe, RecipeStore, FORGET_RECIPE_TOOL, RUN_RECIPE_TOOL,
    SAVE_RECIPE_TOOL,
};
pub use system::system_program;
pub use version::KUMI_VERSION;
// TODO(port): re-exports from core/session
pub use kernel::agent::{create_agent_kernel, AgentKernel, AgentKernelOptions, Checkpoint, ModelBinding, ModelRequest};
pub use kernel::budget::{budget_for, ContextBudget, DEFAULT_BUDGET};
// TODO(port): re-exports from providers
// TODO(port): re-exports from providers/models
// TODO(port): re-exports from providers/local
// TODO(port): re-exports from auth/store
// TODO(port): re-exports from auth/openai_codex
// TODO(port): re-exports from integrations/ableton
// TODO(port): re-exports from ears/device
// TODO(port): re-exports from hands
// TODO(port): re-exports from integrations/fallback
// TODO(port): re-exports from integrations/ableton/focus
// TODO(port): re-exports from integrations/ableton/project
pub use core::match_run::{MatchBudget, MatchRun, MatchStatus, MatchStop, MATCH_BUDGET};
pub use core::playbook::{create_playbook_store, lesson_line, playbook_brief, Lesson, PlaybookStore};
// TODO(port): re-exports from core/goal
