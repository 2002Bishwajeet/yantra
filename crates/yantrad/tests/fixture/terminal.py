"""The dashboard's terminal socket, as tests/update.rs needs it (Y-368).

Fedora ships no websockets module, so this speaks the frames itself: a masked
text frame for the window, binary for the stream, and a pong for every ping.
It does what `web/src/api/socket.ts` does after a close — up to ATTEMPTS
reopens, PAUSE apart — with the two numbers handed in from that file.

    terminal.py update  <session> <attempts> <pause_ms> <marker>
    terminal.py refused <session> <attempts> <pause_ms> <marker>

`update` asks for an update and expects the socket to close and reopen.
`refused` asks for one that fails, and expects the socket to stay up.
"""

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

DAEMON = ("127.0.0.1", 7717)
WINDOW = json.dumps({"rows": 24, "cols": 80, "term": "xterm-256color"}).encode()
# Under the unit's own TimeoutStopSec, so a stop that hangs is seen as one.
CLOSE_BY = 80


class Closed(Exception):
    pass


def say(line):
    print(line, flush=True)


def exactly(sock, n):
    out = b""
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise Closed("the daemon closed the socket")
        out += chunk
    return out


def send(sock, opcode, payload):
    mask = os.urandom(4)
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
    else:
        head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
    body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(head + mask + body)


def upgrade(path):
    sock = socket.create_connection(DAEMON, timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET {path} HTTP/1.1\r\nHost: {DAEMON[0]}:{DAEMON[1]}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    head = b""
    # A byte at a time, so nothing after the headers is read as part of them.
    while b"\r\n\r\n" not in head:
        head += exactly(sock, 1)
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101 " not in status:
        sock.close()
        raise Closed(f"the upgrade was refused: {status}")
    send(sock, 1, WINDOW)
    return sock


def pump(sock, seconds, seen, wanted=None):
    """Reads frames for `seconds`, answering pings. True when `wanted` arrived."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        sock.settimeout(max(0.05, min(0.5, deadline - time.monotonic())))
        try:
            b1, b2 = exactly(sock, 2)
        except socket.timeout:
            continue
        sock.settimeout(10)
        opcode, n = b1 & 0x0F, b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", exactly(sock, 2))[0]
        elif n == 127:
            n = struct.unpack("!Q", exactly(sock, 8))[0]
        payload = exactly(sock, n)
        if opcode == 0x9:
            send(sock, 0xA, payload)
        elif opcode == 0x8:
            raise Closed("the daemon sent a close frame")
        elif opcode == 0x1:
            raise Closed(f"the daemon refused the terminal: {payload.decode(errors='replace')}")
        elif opcode in (0x0, 0x2):
            seen.extend(payload)
            if wanted and wanted in seen:
                return True
    return False


def attached(path, marker):
    sock = upgrade(path)
    if not pump(sock, 30, bytearray(), marker):
        raise SystemExit(f"attached, and the pane never showed {marker!r}")
    return sock


def ask_for_update():
    request = urllib.request.Request(f"http://{DAEMON[0]}:{DAEMON[1]}/api/update", method="POST", data=b"")
    with urllib.request.urlopen(request, timeout=10) as answer:
        if answer.status != 202:
            raise SystemExit(f"POST /api/update answered {answer.status}")


def unit_state():
    return subprocess.run(
        ["systemctl", "show", "-p", "ActiveState", "--value", "yantra-update.service"],
        capture_output=True,
        text=True,
    ).stdout.strip()


def update(path, attempts, pause, marker):
    sock = attached(path, marker)
    say("attached")
    ask_for_update()
    try:
        pump(sock, CLOSE_BY, bytearray())
        raise SystemExit(f"the socket was still open {CLOSE_BY} s after the update was asked for")
    except (Closed, OSError) as why:
        say(f"closed: {why}")
    # socket.ts: a socket that was open is reopened after PAUSE, ATTEMPTS times.
    for attempt in range(1, attempts + 1):
        time.sleep(pause)
        try:
            sock = upgrade(path)
        except (Closed, OSError) as why:
            say(f"attempt {attempt}: {why}")
            continue
        say(f"reopened on attempt {attempt}")
        if not pump(sock, 30, bytearray(), marker):
            raise SystemExit(f"reattached, and the pane never showed {marker!r}")
        say("reattached")
        return
    raise SystemExit(f"no reopen in {attempts} attempts {pause} s apart")


def refused(path, attempts, pause, marker):
    sock = attached(path, marker)
    say("attached")
    ask_for_update()
    deadline = time.monotonic() + 300
    while unit_state() != "failed":
        if time.monotonic() > deadline:
            raise SystemExit(f"yantra-update.service never failed: {unit_state()}")
        pump(sock, 0.5, bytearray())
    say("the unit failed")
    pump(sock, 3, bytearray())
    # The pane's tty echoes what is typed, so this crosses the whole bridge twice.
    typed = b"still-here-" + os.urandom(4).hex().encode()
    send(sock, 2, typed)
    if not pump(sock, 10, bytearray(), typed):
        raise SystemExit("the socket is up and nothing typed came back")
    say("still open")


if __name__ == "__main__":
    mode, session, attempts, pause_ms, marker = sys.argv[1:6]
    path = f"/api/machines/fixture/sessions/{session}/terminal"
    try:
        {"update": update, "refused": refused}[mode](path, int(attempts), int(pause_ms) / 1000, marker.encode())
    except Closed as why:
        raise SystemExit(f"closed: {why}")
