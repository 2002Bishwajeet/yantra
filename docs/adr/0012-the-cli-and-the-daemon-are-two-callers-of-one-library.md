# ADR-0012 — The CLI and the daemon are two callers of one library

- **Date:** 2026-07-31
- **Status:** accepted
- **Confirms:** [ADR-0005](0005-core-logic-in-a-library-crate.md) — this is the first time it has a
  second caller, which is the only thing that could have tested it.

## Context

M4's claim in [`tracker.md`](../../tracker.md) §2 reads:

> Read-only dashboard over **the same HTTP API the CLI uses**: machines, workspaces, sessions, live
> status. Served over Tailscale.

The CLI uses no HTTP API. It calls `yantra_core` in-process, and has since M1.

Meanwhile [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md) states the destination
plainly:

> Every client — CLI, web UI, hardware panel — talks to this and nothing else; **no client ever talks
> directly to a managed machine.**

So the milestone text is describing either M4 or the endpoint, and the two differ. Nothing depended
on the ambiguity while `yantrad` was a skeleton that printed its version. M4 makes it load-bearing:
it is the first line of daemon code that decides which of the two is being built.

The two coherent answers, from [the M4 plan](../plans/m4-web-ui.md) §7.1:

**(a) Two callers of one library.** The CLI keeps calling `yantra_core` in-process; `yantrad` becomes
a second caller of the same functions. "The same API" means the daemon exposes exactly what the CLI
can express and no more.

**(b) The CLI becomes an HTTP client.** One path to the fleet, matching the stated destination.

## Decision

**(a). The CLI keeps calling `yantra_core` in-process. `yantrad` is a second caller of the same
functions, not a layer the CLI goes through.**

`yantra` continues to work with no daemon running, on a machine where `yantrad` was never started.

Three things decide it:

- **(b) makes the one working interface depend on the one that does not exist.** The CLI is currently
  the entire product: four milestones of verified behaviour, including a real agent launched, watched
  and stopped on a real machine. `yantrad` is fifteen lines that print a version. Routing the former
  through the latter in the milestone that first proves the latter can serve a page inverts the risk
  — and it does it in the one part of the system that already works.
- **It contradicts §B4's "start small" and §A2's "resist generalising before the third use".** There
  is no third caller. There is barely a second.
- **(a) is reversible and (b) is not.** Adding a `--remote` mode to a working CLI later is additive.
  Removing the in-process path and then discovering that `yantra up` needs to work when the daemon is
  down means restoring it under pressure.

There is also a smaller argument that only became visible while planning: with (a) the CLI and the
daemon **share `ControlMaster` sockets**, because the `ControlPath` is `state_dir/cm/%C` and
`state_dir` is per-user. A running daemon that polls the fleet keeps every ssh master warm, and the
CLI gets 20 ms instead of 150 ms for free. Under (b) that is not a bonus, it is the mechanism —
which is a much larger claim to have to defend.

## What would justify revisiting this

Recording it so the destination does not quietly disappear, per §B0.2. Any of:

- **A client that is not on the operator's machine.** A phone doing more than reading, or the M8
  hardware panel, cannot call a library in-process. That is the real trigger, and it is M6/M8.
- **State that must not be derived twice.** If Y-044's session store ever becomes necessary, two
  processes deriving the same state independently stops being free.
- **Placement (M5).** A scheduler that makes a decision the CLI must also see is a decision that
  needs one owner. `yantra why` reading a decision record the daemon wrote is the shape to watch for.

None of these is M4, and the first two have receded rather than approached.

## Consequences

- `yantrad` gets no logic of its own. A handler that is about to contain a decision means the
  decision belongs in `yantra_core`, where the CLI can reach it too — ADR-0005, unchanged.
- **The CLI is the honesty check, and it now has teeth.** Anything the web UI can do must be
  expressible in `yantra` first. This earns itself immediately: there is no `yantra ls workspaces`
  even though `workspace::list()` exists, so Y-071 adds the subcommand rather than letting the API
  get ahead of the CLI on its first day.
- **Two paths reach the fleet**, and that is a real cost, accepted knowingly. It is the same cost
  ADR-0005 already accepted when it put the logic in a library instead of in the binary that used it.
- The JSON wire format is **not** derived from `yantra_core`'s types. ADR-0005 put rendering in the
  caller, and a JSON body is rendering; deriving `Serialize` on `MachineInfo` would make every field
  name public API and turn a rename into a silently broken page. DTOs live in `yantrad`.
- `yantrad/CLAUDE.md`'s "every client talks to this and nothing else" is **aspirational, and now says
  so.** It describes M6 onward, not M4.
