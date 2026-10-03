use ableton_mcp_server::delivery::*;
use serde_json::json;
use std::path::Path;
#[test]
fn native_and_legacy_versioned_configs_round_trip_and_require_force() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("config.json");
    let native = config_for_entrypoint(Path::new("/opt/ableton-mcp-server"), None).unwrap();
    assert_eq!(native.server.command, "/opt/ableton-mcp-server");
    assert!(native.server.args.is_empty());
    write_config(&path, &native, false).unwrap();
    assert_eq!(read_config(&path).unwrap(), native);
    assert!(write_config(&path, &native, false).unwrap_err().message().contains("refusing to overwrite"));
    let legacy = config_for_entrypoint(Path::new("/opt/server.js"), Some("/usr/bin/node")).unwrap();
    write_config(&path, &legacy, true).unwrap();
    assert_eq!(read_config(&path).unwrap(), legacy);
    assert!(folder.path().read_dir().unwrap().all(|entry| entry.unwrap().file_name() == "config.json"));
    for value in
        [json!({"version":1,"server":{"command":"","args":[]}}), json!({"version":1,"server":{"command":"node","args":[],"extra":true}})]
    {
        assert_eq!(write_config(&folder.path().join("invalid.json"), &value, false).unwrap_err().message(), "invalid server configuration");
    }
    let directory = folder.path().join("directory");
    std::fs::create_dir(&directory).unwrap();
    assert!(write_config(&directory, &native, true).unwrap_err().message().contains("configuration directory"));
    assert!(directory.is_dir());
}
#[cfg(unix)]
#[test]
fn config_and_secret_symlinks_are_rejected_without_touching_targets() {
    use std::os::unix::fs::symlink;
    let folder = tempfile::tempdir().unwrap();
    let target = folder.path().join("target");
    std::fs::write(&target, "sentinel").unwrap();
    let config = config_for_entrypoint(Path::new("/opt/ableton-mcp-server"), None).unwrap();
    for (destination, source) in
        [(folder.path().join("link"), target.clone()), (folder.path().join("dangling"), folder.path().join("missing"))]
    {
        symlink(&source, &destination).unwrap();
        assert!(write_config(&destination, &config, true).unwrap_err().message().contains("symbolic link"));
        assert!(read_secret_file(&destination).unwrap_err().message().contains("symbolic link"));
    }
    assert_eq!(std::fs::read_to_string(target).unwrap(), "sentinel");
    assert!(!folder.path().join("missing").exists());
}
#[test]
fn bridge_config_preserves_legacy_and_emits_native_launch_shape() {
    let folder = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    secure_windows_directory(folder.path()).unwrap();
    let secret = folder.path().join("secret");
    write_secret_file(&secret, None).unwrap();
    assert!(read_secret_file(&secret).unwrap().len() >= 32);
    let path = folder.path().join("bridge-config.json");
    let diagnostics = folder.path().join("diagnostics.log");
    write_secret_file(&diagnostics, Some(&"d".repeat(32))).unwrap();
    let bridge = json!({"host":"127.0.0.1","port":43210,"secretFile":secret,"timeoutMs":5000,"realtimePort":43211,"diagnostics":{"path":diagnostics,"maxBytes":BRIDGE_DIAGNOSTICS_MAX_BYTES}});
    let native = config_for_bridge(Path::new("/opt/ableton-mcp-server"), &bridge, None, Some(&path), true).unwrap();
    assert_eq!(native.server.args, vec!["--config", path.to_str().unwrap()]);
    assert_eq!(native.server.command, "/opt/ableton-mcp-server");
    write_config(&path, &native, false).unwrap();
    assert_eq!(read_any_config(&path).unwrap(), AnyConfig::Bridge(native.clone()));
    let legacy = config_for_bridge(Path::new("/opt/server.js"), &bridge, Some("/usr/bin/node"), Some(&path), true).unwrap();
    assert_eq!(legacy.server.args, vec!["/opt/server.js", "--config", path.to_str().unwrap()]);
    write_config(&path, &legacy, true).unwrap();
    assert_eq!(read_any_config(&path).unwrap(), AnyConfig::Bridge(legacy));
    std::fs::rename(&diagnostics, diagnostics.with_extension("missing")).unwrap();
    assert!(read_any_config(&path).is_ok());
    let mut invalid = bridge.clone();
    invalid["inlineSecret"] = "forbidden".into();
    assert_eq!(
        config_for_bridge(Path::new("/opt/server"), &invalid, None, None, false).unwrap_err().message(),
        "unsupported bridge configuration fields"
    );
    for host in ["localhost", "0.0.0.0", "127.0.0.2", "127.999.0.1"] {
        let mut invalid = bridge.clone();
        invalid["host"] = host.into();
        assert!(config_for_bridge(Path::new("/opt/server"), &invalid, None, None, false).unwrap_err().message().contains("exact loopback"));
    }
    let mut invalid = bridge.clone();
    invalid["realtimePort"] = 43210.into();
    assert!(config_for_bridge(Path::new("/opt/server"), &invalid, None, None, false).unwrap_err().message().contains("realtime port"));
}
#[test]
fn secrets_accept_one_line_ending_reject_whitespace_and_invalid_sizes() {
    let folder = tempfile::tempdir().unwrap();
    for size in [0., 8., 31., 129., 32.5, f64::NAN] {
        assert!(generate_secret(Some(size)).is_err());
    }
    for size in [32., 128.] {
        assert!(generate_secret(Some(size)).unwrap().len() >= size as usize);
    }
    let path = folder.path().join("secret");
    write_secret_file(&path, Some(&"a".repeat(32))).unwrap();
    assert_eq!(secret_permissions(&path), SecretPermissions::OwnerOnly);
    assert!(write_secret_file(&path, None).is_err());
    for raw in [format!("{}\r\n", "a".repeat(32)), "a".repeat(32)] {
        std::fs::write(&path, raw).unwrap();
        assert_eq!(read_secret_file(&path).unwrap(), "a".repeat(32));
    }
    for raw in [format!(" {}\n", "a".repeat(32)), format!("{}\n\n", "a".repeat(32)), format!("{}\u{feff}", "a".repeat(32))] {
        std::fs::write(&path, raw).unwrap();
        assert_eq!(read_secret_file(&path).unwrap_err().message(), "secret file is invalid");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, "a".repeat(32)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_secret_file(&path).unwrap_err().message().contains("conclusively owner-only"));
    }
}
#[test]
fn migrations_preserve_existing_configs_and_explicitly_add_bridge_authority() {
    let folder = tempfile::tempdir().unwrap();
    let input = folder.path().join("legacy.json");
    let output = folder.path().join("v1.json");
    std::fs::write(&input, r#"{"command":"/usr/bin/node","args":["server.js"]}"#).unwrap();
    assert_eq!(
        serde_json::to_value(migrate_config(&input, &output, false, None).unwrap()).unwrap(),
        json!({"version":1,"server":{"command":"/usr/bin/node","args":["server.js"]}})
    );
    let secret = folder.path().join("secret");
    write_secret_file(&secret, None).unwrap();
    let bridge = json!({"host":"127.0.0.1","port":9765,"secretFile":secret,"timeoutMs":5000});
    let native = config_for_entrypoint(Path::new("/opt/ableton-mcp-server"), None).unwrap();
    write_config(&input, &native, true).unwrap();
    let converted = migrate_config(&input, &output, true, Some(&bridge)).unwrap();
    assert_eq!(converted.server().args, vec!["--config", output.to_str().unwrap()]);
    assert_eq!(read_any_config(&output).unwrap(), converted);
}
#[test]
fn bridge_reference_names_only_its_absolute_config() {
    let folder = tempfile::tempdir().unwrap();
    let config = folder.path().join("config.json");
    std::fs::write(&config, "{}").unwrap();
    let reference = folder.path().join("bridge-reference.json");
    write_bridge_reference(&reference, &config, false).unwrap();
    assert_eq!(std::fs::read_to_string(&reference).unwrap(), format!("{}\n", json!({"config":config})));
    assert!(write_bridge_reference(&reference, &config, false).is_err());
    write_bridge_reference(&reference, &config, true).unwrap();
    assert!(write_bridge_reference(Path::new("relative"), &config, true).is_err());
}
#[test]
fn retained_node_policy_matches_canonical_package_and_platforms() {
    let metadata: serde_json::Value = serde_json::from_str(include_str!("../../../apps/mcp-server/package.json")).unwrap();
    assert_eq!(metadata["engines"]["node"], NODE_ENGINE_RANGE);
    assert_eq!(metadata["abletonMcpSupport"]["nodeMajors"], json!(SUPPORTED_NODE_MAJORS));
    for major in 21..=27 {
        assert_eq!(supported_node_major(&format!("{major}.0.0")), [22, 24].contains(&major));
    }
    assert!(!supported_node_major("22.0.0-rc.1"));
    for platform in ["darwin", "linux", "win32"] {
        assert!(is_supported_platform(Some(platform)));
    }
    assert!(!is_supported_platform(Some("freebsd")));
}
#[test]
fn legacy_bridge_validation_matches_typescript_oracle() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("fixtures/delivery-oracle.json")).unwrap();
    for case in &cases {
        let result = config_for_bridge(
            Path::new(case["entrypoint"].as_str().unwrap()),
            &case["bridge"],
            Some(case["command"].as_str().unwrap()),
            Some(Path::new(case["configPath"].as_str().unwrap())),
            false,
        );
        if let Some(error) = case.get("error") {
            assert_eq!(result.unwrap_err().message(), error.as_str().unwrap(), "{}", case["name"]);
        } else {
            let actual = kumi_common::js::json::stringify(&serde_json::to_value(result.unwrap()).unwrap());
            let expected = kumi_common::js::json::stringify(&case["result"]);
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
    assert!(cases.len() > 100);
}
