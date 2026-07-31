# yantrad — tracker

The slice of [`tracker.md`](../../tracker.md) that belongs to this crate: **the invariants that bind
code in `crates/yantrad`**, and nothing else. The main tracker still owns milestones, tasks,
decisions, open questions and risks, and it still wins when anything disagrees with it.

**The crate is an M0 skeleton — no daemon exists yet.** These invariants were earned during
research, before there was anywhere to put them, and they are here so that whoever writes the daemon
finds them before repeating the measurement. Nothing below has been exercised by shipped code.

## Invariants

Non-obvious rules that research proved the hard way. Violating one of these produces a bug that looks
like something else entirely. **[V]** = verified by execution, **[D]** = documented only.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-7 **[D]** | Own reboot recovery in Yantra's own store. Do **not** adopt tmux-resurrect/continuum. | They re-run whitelisted commands rather than restore processes, on a 15-minute lossy timer — worse than nothing for an agent session. | R2 |
| I-10 **[D]** | **If a signal is not in the decision record, it must not influence the decision.** | The explainability contract. `yantra why` is worthless the moment a hidden term can move the outcome. | R5 |
| I-11 **[D]** | Tie-breaks are deterministic: score → static `priority` → name. Explicitly **reject** kube-scheduler's random tie-break. | Reproducibility is the whole point of an explainable placement. | R5 |
| I-12 **[V]** | **Set `busy_timeout` and `journal_mode = WAL` explicitly on every connection open.** Never rely on the binding's default. | Verified across **two independent bindings** — `bun:sqlite` defaults to 0, and `node:sqlite`'s `timeout` also defaults to 0. This is a SQLite-binding trap, not a runtime quirk, so confirm it for `rusqlite` too. Five machines heartbeating every 10 s will otherwise produce intermittent `SQLITE_BUSY` that presents as a network or agent fault. | R6a, R6b |
| I-13 **[D]** | **SQLite calls go through `spawn_blocking`. Keep queries O(small) regardless.** | `rusqlite` wraps a synchronous C API. Called directly from an async task it stalls the tokio worker serving WebSocket terminal streams — the same failure Bun had (a 400 ms query served **0 of 100** concurrent pings), for the same reason, but with a proper fix available. | R6a + ADR-0004 |
| I-14 **[D]** | **No ORM in v1** — `rusqlite` with hand-written SQL. Back up with `VACUUM INTO`. | Yantra's schema is four small tables. Diesel/SeaORM buy migrations and compile-time type-safety we do not yet need, at the cost of build time and indirection. Revisit when the schema stops being trivial. | R6a + ADR-0004 |
| I-18 **[V]** | **The PTY must give the child a controlling terminal**, or `^C` will not work. Verify this explicitly in the `portable-pty` integration test. | Found the hard way in Bun (`new Bun.Terminal()` had exactly this defect). The bug is language-independent and easy to ship unnoticed — an interactive terminal that cannot be interrupted. | R6 |

Two of these carry a warning about their own age. I-12 was verified against **`bun:sqlite` and
`node:sqlite`**, neither of which this project uses any more ([ADR-0004](../../docs/adr/0004-rust-for-the-daemon.md)) —
the trap is a SQLite-binding trap rather than a runtime quirk, so it is expected to hold for
`rusqlite`, but *expected* is not *measured*. I-18 was found in Bun's terminal for the same reason.
Confirm both against the real crate before relying on them.

## Open work

Task rows live in [`tracker.md` §3](../../tracker.md). Open and touching this crate: **Y-044**
(session store — only if state genuinely cannot be derived from tmux) and **Y-020** (the telemetry
ADR). M4 builds this crate; its tasks are not broken down yet.
