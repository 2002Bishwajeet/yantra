"""A slow OpenAI-compatible model for tests/acp.rs (Y-471): it counts to 500, one number per chunk."""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def chunk(delta, finish=None):
    choice = {"index": 0, "delta": delta, "finish_reason": finish}
    body = {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": "slow", "choices": [choice]}
    return f"data: {json.dumps(body)}\n\n".encode()


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        if not request.get("stream"):
            message = {"role": "assistant", "content": "Counting"}
            body = {
                "id": "stub",
                "object": "chat.completion",
                "created": 0,
                "model": "slow",
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            self.wfile.write(chunk({"role": "assistant", "content": ""}))
            for n in range(1, 501):
                self.wfile.write(chunk({"content": f"{n}\n"}))
                self.wfile.flush()
                time.sleep(0.1)
            self.wfile.write(chunk({}, "stop"))
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # The client cancelled the turn.

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", 8471), Stub).serve_forever()
