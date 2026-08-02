# ADR-0015 — `resume` forks the conversation rather than resuming a session id

- **Date:** 2026-08-02
- **Status:** accepted
- **Extends:** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) — its *Launch* bullet only,
  which describes one of the two commands Yantra puts in a pane. Nothing in ADR-0011 is superseded
  or amended: the agent is still an ordinary interactive TUI in tmux, the transcript JSONL is still
  the log, there is still no headless path, and Yantra still sends the agent no input.

## Context

[`docs/brainstorm.md`](../brainstorm.md) names four agent verbs — *Launch. Resume. Stop. View logs.*
— and Q9 killed Aider on the second of them: *"Yantra's core promise is 'continue where you left
off'."* Yantra shipped three. `resume` is Y-077, built 2026-07-31.

**Yantra has no session id to resume by, and that is now permanent rather than pending.** ADR-0011
chooses a fresh `--session-id <uuid>` per launch, and nothing persists it. The task that would have
was Y-044's session store, and Y-044 was **dropped without being built on 2026-08-02**: what the
store would have held is already held by three stores Yantra did not write, and no consumer of it
survived the audit. So the id is not merely unkept today; there is no plan under which it becomes
kept.

That is the constraint. What Claude Code offers against it was **measured against the installed
2.1.220, not read out of the documentation**:

| Flag | What it actually does | Why it is not the answer |
| --- | --- | --- |
| `--resume <id>` | resumes the named conversation | there is no id to name |
| `--resume` (bare) | opens an **interactive picker** | resumes nothing until a human attaches and answers it — Yantra would report success over a menu |
| `--continue` | resolves the last conversation **from the cwd** | reuses the *original* session id, which costs the predictable transcript path |
| `--continue --session-id <uuid>` | nothing — it exits | **refused outright**: *"--session-id can only be used with --continue or --resume if --fork-session is also specified."* |

Two of those rows matter more than they look.

**The cwd is not an obstacle, it is already paid for.** `claude` has no cwd flag, so ADR-0011 made
the `cd` into `repo` mandatory for an unrelated reason. That `cd` is exactly the argument
`--continue` reads. The one part of the launch command that looked like a wart is what makes
resuming addressable at all.

**The last row is what forces the fork.** It is not a preference between two working spellings: the
pair Yantra wants is rejected by the tool unless `--fork-session` is present.

## Decision

**`resume` runs `cd <repo> && exec claude --continue --fork-session --session-id <uuid>`.** It
differs from ADR-0011's launch command by two flags, and each of the three is load-bearing.

**1. `--continue`, because Yantra kept no id.** This is the whole of the reason. It is not a claim
that `--continue` is better than `--resume <id>`; it is that the alternative needs state this
project decided not to hold.

**2. `--fork-session`, because 2.1.220 refuses `--session-id` beside `--continue` without it.** The
fork is not merely a way past a validation message. It is what makes the resumed conversation
Yantra's: the forked transcript carries the earlier turns, and the project directory ends up holding
the original beside a fork named by the id Yantra passed. Verified end to end on 2.1.220, and again
by Y-094 from the other side, which found every `*.jsonl` under `~/.claude/projects/*/` carrying an
internal `"sessionId"` equal to its own basename.

**3. `--session-id <uuid>`, because the transcript path is what ADR-0011 built `logs` on.** Without
the fork, `--continue` alone would run under the original id — an id Yantra does not know — and
`logs` would be back on *newest file in the directory*. Since Y-094 that is not a smaller guarantee
but a different code path: `logs` now opens `<session-id>.jsonl` **by name**, reading the id out of
the pane's start command, and falls back to `ls -t | head -n 1` only where there is no id to name.
The fork is what keeps `resume`'d sessions on the named path rather than the fallback.

**Every verdict is spelled out, and none of them defaults into a respawn.** The map from
`status::Verdict` to an action is an exhaustive `match` with no wildcard arm, so a state added later
cannot quietly inherit "put an agent in that pane". That has already earned itself once: Y-091's new
`Verdict::NoAgent` was caught at compile time rather than by respawning a pane a human was sitting
in.

**What `resume` refuses rather than guesses**, and the defect each refusal exists to prevent:

- **An agent is already running** — left exactly as it is, reported, exit 0. §B4's idempotency one
  verb along: there is nothing to continue, and the alternative is a second agent in the pane the
  first is working in.
- **An agent is holding at the trust dialog** — refused. By **I-49** it is inert: it appears in no
  `claude agents --json` entry and has written no transcript, so there is no conversation to
  continue, and ADR-0011 settled that the one who answers that dialog is never Yantra.
- **The session was opened as a shell** (`Verdict::NoAgent`, Y-091) — refused. Starting a *first*
  agent is `up --agent`, which is a different verb, and the pane may have someone working in it.
- **The pane is alive and the registry knows of no agent in that directory** — refused, carrying the
  reason forward verbatim. This is R-2's shape, and respawning it would destroy the evidence needed
  to find out what it was.
- **The workspace runs its own `startup`** — refused, for ADR-0007's reason and in the same words
  `up --agent` already uses: a workspace that starts something of its own is not running an agent,
  and silently replacing it is that ADR's worst kind of bug.

**The four endings are one state, and they resume into the pane they ended in.** *Finished*,
*stopped*, *crashed* and *killed* differ only in how the process went out; in all four the pane
outlived it because of `remain-on-exit` (**I-4**), so putting the agent back is `respawn-pane` and
never a second session (**I-29**). `tmux::respawn_with` was widened to the public `tmux::respawn`
for it.

**A respawn re-makes the checks an open gets for free.** `Plan::Open` goes through `up::open` and
inherits Y-081's far-side `test -d` on `repo`; a respawn reaches tmux directly and did not. Found in
review: a workspace whose session was alive and whose `repo` had since been deleted got
`cd '<gone>' && exec claude …`, the `cd` failed, the pane died again, and `resume` reported
**`Resumed`**. `ensure_repo` is now `pub(crate)` and called from the respawn arm — inside it, not
before the `match`, so the open path does not buy a second round trip for a check it already makes.
The rule this settles is general: **any path that reaches tmux without going through `up::open` owes
that check itself.**

### Deliberately deferred

**`--resume <id>`, and the store behind it.** Y-044 is dropped rather than pending, so this is
deferred in the sense that it is not foreclosed, not in the sense that it is coming.

**`pane_start_command` holds an id, and that is not the same as having kept one.** Y-091 put the
launch command in reach — tmux reports what Yantra asked the pane to run, `--session-id <uuid>`
included, it survives the process (I-4), and it is rewritten on respawn. So wherever a pane still
exists, an id *is* readable, and `--resume <id>` could in principle be spelled from it. It is not,
for three reasons. The id lives exactly as long as the pane does, so the state `resume` most exists
for — a workspace with no session at all, after a `down`, a reboot, or on a machine where it has
never been opened — has no pane to read it from. Where a pane does exist, the id names the
conversation `--continue` resolves to anyway; the two disagree only if something other than that
pane ran `claude` in that repo more recently, and which of them is right *then* is a judgement no
flag settles. And the value arrives wrapped in quotes of tmux's own (**I-51**), so it needs a
parser, which is a second thing to get wrong in service of a flag whose alternative needs none.

**Detecting that the workspace has no agent history.** There is no flag for it (see below), and the
only mechanism that would work is the store that was just dropped. Left undetected rather than
guessed at.

## Consequences

**Gained**

- The promise Q9 used to reject an agent CLI is now a verb: a conversation started on one machine is
  picked up by `yantra resume <workspace>`, in the same pane, with its earlier turns present.
- `logs` follows a resumed session by name rather than by recency, because the fork's id is one
  Yantra chose.
- Every refusal names the state it refused and why, and no refusal costs a round trip to
  `claude auth status` — the agent is prepared only after the state is known.
- Resuming a running agent cannot produce a second one, by construction rather than by a check
  bolted on afterwards.

**Paid**

- **No flag can tell Yantra there was nothing to resume.** `--continue` in a directory with no
  earlier conversation **starts a fresh one and exits 0** — measured, not assumed. So
  `yantra resume <never-used-workspace>` is `yantra up --agent claude <workspace>` under another
  name, and it reports `Resumed`. Nothing in the exit status, the output, or the registry separates
  the two. This is the one thing `resume` says that it cannot know, and it is recorded here rather
  than papered over in the CLI's wording.
- **Every resume mints a transcript.** The fork copies the earlier turns into a new file and leaves
  the original in place, so *n* resumes leave *n*+1 files in the project directory, each older one a
  prefix of the next. `logs` is unaffected because it names the file it wants, but a human reading
  `~/.claude/projects/<slug>/` sees one conversation spread across several files, and what
  eventually removes them is Claude Code's own `cleanupPeriodDays` (default 30), not Yantra.
- **Two more flags of someone else's CLI on the critical path.** ADR-0011 already accepted that the
  transcript is a format Anthropic does not version; this adds a *validation rule* to the same
  account. A release that stops refusing `--continue --session-id`, or renames `--fork-session`,
  breaks `resume` while leaving `up` working — a narrower blast radius than ADR-0011's, and a less
  obvious one.
- Two verbs now have to agree about a missing `repo`. The review gap above was not worse than
  Y-081's original bug in what it did; it was worse in that `up` and `resume` **disagreed** about
  the same workspace on the same machine, which is harder to diagnose than either behaviour on its
  own.

**Not resolved**

- The undetectable first resume, above. What would change it is a store, and Y-044's row names the
  trigger that would bring one back: the first question anybody asks about the *past*. A flag or
  exit code from Claude Code distinguishing *continued* from *started fresh* would also settle it,
  and that is upstream, not here.
- **The dashboard cannot offer this verb yet.** Y-097 found `resume` is the one verb the read model
  cannot choose honestly, because offering it means knowing the agent *ended* rather than never
  started. Y-084 put the verdict in the API; Y-096 is where the choice lands. Nothing here decides
  it.
