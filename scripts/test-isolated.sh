#!/bin/sh
# Runs `cargo test` in a home of its own: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and
# KUMI_HOME point into a fresh temporary folder, so no test can reach this machine's Live folders,
# Remote Scripts or ~/.kumi through a default it forgot to override (home_dir(), kumi_dir() and the like).
# Live's folders set in this shell (KUMI_REMOTE_SCRIPTS_DIR, KUMI_LIVE_EXTENSIONS_DIR) aren't passed on.
# Cargo and rustup keep their own folders, named before HOME moves. The arguments are `cargo test`'s.
set -eu
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
home="$(mktemp -d "${TMPDIR:-/tmp}/kumi-test-home-XXXXXX")"
trap 'rm -rf "$home"' EXIT INT TERM
export HOME="$home" USERPROFILE="$home" APPDATA="$home/AppData/Roaming" LOCALAPPDATA="$home/AppData/Local" XDG_CONFIG_HOME="$home/.config" KUMI_HOME="$home/.kumi"
unset KUMI_REMOTE_SCRIPTS_DIR KUMI_LIVE_EXTENSIONS_DIR
cargo test --workspace --locked "$@"
