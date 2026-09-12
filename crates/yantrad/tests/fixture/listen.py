"""yantrad's `POST /api/join`, as far as the join script can tell (Y-387).

It appends each body it receives to a file and answers the shape the real
route answers, so the test reads back the account the script reported. The
real route's own behaviour is `write.rs`'s tests; this stands in for the
tailnet, which no container holds.
"""

import http.server
import json
import sys

reports = sys.argv[1]


class Join(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with open(reports, "ab") as out:
            out.write(body + b"\n")
        if self.path != "/api/join":
            self.send_response(404)
            self.end_headers()
            return
        reply = json.dumps(
            {"machine": "fixture-box", "user": json.loads(body)["user"], "configured": True},
            separators=(",", ":"),
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


http.server.HTTPServer(("127.0.0.1", 7717), Join).serve_forever()
