# yantrad

The Yantra control-plane daemon: machine inventory, workspaces, session state, placement. Every
client — CLI, web UI, hardware panel — talks to this and nothing else.

**Not implemented yet.** It prints its version and exits. The daemon arrives in M4, when the web UI
needs something to talk to; until then the CLI calls
[`yantra-core`](../yantra-core/README.md) in-process, which is the same code the daemon will serve.

[tracker.md](tracker.md) collects what research already settled about it — SQLite handling, scheduling
determinism, PTYs — none of it exercised by code yet. See [../../tracker.md](../../tracker.md) for
where this sits in the roadmap.
