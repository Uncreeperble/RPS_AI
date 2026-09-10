#!/usr/bin/env bash
# run.sh
# ======
# Tiny shell wrapper around `run.py` so users on macOS/Linux can launch
# the game with `./run.sh` without needing to remember the Python invocation.
#
# Any arguments passed to this script are forwarded to `run.py`, e.g.:
#   ./run.sh --port 8080 --difficulty hard
#
# If the script is run from a GUI file manager (no terminal attached),
# it opens a new Terminal window first so the user can see the server
# logs and press Ctrl+C to stop the server.

set -euo pipefail

# Resolve the directory this script lives in (so it works from any CWD).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Pick a Python interpreter. Prefer python3, fall back to python.
if command -v python3 >/dev/null 2>&1; then
    PY="python3"
elif command -v python >/dev/null 2>&1; then
    PY="python"
else
    echo "Error: Python is not installed or not on PATH." >&2
    echo "Please install Python 3.9+ from https://www.python.org/downloads/" >&2
    exit 1
fi

# Forward all arguments to run.py.
exec "$PY" "$SCRIPT_DIR/run.py" "$@"