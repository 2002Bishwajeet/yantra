"""yantrad's `POST /api/join`, as far as the join script can tell (Y-387).

It appends each join body it receives to a file and answers the shape the real
route answers, so the test reads back the account the script reported. The
real route's own behaviour is `write.rs`'s tests; this stands in for the
tailnet, which no container holds.

A file named by the second argument, when present, holds the account the
"kept" block logs in as — the owner's re-join case. A readiness check answers
the failure Tailscale prints while the fake `tailscale` still has SSH on and
`/srv/check-mode` exists. Each readiness check and each forgotten host key is
appended to `/srv/asked`, with whether Tailscale SSH was off at the time. Both
need the join code, as the real `/api` gate does: a readiness check in its
`X-Yantra-Join-Code` header, a forgotten host key in its body. Without it they
are answered 401 and not recorded.
Anything else posted here (the agent's heartbeat) is answered 404 and not
recorded.
"""

import http.server
import json
import os
import sys

reports, kept_as = sys.argv[1], sys.argv[2]


class Join(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        ssh_off = os.path.exists("/srv/ssh-off")
        if self.path.endswith("/readiness"):
            coded = bool(self.headers.get("X-Yantra-Join-Code", "").strip())
        elif self.path == "/api/join/forget-host-key":
            coded = bool(json.loads(body or b"{}").get("code"))
        else:
            coded = True
        if not coded:
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.endswith("/readiness") or self.path == "/api/join/forget-host-key":
            with open("/srv/asked", "a") as asked:
                asked.write(f"{self.path.rsplit('/', 1)[-1]} ssh-off={ssh_off}\n")
        if self.path == "/api/join/forget-host-key":
            reply = json.dumps({"machine": "fixture-box", "removed": True}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
            return
        if self.path.endswith("/readiness"):
            blocked = os.path.exists("/srv/check-mode") and not ssh_off
            detail = "Tailscale SSH requires an additional check." if blocked else "a command ran"
            reply = json.dumps({"looked": "ok", "data": {"checks": [{"detail": detail}]}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
            return
        if self.path != "/api/join":
            self.send_response(404)
            self.end_headers()
            return
        with open(reports, "ab") as out:
            out.write(body + b"\n")
        user = json.loads(body)["user"]
        kept = os.path.exists(kept_as)
        logs_in_as = open(kept_as).read().strip() if kept else user
        reply = json.dumps(
            {"machine": "fixture-box", "user": user, "kept": kept, "logs_in_as": logs_in_as},
            separators=(",", ":"),
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


http.server.HTTPServer(("127.0.0.1", 7717), Join).serve_forever()
