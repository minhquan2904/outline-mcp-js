# Benchmark: JS vs Go vs Python

Compares the three servers — [outline-mcp-js](https://github.com/minhquan2904/outline-mcp-js),
[outline-mcp-go](https://github.com/minhquan2904/outline-mcp-go) and
[outline-mcp-py](https://github.com/minhquan2904/outline-mcp-py) — through the real MCP stdio
protocol, so each number includes the SDK, JSON-RPC framing, the HTTP call and rendering.

## What is measured

- `mock` mode (default for the published numbers): the servers talk to `mock_outline.py`, a local
  stand-in for the Outline API with realistic payloads (a 200 KB Vietnamese markdown page, 10 search
  hits, 25-item lists). It isolates the server's own overhead and never touches a real wiki.
- `real` mode: page-only operations (read, revisions, comments, append-write) on **one** page of a real
  Outline instance, a few calls each. Every write is confined to that page by `OUTLINE_WRITE_DOC_ID`.
- Before timing, every operation's output is hashed: all three servers must return identical text.
- Per operation: 20 warm-up calls, then N timed sequential calls (p50 / p95 / p99). Also startup time
  (spawn to `initialize`, 7 runs), idle and peak RSS, and throughput with 16 requests in flight.

## Run it

```bash
(cd ../../outline-mcp-go && go build -o outline-mcp-go .)   # Go binary
npm ci                                                       # JS deps (repo root)
pip install -e ../../outline-mcp-py                          # Python server
export BENCH_PY=python3                                      # a python that has it installed

python3 bench.py mock 200        # writes results_mock.json

# real mode: one page you are happy to have written to
export OUTLINE_API_URL=https://outline.example.com OUTLINE_API_KEY=...
export BENCH_DOC_UUID=<uuid of the benchmark page>
python3 bench.py real 10         # writes results_real.json
python3 parity.py                # read-only output comparison (also needs BENCH_DOC_URL)
```

Defaults assume the three repos are siblings; see `servers.py` for the `BENCH_*` overrides.

## Caveats

One machine (4 CPUs), one run, no pinning. The harness and the mock are Python, so they add a constant
to every number and the mock itself is the limit on the 200 KB rows. Treat differences under about
0.2 ms as noise. `results_real.json` is dominated by network time to the instance.
