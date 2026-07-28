# Research notes

Dated evidence gathered before writing code. Each note answers a specific question that blocks a
decision, and ends with sources and access dates.

**Research is evidence, not eternal truth.** These tools (especially the AI agent CLIs and Bun) change
monthly. Re-verify anything version-sensitive before relying on it. If a note turns out to be wrong,
correct it in place with a note about what changed and when.

| # | Topic | Blocks | File |
| --- | --- | --- | --- |
| R1 | Tailscale / Headscale machine inventory | ADR-0007 (telemetry source) | [01-tailscale-inventory.md](01-tailscale-inventory.md) |
| R2 | tmux session control & terminal streaming | M1 tmux primitive, M6 web terminal | [02-tmux-sessions.md](02-tmux-sessions.md) |
| R3 | AI coding agent CLIs — launch / resume / logs | ADR-0006 (agent plugin interface) | [03-ai-agent-clis.md](03-ai-agent-clis.md) |
| R4 | Workspace prior art — Coder, DevPod, devcontainers | ADR-0005 (workspace schema), Q1 | [04-workspace-prior-art.md](04-workspace-prior-art.md) |
| R5 | Scheduling & placement | M5 | [05-scheduling.md](05-scheduling.md) |
| R6 | Bun on Pi 5, SSH, PTY, GPIO feasibility | ADR-0005 (transport), M8 hardware | [06-runtime-feasibility.md](06-runtime-feasibility.md) |
| R6a | `bun:sqlite` as datastore | I-12, I-13, I-14 | [06a-bun-sqlite.md](06a-bun-sqlite.md) |
| R6b | Node.js as fallback runtime | ADR-0004 | [06b-node-fallback.md](06b-node-fallback.md) |
| R6c | Bun native modules & release health | ADR-0004 | [06c-bun-native-modules.md](06c-bun-native-modules.md) |

> **Note on notes 06, 06a, 06b, 06c.** These were written while the target runtime was TypeScript on
> Bun. [ADR-0004](../adr/0004-rust-for-the-daemon.md) superseded that the same day — the daemon is Rust.
> They are kept unedited as dated evidence, each with a header saying so. Bun was **not** disqualified;
> R6's verdict was GO-WITH-CAVEATS. The decision criteria changed, not the evidence. Their findings on
> tmux, PTY semantics, SQLite bindings and Pi 5 hardware remain useful; their runtime recommendations
> do not.

## The question behind all of it

> What already exists? What should be reused? What should become a plugin?
> **What is Yantra uniquely responsible for?**

R4 is the one that can kill or reshape the project — if Coder already does this well enough for a
personal multi-OS setup, that needs to be said out loud rather than discovered in month four.
