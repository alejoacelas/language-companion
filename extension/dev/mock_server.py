"""Fake Language Companion server for testing the extension (stdlib only).

Run: python3 extension/dev/mock_server.py [port]   (default 8790)
Implements the endpoints in docs/api.md with made-up data and prints every request body.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATUSES = ["new", "learning", "known", "known"]
ARTICLES = {"Hund": "der", "Katze": "die", "Haus": "das", "Regierung": "die", "Wetter": "das"}
ignored: set[str] = set()


def lemma_of(word: str) -> str:
    return word if word[:1].isupper() else word.lower()


def status_of(word: str) -> str:
    lemma = lemma_of(word)
    if lemma in ignored:
        return "ignored"
    return STATUSES[sum(map(ord, lemma)) % len(STATUSES)]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, data) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send(204, {})

    def do_GET(self) -> None:
        if self.path == "/api/ping":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        summary = {k: (f"<{len(v)} items>" if isinstance(v, list) and len(v) > 5 else v) for k, v in data.items()}
        print(self.path, json.dumps(summary, ensure_ascii=False), flush=True)

        if self.path == "/api/words/status":
            tokens = {
                t: {"lemma": lemma_of(t), "status": status_of(t), "gloss": f"gloss of {lemma_of(t)}"}
                for t in data.get("tokens", [])
            }
            return self._send(200, {"tokens": tokens})
        if self.path == "/api/lookup":
            word = data.get("word", "")
            lemma = lemma_of(word)
            status = status_of(word)
            return self._send(200, {
                "lemma": lemma,
                "gloss": f"(fake) meaning of {lemma}",
                "article": ARTICLES.get(lemma),
                "contextual": f"(fake) '{word}' in: {data.get('sentence', '')[:60]}",
                "status": status,
                "card_added": status == "new",
            })
        if self.path == "/api/watch":
            return self._send(200, {"ok": True})
        if self.path == "/api/ignore":
            ignored.add(data.get("lemma", ""))
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    print(f"Mock server on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
