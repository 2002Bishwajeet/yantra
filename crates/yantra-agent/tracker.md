# yantra-agent — tracker

The slice of [`tracker.md`](../../tracker.md) that belongs to this crate: **the invariants that bind
code in `crates/yantra-agent`**, and nothing else. The main tracker still owns milestones, tasks,
decisions, open questions and risks, and it still wins when anything disagrees with it.

**The loop and the transport ship (Y-107); the probes do not (Y-106).** Both invariants below came
out of the telemetry research (R1, R5, R6) and neither has been exercised by shipped code — I-9
belongs to the power reader, which is Y-106's, and I-19 to hardware this crate does not touch yet.

## Invariants

Non-obvious rules that research proved the hard way. Violating one of these produces a bug that looks
like something else entirely. **[V]** = verified by execution, **[D]** = documented only.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-9 **[D]** | **Absence of power-supply data must mean AC, never "unknown".** Desktops have *no* `/sys/class/power_supply/AC*` entry at all; `BAT0/status` reads `Not charging` while on AC; `Win32_Battery` returns **no instances** on Windows desktops. | The naive reading marks every desktop "unknown power" and the battery signal silently mis-scores the most placeable machines in the fleet. | R5 **Grade corrected 2026-08-02 (Y-106): the desktop half was never measured, because this fleet has no desktop.** `cachyos-g14` is a laptop carrying `AC0` *and* `BAT0`, `bishwajeets-macbook-pro` is a laptop, and R5's Linux column ran on the former — so *"desktops have no `AC*` entry"* is read from documentation, not from a machine here. What **is** `[V]` now, on both: `Power::Ac` returned despite two live traps — `BAT0/status` reading `Not charging` at 100 % on mains, and a **third** power-supply device, `ucsi-source-psy-USBC000:001`, `type=USB` with `online=0` while plugged in, which makes a glob over `*/online` report `Battery` on an AC laptop. Filter on `type`. `Power::Battery` is also `[D]` — both machines stayed on mains throughout — and is produced only from a fake sysfs tree and a recorded `pmset` string. Y-110 is what closes both. **Half closed 2026-08-03 (Y-110): `bishwajeets-macbook-pro` was unplugged and a real `Power::Battery { percent: 100 }` reached the daemon**, so the *macOS* battery path is `[V]` and its fixture is a recording rather than a guess. The reading is the trap itself — **100 % while `discharging`**, identical to the AC fixture's percentage, so only `pmset`'s first line separates the two states. The **Linux** battery path stays `[D]`: `cachyos-g14` held `AC0/online: 1` throughout, and the desktop half still has no desktop. |
| I-19 **[V]** | **Never hardcode a `gpiochip` number.** Discover it at runtime. | The Pi 5's RP1 southbridge moved the chip numbering; hardcoded values silently address the wrong chip. | R6 |

I-9 is the one that will bite. It is not a hardware detail but a **scoring** bug in disguise: read
naively, the fleet's most placeable machines — the always-on desktops — are the ones marked *unknown
power* and scored down for it.

## Open work

Task rows live in [`tracker.md` §3](../../tracker.md). What this crate reports and how often is
settled by [ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md), and
how each of the seven fields is read on Linux and macOS is measured in
[the heartbeat-agent plan](../../docs/plans/the-heartbeat-agent.md) §3. **Y-106** fills `measure()`; until it
does, the agent sends a machine that fails every hard filter. **I-50** — dial the address, never the
MagicDNS name — binds `YANTRA_DAEMON` and lives in the root tracker.
