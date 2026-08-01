# Research notes

Dated evidence gathered before writing code. Each note answers a specific question that blocks a
decision, and ends with sources and access dates.

**Research is evidence, not eternal truth.** These tools (especially the AI agent CLIs) change
monthly. Re-verify anything version-sensitive before relying on it. If a note turns out to be wrong,
correct it in place with a note about what changed and when.

**The `Blocks` column links to ADRs and never names them.** An ADR's subject is written down in exactly
one place — its filename — because this table has now drifted from the ADR numbers twice
([Y-080](../../tracker.md)), both times by carrying a hand-written title that quietly became someone
else's decision. A number with no label cannot say the wrong thing, and a link that stops resolving
is a broken build rather than a reader's problem.

| # | Topic | Blocks | File |
| --- | --- | --- | --- |
| R1 | Tailscale / Headscale machine inventory | [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md), Q3 | [01-tailscale-inventory.md](01-tailscale-inventory.md) |
| R2 | tmux session control & terminal streaming | M1 tmux primitive, M6 web terminal | [02-tmux-sessions.md](02-tmux-sessions.md) |
| R3 | AI coding agent CLIs — launch / resume / logs | [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md), Q7, Q9 | [03-ai-agent-clis.md](03-ai-agent-clis.md) |
| R4 | Workspace prior art — Coder, DevPod, devcontainers | [ADR-0007](../adr/0007-workspace-schema-v1.md), Q1 | [04-workspace-prior-art.md](04-workspace-prior-art.md) |
| R5 | Scheduling & placement | M5 | [05-scheduling.md](05-scheduling.md) |
| R6 | Pi 5 feasibility: SSH, PTY, SQLite, hardware I/O | I-12, I-14, I-18, I-19, I-20, M8 hardware | [06-runtime-feasibility.md](06-runtime-feasibility.md) |
| R7 | SSH exec over the system binary | [ADR-0006](../adr/0006-ssh-exec-transport.md) | [07-ssh-transport.md](07-ssh-transport.md) |
| R8 | React + React Compiler + Vite — what "latest" means today | [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md), Y-072 | [08-react-and-the-compiler.md](08-react-and-the-compiler.md) |
| R9 | Component libraries, judged on whether the look is swappable | [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md), Y-072 | [09-component-libraries.md](09-component-libraries.md) |

> **Note on R6.** It was written on day 0 to answer a language question that
> [ADR-0004](../adr/0004-rust-for-the-daemon.md) settled the same day. What survives is the part that
> was never about a language: SSH multiplexing mechanics, the controlling-terminal requirement for a
> PTY, the SQLite-binding traps behind I-12 and I-14, and the Pi 5 hardware findings that make M8
> smaller than planned.

## The question behind all of it

> What already exists? What should be reused? What should become a plugin?
> **What is Yantra uniquely responsible for?**

R4 is the one that can kill or reshape the project — if Coder already does this well enough for a
personal multi-OS setup, that needs to be said out loud rather than discovered in month four.
