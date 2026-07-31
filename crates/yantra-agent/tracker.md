# yantra-agent — tracker

The slice of [`tracker.md`](../../tracker.md) that belongs to this crate: **the invariants that bind
code in `crates/yantra-agent`**, and nothing else. The main tracker still owns milestones, tasks,
decisions, open questions and risks, and it still wins when anything disagrees with it.

**The crate is an M0 skeleton — no agent exists yet.** Both invariants below came out of the
telemetry research (R1, R5, R6) and neither has been exercised by shipped code.

## Invariants

Non-obvious rules that research proved the hard way. Violating one of these produces a bug that looks
like something else entirely. **[V]** = verified by execution, **[D]** = documented only.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-9 **[V]** | **Absence of power-supply data must mean AC, never "unknown".** Desktops have *no* `/sys/class/power_supply/AC*` entry at all; `BAT0/status` reads `Not charging` while on AC; `Win32_Battery` returns **no instances** on Windows desktops. | The naive reading marks every desktop "unknown power" and the battery signal silently mis-scores the most placeable machines in the fleet. | R5 |
| I-19 **[V]** | **Never hardcode a `gpiochip` number.** Discover it at runtime. | The Pi 5's RP1 southbridge moved the chip numbering; hardcoded values silently address the wrong chip. | R6 |

I-9 is the one that will bite. It is not a hardware detail but a **scoring** bug in disguise: read
naively, the fleet's most placeable machines — the always-on desktops — are the ones marked *unknown
power* and scored down for it.

## Open work

Task rows live in [`tracker.md` §3](../../tracker.md). **Y-020**, the telemetry ADR, decides what
this crate reports and how often; Q3 already fixed the shape (push heartbeat, 10 s, stale at 30 s).
