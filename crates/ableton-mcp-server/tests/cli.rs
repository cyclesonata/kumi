use ableton_mcp_server::host::SERVER_VERSION;
use serde_json::Value;
use std::process::{Command, Stdio};
#[test]
fn native_metadata_probe_uses_no_configuration_or_input() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ableton-mcp-server"))
        .arg("--version")
        .current_dir(dir.path())
        .env("ABLETON_MCP_EXTENSION", "external")
        .env("ABLETON_MCP_EXTENSION_DIR", dir.path().join("absent"))
        .stdin(Stdio::piped())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(String::from_utf8(output.stdout).unwrap(), format!("ableton-mcp-server {SERVER_VERSION}\n"));
    assert!(output.stderr.is_empty());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn delivery_subcommands_preserve_their_existing_cli_parsers() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let args = vec!["--unknown".into()];
            let cases = [
                ("setup", ableton_mcp_server::setup::run(&args)),
                ("migrate", ableton_mcp_server::migrate::run(&args)),
                ("install-remote-script", ableton_mcp_server::install_remote_script::run(&args)),
                ("diagnostics", ableton_mcp_server::diagnostics::run(&args).await),
                ("lifecycle", ableton_mcp_server::lifecycle_cli::run(&args).await),
            ];
            for (name, expected) in cases {
                let actual = ableton_mcp_server::cli::auxiliary_command(&[name.into(), "--unknown".into()]).await.unwrap();
                assert_eq!(actual, expected, "{name}");
                assert_ne!(actual.code, 0);
            }
            assert!(ableton_mcp_server::cli::auxiliary_command(&[]).await.is_none());
            assert!(ableton_mcp_server::cli::auxiliary_command(&["--version".into(), "--config".into()]).await.is_none());
            let metadata = ableton_mcp_server::cli::auxiliary_command(&["--version".into()]).await.unwrap();
            assert_eq!(metadata.code, 0);
            assert!(serde_json::from_str::<Value>(&metadata.stdout).is_err());
        })
        .await;
}
