#!/usr/bin/env python3
"""Trusted systemd ExecStopPost hook; the agent cannot write these results."""

import json
import os
from pathlib import Path
import re
import sys
import time

run_id = sys.argv[1]
if os.geteuid() != 0 or not re.fullmatch(r"[a-z0-9]{1,32}", run_id):
    raise SystemExit("Root and a valid spike ID are required")

directory = Path("/var/lib/powerhouse-spike-control") / run_id
result = {
    "service_result": os.environ.get("SERVICE_RESULT", "unknown"),
    "exit_code": os.environ.get("EXIT_CODE", "unknown"),
    "exit_status": os.environ.get("EXIT_STATUS", "unknown"),
    "finished_at": time.time(),
}
temporary = directory / "outcome.tmp"
with temporary.open("x") as output:
    json.dump(result, output)
    output.write("\n")
    output.flush()
    os.fsync(output.fileno())
temporary.replace(directory / "outcome.json")
fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
