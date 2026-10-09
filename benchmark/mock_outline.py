"""Fast, deterministic stand-in for the Outline API (POST /api/<method>).

Bodies follow the live API's shapes (verified against a live instance) and are
sized like real pages, so the three MCP servers do realistic parsing/rendering
work without the benchmark touching the company wiki.
"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SMALL = "3f9a2c10-1b2c-4d5e-8f90-abcdef123456"
LARGE = "22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee"
PARA = ("Đặc tả luồng thanh toán: người dùng chọn phương thức, hệ thống kiểm tra hạn mức, "
        "tạo giao dịch và gửi thông báo ZNS khi hoàn tất. **Lưu ý** các trường hợp lỗi.\n")
LARGE_TEXT = (PARA * 1400)[:200_000]          # ~200 KB of markdown
PERSON = {"id": "u1", "name": "quanbm"}

def doc(i, text=""):
    return {"id": f"d{i:04d}-0000-4000-8000-000000000000", "urlId": f"abcdefg{i:04d}"[:12],
            "title": f"Tài liệu đặc tả số {i}", "text": text, "url": f"/doc/tai-lieu-{i}-abcdefg{i:04d}"[:40],
            "collectionId": "c0000000-0000-4000-8000-000000000001",
            "updatedAt": "2026-10-09T12:58:08.654Z", "updatedBy": PERSON}

def pag(n, limit): return {"offset": 0, "limit": limit, "total": n}

def respond(method, p):
    lim = p.get("limit", 25)
    if method in ("documents.info", "documents.update", "documents.create"):
        big = p.get("id") == LARGE
        d = doc(1, LARGE_TEXT if big else "Nội dung ngắn của trang benchmark.\n")
        d["id"] = p.get("id") if p.get("id") in (SMALL, LARGE) else d["id"]
        return {"data": d}
    if method == "documents.search":
        hits = [{"ranking": 0.9 - i / 100, "context": (PARA * 2)[:p.get("contextLimit", 200)],
                 "document": doc(i, PARA * 5)} for i in range(lim)]
        return {"data": hits, "pagination": pag(120, lim)}
    if method == "documents.search_titles":
        return {"data": [doc(i) for i in range(lim)], "pagination": pag(120, lim)}
    if method == "documents.list":
        return {"data": [doc(i) for i in range(lim)], "pagination": pag(300, lim)}
    if method == "collections.list":
        return {"data": [{"id": f"c{i:04d}", "name": f"Collection {i}"} for i in range(lim)], "pagination": pag(12, lim)}
    if method == "revisions.list":
        return {"data": [{"id": f"r{i:04d}", "title": "Tài liệu", "createdAt": "2026-10-09T12:58:08.654Z",
                          "createdBy": PERSON} for i in range(lim)], "pagination": pag(40, lim)}
    if method == "revisions.info":
        return {"data": {"id": p.get("id"), "documentId": SMALL, "title": "Tài liệu", "text": LARGE_TEXT,
                         "createdAt": "2026-10-09T12:58:08.654Z", "createdBy": PERSON}}
    if method == "comments.list":
        return {"data": [{"id": f"m{i:04d}", "createdAt": "2026-10-09T12:58:08.654Z", "createdBy": PERSON}
                         for i in range(lim)], "pagination": pag(60, lim)}
    if method in ("documents.move", "documents.archive", "documents.delete"):
        return {"data": {"success": True}}
    return None

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        params = json.loads(self.rfile.read(n) or b"{}")
        body = respond(self.path.removeprefix("/api/"), params)
        code = 200 if body is not None else 404
        raw = json.dumps(body if body is not None else {"error": "not_found"}).encode()
        # One write for headers + body: two small writes trip TCP delayed-ACK (~40 ms).
        status = "200 OK" if code == 200 else "404 Not Found"
        head = (f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(raw)}\r\n\r\n").encode()
        self.wfile.write(head + raw)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18777
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
