//! The analysis job worker the bridge spawns: `apps/mcp-server/src/analysis-job-worker.ts`.
fn main() {
    std::process::exit(ableton_mcp_server::analysis_job_worker::main());
}
