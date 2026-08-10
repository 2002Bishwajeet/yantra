# yantra (CLI) — working notes

Scoped to this crate. The root [`CLAUDE.md`](../../CLAUDE.md) still binds.

## What belongs here, and what does not

This crate is where Yantra is allowed to **print** and to **choose an exit code**. That is the whole
reason it is separate from [`yantra-core`](../yantra-core/CLAUDE.md), which may do neither
([ADR-0005](../../docs/adr/0005-core-logic-in-a-library-crate.md)).

So: layout, wording, tables, exit codes and clap wiring live here. Anything that decides *what is
true* — how to reach a machine, what a verdict means, whether a session exists — lives in the
library, even when it would be three lines shorter inline. The test is whether the web UI would need
the same logic: if yes, it is not CLI code.

**This crate is no longer cheap, and `yantra notify` is why**: reaching
[`yantra_core::notify`](../yantra-core/CLAUDE.md) reaches `ureq` and its bundled root store, and the
aarch64-musl binary went 1,256,496 → 2,451,504 bytes for it (Y-147). Nothing else here sends
anything, and a verb that wants to should be weighed on `just appliance-size` the same way.

## Exit codes are a contract

Someone will put these in a shell script, so they are behaviour, not cosmetics.

| Case | Code | Why |
| --- | --- | --- |
| bare `yantra` | **0** | it prints help; this predates clap and is preserved deliberately, because clap's default is 2 |
| unknown command / bad args | 2 | clap's own |
| `status`, and nothing is running | 1 | so `yantra status x && …` reads the way it looks |
| `ls sessions` with a machine unreachable | 1 | the table still prints — a caller must be able to tell the answer is **partial** |
| `ls workspaces` with a file that did not load | 1 | the same rule, one class down: the workspaces that loaded still print, and the file that did not is named under the table with its reason (Y-141) |
| `down` on something not running | **0** | absence is the state asked for (I-30, root §B4) |
| `kill` on a session that is not there | **0** | absence again, and it prints which of the two happened rather than one sentence true either way |
| `rm` on a workspace already gone | **0** | the same rule. `DELETE /api/workspaces/{name}` answers `200 {"removed": false}` for it rather than a `404`, so two tabs deleting one workspace do not show a failure for something that worked |
| `rm` while the session is open, or while the machine cannot be asked | 1 | deleting the file strands the session where nothing looks for it, and a check that cannot know must refuse (R-23). `--force` is how a caller means it anyway |
| `doctor`, unless every check is `present` | 1 | *ready* is the only 0, so an installer can loop on it — and an `unknown` is not a yes (R-23). An empty fleet is 1 too: nothing was asked, so nothing is known |
| `edit --machine` when that machine cannot be reached | 1 | it cannot be *known* that no session is being stranded, and a check that cannot know must refuse rather than allow (R-23) |
| `attach`, once it has something to attach to | **none** | see below |

Changing one of these is a breaking change even though nothing declares it.

**`attach` is the one verb outside this table**, because it does not return: it `exec`s `ssh`, so the
process becomes `ssh` and the exit code is `ssh`'s and then tmux's. Everything it can decide it
decides *before* handing over — the workspace exists, a session exists, `TERM` resolves, stdin is a
terminal — and each of those is a normal exit 1. `exec` rather than spawn-and-wait is deliberate:
a supervising parent would have to forward `SIGWINCH`, relay signals and reap a child to add nothing.

## Saying things

- **Name the fix, not just the fault.** `downgrade_notice` ends with the exact command that ends the
  problem; `KEYCHAIN_NOTE` explains why a Mac that works in a terminal can still say *not logged
  in* (I-44). It stopped suggesting `ssh <machine> claude auth status` in Y-151: since
  [ADR-0018](../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md) §5 that is
  the one process whose answer is known to be wrong, and sending someone to reproduce a false
  negative is worse than saying nothing. An error a user cannot act on is half an error.
- **Print the reason with the verdict.** `describe(Verdict::Unclear { because })` carries its own
  explanation, because "unclear" alone tells no one anything.
- **`notify` names the variable and never the value** (Y-147). It is the one command run from a box
  with no screen, so each refusal says which piece of configuration would change it —
  `YANTRA_NTFY_URL` when nothing is configured, `YANTRA_NTFY_TOKEN` when a topic answered 401 or 403
  and none was set. Neither the token nor the URL is ever printed, here or by the library's errors:
  on the public relay the topic *is* the password.
- `report_error` walks the `source()` chain — the useful detail is usually a level or two down, so
  never flatten an error to its top line.
- Multi-line string constants: Rust's `\` line-continuation eats leading whitespace, so an indented
  first line needs `\x20`. Print it and look at it; this was shipped wrong once.

## clap

- Value enums are spelled out, not bools — `--agent claude` rather than `--agent`, so a second agent
  is a new variant rather than a new flag.
- `Cli::command().debug_assert()` is a test. It catches conflicting flags and duplicate names, which
  is the class of mistake the old hand-rolled parser could not make.
- Anything a user types is part of the contract: add a parse test for it. `debug_assert` does not
  check spellings.

## Tests

Rendering functions take data and return a `String` for exactly this reason — they are testable
without a machine, a terminal, or a subprocess. Keep them that way: no `println!` inside a
`render_*`, only in the `async fn` that calls it.
