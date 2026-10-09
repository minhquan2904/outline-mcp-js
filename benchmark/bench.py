import hashlib, json, os, statistics as st, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcpcall import Server
from servers import SERVERS, DOC_UUID, load_env
import mock_outline as M

def pct(xs, q):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]

def proc_kb(pid, key):
    for line in open(f"/proc/{pid}/status"):
        if line.startswith(key): return int(line.split()[1])
    return 0

OPS = [  # name, tool, args
    ("get_doc_small", "get_document", {"idOrUrl": M.SMALL}),
    ("get_doc_200KB", "get_document", {"idOrUrl": M.LARGE, "maxChars": 400000}),
    ("search_10", "search_documents", {"query": "benchmark", "limit": 10}),
    ("titles_15", "search_document_titles", {"query": "benchmark"}),
    ("list_docs_25", "list_documents", {"limit": 25}),
    ("revisions_10", "list_revisions", {"documentId": M.SMALL}),
    ("comments_25", "list_comments", {"documentId": M.SMALL}),
    ("write_append", "update_document", {"documentId": M.SMALL, "text": "x\n"}),
]

def timed_call(srv, tool, args):
    t = time.perf_counter(); out = srv.call(tool, args); return (time.perf_counter() - t) * 1000, out

def startup(name, env, runs=7):
    s = SERVERS[name]; ts = []
    for _ in range(runs):
        t = time.perf_counter(); srv = Server(s["cmd"], env=env, cwd=s["cwd"]); srv.init()
        ts.append((time.perf_counter() - t) * 1000); srv.close()
    return ts

def pipelined(srv, n, window, tool, args):
    """Keep `window` requests in flight; return total seconds."""
    sent = done = 0; t = time.perf_counter(); base = srv.n
    def send(i):
        msg = {"jsonrpc": "2.0", "id": base + 1 + i, "method": "tools/call", "params": {"name": tool, "arguments": args}}
        srv.p.stdin.write(json.dumps(msg) + "\n"); srv.p.stdin.flush()
    while done < n:
        while sent < n and sent - done < window: send(sent); sent += 1
        srv.p.stdout.readline(); done += 1
    srv.n = base + n
    return time.perf_counter() - t

def run_mock(name, env, n, warm):
    s = SERVERS[name]; srv = Server(s["cmd"], env=env, cwd=s["cwd"]); srv.init()
    pid = srv.p.pid; res = {"rss_idle_mb": proc_kb(pid, "VmRSS") / 1024, "ops": {}, "hash": {}}
    for op, tool, args in OPS:
        for _ in range(warm): srv.call(tool, args)
        lat = []
        for _ in range(n):
            ms, out = timed_call(srv, tool, args); lat.append(ms)
        res["hash"][op] = hashlib.sha1(out.encode()).hexdigest()[:10]
        res["ops"][op] = {"p50": pct(lat, .5), "p95": pct(lat, .95), "p99": pct(lat, .99),
                          "mean": st.mean(lat), "out_chars": len(out)}
    big = M.LARGE; cnt = 120
    secs = pipelined(srv, cnt, 16, "get_document", {"idOrUrl": big, "maxChars": 400000})
    res["concurrent_get_200KB_rps"] = cnt / secs
    res["rss_peak_mb"] = proc_kb(pid, "VmHWM") / 1024
    srv.close(); return res

def run_real(name, env, n):
    """Page-only operations against the real benchmark page."""
    s = SERVERS[name]; srv = Server(s["cmd"], env=env, cwd=s["cwd"]); srv.init()
    ops = [("read_page", "get_document", {"idOrUrl": DOC_UUID}),
           ("revisions", "list_revisions", {"documentId": DOC_UUID, "limit": 10}),
           ("comments", "list_comments", {"documentId": DOC_UUID}),
           ("write_append", "update_document", {"documentId": DOC_UUID, "text": f"- bench {name}\n"})]
    res = {}
    for op, tool, args in ops:
        lat = []
        for _ in range(n):
            ms, out = timed_call(srv, tool, args); lat.append(ms)
            if out.startswith("Error"): res.setdefault("errors", []).append(f"{op}: {out[:80]}")
            time.sleep(0.15)   # be gentle with a shared wiki
        res[op] = {"p50": pct(lat, .5), "p95": pct(lat, .95), "mean": st.mean(lat)}
    srv.close(); return res

if __name__ == "__main__":
    mode = sys.argv[1]; n = int(sys.argv[2]); out = {}
    if mode == "mock":
        port = 18777
        mock = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "mock_outline.py"), str(port)])
        time.sleep(0.8)
        env = {"OUTLINE_API_URL": f"http://127.0.0.1:{port}", "OUTLINE_API_KEY": "dummy", "OUTLINE_WRITE_DOC_ID": M.SMALL}
        try:
            for name in SERVERS:
                st_ms = startup(name, env)
                r = run_mock(name, env, n, warm=20); r["startup_ms"] = st_ms
                out[name] = r; print(f"done {name}", file=sys.stderr)
        finally:
            mock.terminate()
    else:
        if not DOC_UUID:
            sys.exit("real mode needs BENCH_DOC_UUID (the one page it may read and write), "
                     "OUTLINE_API_URL and OUTLINE_API_KEY")
        env = load_env()
        for name in SERVERS:
            out[name] = run_real(name, env, n); print(f"done {name}", file=sys.stderr)
    json.dump(out, open(f"{os.path.dirname(__file__)}/results_{mode}.json", "w"), indent=1)
