#!/usr/bin/env bash
# Tools a Powerhouse agent needs on its cloud VM beyond what boxd ships (node,
# git, gh, claude): Rust and Tauri's Linux libraries, so `cargo test` in
# src-tauri works. Runs once per VM image build (powerhouse.toml → install),
# from ~/repo. Then warms the Rust build so the agent's first cargo test is fast.
set -euo pipefail

command -v pnpm >/dev/null || npm install -g --silent pnpm

if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
  # Login shells (chats, terminals) read ~/.profile; the install step does not.
  grep -q '.cargo/env' "$HOME/.profile" 2>/dev/null || echo '. "$HOME/.cargo/env"' >> "$HOME/.profile"
fi
. "$HOME/.cargo/env"

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev >/dev/null

if [ -f src-tauri/Cargo.toml ]; then
  (cd src-tauri && cargo test --no-run --quiet)
fi
