//! Native entry point for the MCP host and its delivery commands.
use crate::command::CommandOutput;

/// Delivery and metadata commands complete without opening the MCP transport.
pub async fn auxiliary_command(args: &[String]) -> Option<CommandOutput> {
    if args.len() == 1 && args[0] == "--version" {
        return Some(CommandOutput { stdout: format!("ableton-mcp-server {}\n", crate::host::SERVER_VERSION), ..Default::default() });
    }
    let command = args.first()?.as_str();
    let arguments = &args[1..];
    Some(match command {
        "lifecycle" => crate::lifecycle_cli::run(arguments).await,
        "setup" => crate::setup::run(arguments),
        "migrate" => crate::migrate::run(arguments),
        "diagnostics" => crate::diagnostics::run(arguments).await,
        "install-remote-script" => crate::install_remote_script::run(arguments),
        _ => return None,
    })
}

pub fn main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The metadata probe needs neither configuration nor asynchronous runtime initialization.
    if args.len() == 1 && args[0] == "--version" {
        println!("ableton-mcp-server {}", crate::host::SERVER_VERSION);
        return 0;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return CommandOutput::error(format!("mcp-host: {error}"), 1).emit(),
    };
    tokio::task::LocalSet::new().block_on(&runtime, async {
        if let Some(output) = auxiliary_command(&args).await {
            return output.emit();
        }
        // The remaining production host dispatcher will own normal stdio/config startup.
        CommandOutput::error("mcp-host: MCP request execution is not ported yet", 1).emit()
    })
}
