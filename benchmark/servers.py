"""Where to find the three servers, and the environment they run with.

Defaults assume the three repos are siblings and the Go binary is built:
    outline-mcp-js/   outline-mcp-go/outline-mcp-go   (go build -o outline-mcp-go)
Override with BENCH_JS_DIR, BENCH_GO_BIN and BENCH_PY (a python that has
outline-mcp-py installed).
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
JS_DIR = os.environ.get("BENCH_JS_DIR", os.path.dirname(HERE))
GO_BIN = os.environ.get("BENCH_GO_BIN", os.path.join(JS_DIR, "..", "outline-mcp-go", "outline-mcp-go"))
PY_EXE = os.environ.get("BENCH_PY", "python3")

# Only needed for `real` mode and parity.py: the one page the benchmark may touch.
DOC_UUID = os.environ.get("BENCH_DOC_UUID", "")
DOC_URL = os.environ.get("BENCH_DOC_URL", "")

SERVERS = {
    "js": {"cmd": ["node", "index.js"], "cwd": JS_DIR},
    "go": {"cmd": [GO_BIN], "cwd": HERE},
    "py": {"cmd": [PY_EXE, "-m", "outline_mcp.main"], "cwd": HERE},
}


def load_env():
    """OUTLINE_API_URL / OUTLINE_API_KEY come from the caller's environment.
    Every write is confined to BENCH_DOC_UUID."""
    env = {k: os.environ[k] for k in ("OUTLINE_API_URL", "OUTLINE_API_KEY") if k in os.environ}
    if DOC_UUID:
        env["OUTLINE_WRITE_DOC_ID"] = DOC_UUID
    return env
