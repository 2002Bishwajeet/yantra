"""A stand-in for the Messages API, so a real `claude -p` runs with no network.

Every request is appended to the log as one JSON line, path and body, so the
test can read what Claude Code sent after a resume.
Usage: messages.py <port> <log>
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = sys.argv[2]
REPLY = "noted"


def events(model):
    usage = {"input_tokens": 1, "output_tokens": 1}
    yield "message_start", {
        "type": "message_start",
        "message": {
            "id": "msg_stub",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": usage,
        },
    }
    yield "content_block_start", {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""},
    }
    yield "content_block_delta", {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": REPLY},
    }
    yield "content_block_stop", {"type": "content_block_stop", "index": 0}
    yield "message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": 1},
    }
    yield "message_stop", {"type": "message_stop"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length)
        with open(LOG, "a") as log:
            log.write(json.dumps({"path": self.path, "body": raw.decode("utf-8", "replace")}) + "\n")
        if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
            self.send_response(404)
            self.end_headers()
            return
        body = json.loads(raw or b"{}")
        model = body.get("model", "stub")
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for name, data in events(model):
                self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()
            return
        message = {
            "id": "msg_stub",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": REPLY}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
        payload = json.dumps(message).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        with open(LOG, "a") as log:
            log.write(json.dumps({"path": self.path, "body": ""}) + "\n")
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
