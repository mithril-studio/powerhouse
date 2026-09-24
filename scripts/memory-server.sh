#!/usr/bin/env bash
# Run the shared memory server by hand (Powerhouse starts it itself for a
# loopback endpoint; this is for debugging, and for the memory VM where it
# runs under a supervisor). Requires `uv tool install basic-memory` and the
# projects registered once:
#   basic-memory project add global    ~/.powerhouse/memory/global
#   basic-memory project add powerhouse ~/.powerhouse/memory/projects/powerhouse
#   basic-memory project default global
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
HOST="${MEMORY_HOST:-127.0.0.1}"
PORT="${MEMORY_PORT:-8765}"
exec basic-memory mcp --transport streamable-http --host "$HOST" --port "$PORT" --path /mcp
