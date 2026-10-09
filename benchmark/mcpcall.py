"""Minimal MCP stdio client: spawn a server, run initialize, then tool calls."""
import json, os, subprocess, sys, time

class Server:
    def __init__(self, cmd, env=None, cwd=None):
        e = dict(os.environ); e.update(env or {})
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=e, cwd=cwd, text=True, bufsize=1)
        self.n = 0
    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None: msg["params"] = params
        if not notify:
            self.n += 1; msg["id"] = self.n
        self.p.stdin.write(json.dumps(msg) + "\n"); self.p.stdin.flush()
        if notify: return None
        while True:
            line = self.p.stdout.readline()
            if not line: raise RuntimeError("server closed")
            d = json.loads(line)
            if d.get("id") == self.n: return d
    def init(self):
        r = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "bench", "version": "0"}})
        self.rpc("notifications/initialized", notify=True)
        return r
    def tools(self):
        return [t["name"] for t in self.rpc("tools/list")["result"]["tools"]]
    def call(self, name, args):
        d = self.rpc("tools/call", {"name": name, "arguments": args})
        if "error" in d: return "RPC-ERROR: " + json.dumps(d["error"])
        return "".join(c.get("text", "") for c in d["result"]["content"])
    def close(self):
        try: self.p.stdin.close(); self.p.wait(timeout=5)
        except Exception: self.p.kill()

if __name__ == "__main__":
    # usage: mcpcall.py <tool> '<json args>' -- <server cmd...>
    tool, args = sys.argv[1], json.loads(sys.argv[2]); cmd = sys.argv[sys.argv.index("--") + 1:]
    s = Server(cmd); s.init(); print(s.call(tool, args)); s.close()
