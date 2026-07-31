# yantra-agent

A small per-machine agent that pushes a heartbeat — is this machine awake, and what is it doing —
so the scheduler can answer "where should this work run?"

It exists because Tailscale reports no telemetry whatsoever, and because polling over SSH cannot
tell a sleeping laptop from an unreachable one. It reports; it does not decide, and keeping it that
way is deliberate.

**Not implemented yet.** It prints its version and exits. The heartbeat's interval, transport and
payload are still undecided — see [tracker.md](../../tracker.md).
