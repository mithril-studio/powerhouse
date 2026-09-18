#!/usr/bin/env python3
"""Deterministic, credential-free process fixture for the boxd capability spike."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("complete", "fail", "wait"))
    args = parser.parse_args()

    # The child deliberately outlives its parent. The supervisor must stop it.
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(900)"])
    sequence = 0

    def emit(kind, **data):
        nonlocal sequence
        sequence += 1
        print(json.dumps({"sequence": sequence, "kind": kind, **data}), flush=True)

    emit("started", pid=os.getpid(), child_pid=child.pid)
    try:
        Path("/var/lib/powerhouse-spike-control/canary").read_bytes()
    except PermissionError:
        emit("runner_state_denied")
    else:
        raise RuntimeError("agent can read supervisor state")

    if args.mode == "wait":
        # CPU work without inbound traffic: useful for the later idle-policy test.
        while True:
            sum(range(100000))
    time.sleep(10)
    Path("artifact.txt").write_text("powerhouse detached fixture\n")
    emit("artifact_written")
    sys.exit(23 if args.mode == "fail" else 0)


if __name__ == "__main__":
    main()
