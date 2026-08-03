# yantrad — tracker

The slice of [`tracker.md`](../../tracker.md) that belongs to this crate: **the invariants that bind
code in `crates/yantrad`**, and nothing else. The main tracker still owns milestones, tasks,
decisions, open questions and risks, and it still wins when anything disagrees with it.

**The daemon exists now but is small**: it binds, serves `/healthz`, and refreshes a snapshot in the
background (Y-069, Y-070). The invariants below were earned during research, before there was
anywhere to put them, and **none has been exercised by shipped code yet** — the daemon holds no
state on disk and makes no placement decisions.

## Invariants

Non-obvious rules that research proved the hard way. Violating one of these produces a bug that looks
like something else entirely. **[V]** = verified by execution, **[D]** = documented only.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-7 **[D]** | Own reboot recovery in Yantra's own store. Do **not** adopt tmux-resurrect/continuum. | They re-run whitelisted commands rather than restore processes, on a 15-minute lossy timer — worse than nothing for an agent session. | R2 |
| I-10 **[D]** | **If a signal is not in the decision record, it must not influence the decision.** | The explainability contract. `yantra why` is worthless the moment a hidden term can move the outcome. | R5 |
| I-11 **[D]** | Tie-breaks are deterministic: score → static `priority` → name. Explicitly **reject** kube-scheduler's random tie-break. | Reproducibility is the whole point of an explainable placement. | R5 |
| I-12 **[V]** | **Set `busy_timeout` and `journal_mode = WAL` explicitly on every connection open.** Never rely on the binding's default. | Verified against **two independent SQLite bindings**, both of which default `busy_timeout` to 0 with no constructor option. This is a SQLite-binding trap rather than a property of any one runtime, so confirm it for `rusqlite` too. Five machines heartbeating every 10 s will otherwise produce intermittent `SQLITE_BUSY` that presents as a network or agent fault. | R6 |
| I-13 **[D]** | **SQLite calls go through `spawn_blocking`. Keep queries O(small) regardless.** | `rusqlite` wraps a synchronous C API. Called directly from an async task it stalls the tokio worker serving WebSocket terminal streams. Measured on a synchronous binding elsewhere: one 400 ms query while 100 requests arrived served **0 of 100**. Rust has the proper fix; the trap is the same. | R6 + ADR-0004 |
| I-14 **[D]** | **No ORM in v1** — `rusqlite` with hand-written SQL. Back up with `VACUUM INTO`. | Yantra's schema is four small tables. Diesel/SeaORM buy migrations and compile-time type-safety we do not yet need, at the cost of build time and indirection. Revisit when the schema stops being trivial. | R6 + ADR-0004 |
| I-18 **[V]** | **The PTY must give the child a controlling terminal**, or `^C` will not work. Verify this explicitly in the `portable-pty` integration test. | Found the hard way in a PTY implementation that skipped `setsid()` + `TIOCSCTTY` when the terminal was constructed before the child rather than with it: `^C` never delivers `SIGINT` and `/dev/tty` resolves to the parent's. The bug is language-independent and easy to ship unnoticed — an interactive terminal that cannot be interrupted. | R6 |

Two of these carry a warning about their own age. **Neither was verified against the crate this
project actually uses.** I-12 was measured on two other SQLite bindings; the trap belongs to SQLite's
C API rather than to any one binding, so it is *expected* to hold for `rusqlite` — but expected is not
measured. I-18 was found in another PTY implementation for the same kind of reason. Confirm both
against the real crate before relying on them.

## Open work

Task rows live in [`tracker.md` §3](../../tracker.md). Open and touching this crate: **Y-118** —
`tailscale serve` launders the caller's address, so ADR-0016's authoriser sees the proxy; the ADR was
accepted 2026-08-03 (Y-103) and is therefore immutable, so the fix is an amending or superseding ADR
rather than an edit. **Y-020** is closed and its telemetry ADR ([ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md))
was accepted on the same day.

**Y-044 is closed** — dropped 2026-08-02 without being built. Session state is derived from tmux
(`pane_start_command`, Y-091) and declared in the workspace TOML, and the audit found no consumer for
a store: the snapshot is deliberately in memory, the heartbeat is deliberately not kept, and nothing
asks the daemon to remember. The tracker row records what would bring one back, and it is a placement
or notification record rather than session state.
