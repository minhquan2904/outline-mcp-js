import hashlib, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from mcpcall import Server
from servers import SERVERS, DOC_UUID, DOC_URL, load_env

READS = [
    ("list_collections", {"limit": 5}),
    ("get_document", {"idOrUrl": DOC_URL, "maxChars": 2000}),
    ("get_document", {"idOrUrl": DOC_UUID, "maxChars": 5}),
    ("get_document", {"idOrUrl": "short"}),
    ("search_document_titles", {"query": "benchmark", "limit": 5}),
    ("search_documents", {"query": "benchmark", "limit": 3}),
    ("list_revisions", {"documentId": DOC_UUID, "limit": 5}),
    ("list_comments", {"documentId": DOC_UUID}),
]
env = load_env()
out = {}
for name, s in SERVERS.items():
    srv = Server(s["cmd"], env=env, cwd=s["cwd"]); srv.init()
    out[name] = {"tools": sorted(srv.tools()), "calls": [srv.call(t, a) for t, a in READS]}
    srv.close()

ref = out["js"]
print("tools equal to JS:", {n: out[n]["tools"] == ref["tools"] for n in out})
for i, (t, a) in enumerate(READS):
    hs = {n: hashlib.sha1(out[n]["calls"][i].encode()).hexdigest()[:8] for n in out}
    same = len(set(hs.values())) == 1
    print(("SAME " if same else "DIFF ") + t, {k: v for k, v in a.items() if k != "documentId"}, "" if same else hs)
    if not same:
        for n in out: print(f"   [{n}] {out[n]['calls'][i][:160]!r}")
