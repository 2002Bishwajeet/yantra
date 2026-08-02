# yantra-agent

A small per-machine agent that pushes a heartbeat — is this machine awake, and what is it doing —
so the scheduler can answer "where should this work run?"

It exists because Tailscale reports no telemetry whatsoever, and because polling over SSH cannot
tell a sleeping laptop from an unreachable one. It reports; it does not decide, and keeping it that
way is deliberate.

It POSTs a heartbeat to `yantrad` every 10 seconds and reads nothing from the reply but its status
code. The request is eleven lines of HTTP/1.1 written by hand over a `std::net::TcpStream`: no HTTP
crate, no async runtime, no TLS — WireGuard already encrypts the path. A failed POST drops that beat
rather than queueing it, the interval never changes, and the agent does not exit.

Its whole configuration is one environment variable, set by the service unit:

```
YANTRA_DAEMON=100.x.x.x:7717
```

An **address**, never a name — a MagicDNS short name resolves to `127.0.1.1`, where the daemon does
not listen.

**The probes are not written yet**, so the payload it sends today reports a machine with nothing free
— pessimistic on purpose, since the alternative is placing work on a machine that cannot take it.
[ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md) settles what the
seven fields are and why; [the M5 plan](../../docs/plans/m5-the-heartbeat-agent.md) measures how each
is read on Linux and macOS. What earlier research settled is in [tracker.md](tracker.md).
