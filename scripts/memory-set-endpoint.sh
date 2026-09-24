#!/usr/bin/env bash
# Point Powerhouse at the shared memory host without opening Settings.
# Writes settings.memory into the tauri store; run with the app closed (a
# running app persists its own in-memory settings and would overwrite this).
#   scripts/memory-set-endpoint.sh [url] [token-file]
set -euo pipefail
URL="${1:-https://factory.mithril-studio.com/memory/mcp}"
TOKEN_FILE="${2:-$HOME/.powerhouse/memory-token}"
STORE="$HOME/Library/Application Support/com.mithril.powerhouse/powerhouse.json"
[ -s "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE" >&2; exit 1; }
[ -s "$STORE" ] || { echo "no settings store at $STORE (start Powerhouse once first)" >&2; exit 1; }
cp "$STORE" "$STORE.bak-$(date +%Y%m%d-%H%M%S)"
URL="$URL" TOKEN="$(cat "$TOKEN_FILE")" STORE="$STORE" python3 - <<'EOF'
import json, os
path = os.environ["STORE"]
d = json.load(open(path))
d["tree"].setdefault("settings", {})["memory"] = {
    "enabled": True,
    "url": os.environ["URL"],
    "token": os.environ["TOKEN"].strip(),
}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(d, fh)
os.replace(tmp, path)
print("memory endpoint set to", os.environ["URL"])
EOF
