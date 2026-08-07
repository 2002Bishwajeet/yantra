# ADR-0018 — On macOS the tmux server carries the login session, and Yantra gains no second transport

- **Date:** 2026-08-03
- **Status:** accepted 2026-08-05, by the owner ([Y-122](../../tracker.md)) — after §8's premise was
  measured at the Mac's own keyboard and held
- **Closed by acceptance:** Y-122, whose deliverable was this decision. **R-21 is not closed** — it
  says macOS agents cannot authenticate, and that stays true until §1 and §5 ship (Y-151) and M7
  installs §7's launchd job. Closing a risk because a decision exists is the confident lie R-23 names
- **Rests on:** [research 10](../research/10-claude-code-credentials-on-macos.md), which settled that
  this is architecture and not a setting, and on **I-44** / **I-53** in
  [`crates/yantra-core/tracker.md`](../../crates/yantra-core/tracker.md)

## Context

### What is broken, measured rather than inferred

`bishwajeets-macbook-pro`, re-measured 2026-08-03 (**I-44**):

| | |
| --- | --- |
| `launchctl managername` over ssh | **`Background`** — not `gui/<uid>` |
| keychain item `Claude Code-credentials` | **exists, metadata reads fine** — an existence check passes |
| `security find-generic-password -w` | exits **36**, zero bytes on stdout *and* stderr |
| `launchctl asuser $(id -u)` | *Could not switch to audit session* — it needs root |
| `security unlock-keychain` | wants a password, so [§B4](../../CLAUDE.md) refuses it outright |

**The account is logged in. The token is unreadable from where Yantra stands.** Linux is unaffected —
there the credential is a plain `~/.claude/.credentials.json`, which is why Y-023's spike saw none of
this. The consequence is one clause of M5's acceptance test: *start a session on the Mac* has never
worked, on one of the two machines in this fleet that is online.

### The question that was open is closed, and it closes badly

[R10](../research/10-claude-code-credentials-on-macos.md) asked whether Claude Code `2.1.220` can be
told to keep the credential in a file, as it does on Linux. It cannot. Storage is documented per
operating system, the one relocation knob (`CLAUDE_CONFIG_DIR`) is scoped by the docs to *"Linux or
Windows"* with macOS excluded by name, and the shipped binary carries no `useKeychain`,
`credentialStore` or `disableKeychain` of any kind. What exists instead are five precedence levels
that **supply** a credential from outside, and R10's verdict on them is the sentence this ADR is
built on: **every one is a secret value Yantra would have to hold, set or pass, and §B4 disqualifies
the lot.** Three of the four also move billing off the subscription; the one that does not,
`CLAUDE_CODE_OAUTH_TOKEN`, is a one-year secret whose only home is an environment variable.

Two further findings from R10 bind anything proposed here:

- **`~/.claude/.credentials.json` does exist on the Mac** — `0600`, readable from the ssh session —
  and its only top-level key is `mcpOAuth`. There is no `claudeAiOauth`. macOS does not write a
  Linux-shaped account token and then decline to read it; **it never writes one**, so the
  file-fallback that four upstream issues ask for would have nothing to find.
- **`claude auth status` validates nothing (I-53).** A deliberately bogus `CLAUDE_CODE_OAUTH_TOKEN`
  makes it answer `loggedIn: true` on the MacBook itself. Yantra's pre-launch gate reads exactly that
  field, so **any environment-variable remedy turns a refusal that names its reason back into the
  healthy-looking useless session [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) added the
  gate to prevent.** A remedy that defeats the detector is a worse position than the blocker.

Upstream is not a plan: four issues describe this exact combination between 2025-08 and 2026-04, all
four closed by a bot and locked, **none with a maintainer reply** (R10 §8). #5957 dates the break to
the changelog line *"(Mac-only) API keys in macOS Keychain"*, so ssh-to-Mac worked before Anthropic
moved the store. This is an untriaged regression, not a macOS law — and nothing should be planned on
the assumption that it changes.

### The constraint, stated exactly

Keychain reach is not a property of a *user*, a *network path* or a *credential*. It is a property of
the **launchd session a process belongs to**, and a process inherits that from its parent at fork.
`Background` cannot read the login keychain; `gui/<uid>` can. Yantra cannot move a process between
domains from outside — `launchctl asuser` needs root, which is why I-44 could not even test the idea.

So the question is not *how does Yantra authenticate on macOS*. Yantra never authenticates: `claude`
does, against the keychain, exactly as it does on Linux against a file. The only question that
matters is **which process forks `claude`**.

### Where Yantra already stands, and it is closer than it looks

[ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) launches the agent into a tmux pane with
`respawn-pane -k` (**I-29**). A pane's process is forked by the **tmux server**, not by the ssh
session that sent the command — the ssh side is only a tmux *client* talking to a socket. `claude`
therefore inherits the *server's* launchd domain, whatever that is.

Today that server is started by whichever ssh command first needed one, so it is a `Background`
server, so every pane in it is a `Background` process, so `claude` finds a keychain it may not read.
**The domain was never chosen. It was inherited from an accident of who ran `tmux` first.**

### The guards this walks near, named before the decision rather than after

- **[ADR-0006](0006-ssh-exec-transport.md)** makes the system `ssh` binary the way a command reaches
  a machine. A transport with two answers is a transport with an ambiguity, and
  [ADR-0009](0009-machine-names-are-ssh-destinations.md) and **I-30** both depend on there being one
  answer to *where does this session live and how is it reached*.
- **R-12** and [ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) hold
  `yantra-agent` to being a reporter — deliberately, and in three places: §4 (*"the response is `204
  No Content` and will never carry instructions… a control channel is how this crate stops being a
  reporter"*), §7 (a failed POST is dropped, never queued, and the reply is read for its status and
  never acted on), and the Non-goals (*"no remote execution, configuration management, log shipping,
  software inventory or process list — each is something this agent is well placed to do and must
  not"*).
- **§B4** is absolute: Yantra holds references, never values.
- **R-23** says a confident lie is worse than nothing. A refusal that names its reason is not a lie,
  which is why *do nothing* is a real candidate below and not a placeholder.

## Decision

**Yantra does not buy the Mac at the price of an execution role.** On macOS the tmux server is
started by the user's own login session, so the panes it forks are already in `gui/<uid>`; Yantra
keeps reaching the machine the one way it always has.

### 1. The Mac's tmux server belongs to the login session, and Yantra never creates it

On macOS, a tmux server started by an ssh command is the bug. So Yantra stops being allowed to start
one there: `up` against a macOS machine **requires an existing server** and refuses when there is
none, naming the reason, instead of silently creating a `Background` server and opening a pane that
cannot authenticate.

Linux is untouched. `tmux.rs` keeps I-1's plain `new-session -d` with `duplicate session:` treated as
success — the guard is a macOS precondition in front of it, not a change to how sessions are created.

### 2. ssh keeps its monopoly, and **ADR-0006 is not amended**

This is the main reason to prefer this option, so it is stated as a decision rather than left as a
consequence. **Nothing gains a second path into a machine.** What still goes over ssh, which is
everything:

| Operation | Path | Unchanged? |
| --- | --- | --- |
| create the session (`new-session -d`, I-1) | ssh → tmux client → server socket | yes |
| launch the agent (`respawn-pane -k`, I-29, I-23) | ssh → tmux client → server socket | yes |
| the pre-launch auth gate (ADR-0011) | ssh, **through the server** on macOS — see §5 | **changed on macOS** |
| status (`claude agents --json`) | ssh | yes |
| logs (transcript JSONL) | ssh | yes |
| stop (`kill-session`, I-30) | ssh | yes |
| telemetry | `POST /heartbeat`, agent → daemon, as ADR-0013 §4 | yes |

What changes is a **precondition on the remote machine**, not a route to it. ADR-0006's sentinel
trailer, base64 payload, `ControlMaster` reuse and error taxonomy all keep their monopoly, and
ADR-0009 keeps its single answer: the workspace names an ssh destination, and that is where the
session lives.

### 3. `yantra-agent` is not touched, and stays a reporter

The launchd job that puts a tmux server in `gui/<uid>` is **not `yantra-agent`**, does not talk to
it, and does not link it: its `ProgramArguments` are tmux's. The heartbeat agent keeps having no
inbound channel, no command surface, no reply it acts on and no privileges — R-12's mitigation and
ADR-0013 §4 / §7 / Non-goals hold **unchanged and unamended**.

This is deliberate and it is the second reason to prefer this option. The alternative that Y-122's
row named — teaching `yantra-agent` to launch things — would have made the fleet's only installed
software a **remotely invokable execution service running in the owner's GUI session with keychain
reach**, which is a different security object from a process that reports seven numbers. Alternative
B below prices that out.

### 4. No credential crosses a Yantra boundary

Yantra sets no environment variable, runs no `security`, reads no keychain item, opens no
`.credentials.json`, and logs nothing about either. It does not learn whether a token exists, when it
expires, or what it is. The **only** thing this decision changes about credentials is *which process
asks the keychain for one* — and that process is `claude`, on the Mac, as it already is on Linux.
§B4 is satisfied by construction rather than by policy, and there is no design here that could be
tightened later into holding a secret, because there is no place in it where a secret would sit.

### 5. The gate moves to where the agent will run, and it may still only say *found*

This is the one piece of Rust the proposal costs, and it is load-bearing: **the ADR-0011 gate
currently runs `claude auth status` over plain ssh, which on macOS is the `Background` domain — the
wrong process.** Under this decision the pane is `gui/<uid>` while the gate is not, so the gate would
refuse launches that would have worked, and would keep answering `loggedIn: false` forever.

So on macOS the gate must run **inside the server's process tree** — a detached, short-lived window
in that server whose output the ssh session then reads back. Two invariants bound the implementation
and neither is decided here: **I-29** (a command that exits immediately must not be given to
`new-session`) and **I-34** (resolve `claude` absolutely; the PATH in that server is not a login
shell's — see §7).

That relocation also does a second job for free: the gate's answer *is* the check on the server's
domain. A `Background` server — one left over from before, or created by a race this design cannot
close — reports `loggedIn: false` and Yantra refuses, which is the honest failure and not the silent
one.

**What the gate may claim is bounded by I-53.** It reports the credential Claude Code *found*, never
that the credential *works*: an expired keychain token answers `loggedIn: true` just as a bogus
environment token does. So the gate's success means exactly *a credential was found where the agent
will run*, the UI and the CLI must not phrase it as *authenticated* or *ready to talk to Anthropic*,
and the first model request remains the only real test. What this design does **not** do is widen
I-53's blast radius: it supplies no environment credential, so the false positive R10 measured is
never introduced. Refusals stay true, and successes stay modest.

### 6. `down` must not take the server with it

**I-30** treats *no server running* as a successful teardown, because with no sessions left the tmux
server exits. On macOS that is now a regression: killing the last session kills the `gui/<uid>`
server, and the next `up` finds none. The launchd job therefore has to bring it back (§7), and the
refusal in §1 is what makes the gap visible rather than silent.

### 7. What this needs from M7, which owns install

Stated as requirements, not as a design — the plist is M7's:

1. **One launchd *user* agent**, in the per-user `gui/<uid>` domain (`~/Library/LaunchAgents`, loaded
   in the user's GUI session), `RunAtLoad`, whose job is to start a tmux server and nothing else.
2. **It must come back.** After §6 kills the last session the server is gone, so the job needs to
   restart it — `KeepAlive` on an idle session, or an equivalent — or the Mac works exactly once per
   login.
3. **Absolute paths, because a LaunchAgent's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`** — which
   finds neither Homebrew's tmux at `/opt/homebrew/bin/tmux` nor `claude` at
   `/Users/<user>/.local/bin/claude` (**I-34**, already recorded for both). Yantra resolves `claude`
   through `yantra_core::agent::CANDIDATES`; a workspace's own `startup` command does not, and every
   pane in this server inherits the job's environment rather than a login shell's.
4. **It is not `yantra-agent`** (§3), and installing it must not become a reason to give
   `yantra-agent` a second job.

### 8. The premise is untested, and the measurement that settles it cannot be made over ssh

Stated plainly because §B6 says negative and unverified findings are the valuable ones. **This whole
decision rests on one inheritance claim: a process forked by a tmux server in `gui/<uid>` is itself
in `gui/<uid>` and can read the login keychain.** That is consistent with everything I-44 measured —
`Background` membership is per-process and comes from the parent — but **it has not been measured
here**, and R10 §9 lists it as deliberately out of scope. A second, smaller premise rides with it:
that the ssh session and the GUI session share a `$TMPDIR`, and therefore a default tmux socket
(**I-37** records macOS's `TMPDIR` shape but not whether it is stable across sessions). If they do
not, the ssh client silently starts a *second* server and this design fails closed at the gate.

**Neither can be checked over ssh, and that is why nobody has**: putting a process into `gui/<uid>`
from an ssh session needs `launchctl asuser`, which needs root (I-44). It takes the owner, once, at
the Mac's own keyboard:

1. In **Terminal.app** on `bishwajeets-macbook-pro`: `tmux new-session -d -s yantra-probe`.
2. From `cachyos-g14`, over ssh: confirm `tmux ls` sees `yantra-probe` — that settles the socket —
   then have that server run `launchctl managername` and `claude auth status` in a detached window,
   writing to a file the ssh session reads back.
3. Read **only** `loggedIn` and `authMethod` from the JSON. `claude auth status` also prints the
   account email, `orgId`, `orgName` and `subscriptionType`; `agent.rs`'s `Status` names two fields
   precisely so the rest never enters this repo, and a probe must honour the same boundary. Then
   `tmux kill-session -t yantra-probe`.

The outcomes, and what each one decides:

| Result | Meaning |
| --- | --- |
| `gui/<uid>` **and** `loggedIn: true` | the premise holds; this ADR is buildable and what remains is M7's plist plus §5's gate |
| `tmux ls` cannot see `yantra-probe` | the sockets differ; §1's precondition cannot be expressed with the default socket and the design needs an explicit `-S` path before it is worth anything |
| `Background`, or `loggedIn: false` | **the premise fails, and the decision falls back to Alternative A — refuse honestly — not to Alternative B**, because B rests on the identical claim |

That last row is the point. The exec agent does not rescue this if inheritance does not work; it only
costs more to discover the same thing.

> **The probe was run on 2026-08-05 (Y-122), and the premise holds — but not by the test this section
> named.** The owner ran step 1 at the Mac's keyboard (`tmux new-session -d -s yantra-probe`, in
> Terminal.app on `bishwajeets-macbook-pro`); everything else ran from `cachyos-g14` over ssh.
>
> **The socket premise holds.** `$TMPDIR` reported inside Terminal.app and `$TMPDIR` reported in the
> ssh session were byte-identical, and `tmux ls` over ssh listed the probe session. The ssh client
> reaches the GUI session's server on the default socket, so §1's precondition needs no explicit `-S`
> path.
>
> **The inheritance premise holds, on the outcome that decides it.** Same `$HOME`, same binary, same
> machine, minutes apart: over plain ssh `claude auth status` answered `loggedIn: false` /
> `authMethod: "none"` and `security find-generic-password -s "Claude Code-credentials" -w` exited
> **36**; in a window forked by the Terminal.app-started tmux server the same two answered
> `loggedIn: true` / `authMethod: "claude.ai"` and exited **0**. And what is inherited is the
> *keychain*, not a file: `~/.claude/.credentials.json` is present on that Mac, so a `claude` that
> preferred the file would have answered `true` over ssh, which has the same `$HOME`. It answered
> `false`.
>
> **What did not survive is the discriminator, and the outcome table above is what that corrects.**
> `launchctl managername` printed **`Background`** in the ssh session *and* in a process forked by the
> GUI session's tmux server. It does not distinguish the two contexts, so nothing about keychain reach
> may be read off it — including step 2's use of it, the first row's `gui/<uid>` clause, and the third
> row, whose *`Background` … the premise fails* is the reading this measurement contradicts. Had it
> been followed, this ADR would have fallen back to Alternative A on evidence that decides nothing.
> The `loggedIn` pair is the whole test.
>
> Two clauses for whoever implements this. `tmux` is not on that Mac's non-interactive ssh `PATH`
> (**I-34** again), so §1's precondition and §5's gate must resolve it absolutely, as §7.3 already
> requires of the launchd job. And macOS has no `timeout`: the first attempt wrapped both commands in
> it and both returned exit **127** — a measurement of nothing that looked like a symmetrical result.
> The numbers above are the redone run.
>
> The probe honoured the boundary step 3 set. Only `loggedIn` and `authMethod` were read out of
> `claude auth status` — the two fields `agent.rs`'s `Status` names — so the account email, `orgId`,
> `orgName` and `subscriptionType` never left the Mac, and the keychain secret was read only as an
> exit code with its value discarded. The probe session and its scripts were removed afterwards, and
> `tmux ls` then reported no server running.
>
> **This does not change the Status, which stays `proposed`.** What it settles is upstream of the
> decision, not the decision: **Consequences → Paid**'s *"the premise is unverified until §8 is run"*
> is answered, and nothing else in that list moves. Whether the ADR is accepted is the owner's and is
> deliberately not part of the change that recorded this.

## Alternatives considered

### A. Do nothing — Yantra says *this machine cannot start an agent*, and why

**The honest baseline, and a legitimate answer.** Linux works today; the ADR-0011 gate already turns
I-44 into a refusal that names its reason, which is R-23 being obeyed rather than worked around. It
costs no code, no install story, no new failure mode and no widened attack surface.

**Why it does not win:** the fleet has two machines that are on, and this leaves one of them
permanently unable to run the thing Yantra exists to run. M5's *on the Mac* clause never closes, Q12
stays blocked, and the Mac's role shrinks to a row in a table that reports telemetry about a machine
nobody can use. It loses on value, not on honesty — and it is the fallback the moment §8's
measurement comes back negative.

### B. `yantra-agent` becomes a launchd user agent in `gui/<uid>` that Yantra launches sessions through

The candidate Y-122's row named. It would work for the same reason the chosen option works — the
agent is in `gui/<uid>`, so what it forks can read the keychain — and it fails on price:

- **It needs the control channel ADR-0013 §4 forbids by name.** Either the heartbeat's `204` starts
  carrying instructions, or a second inbound listener appears on every machine. Both are the drift
  R-12 exists to prevent, and §4's sentence — *"a reply the agent acts on is a control channel"* —
  was written about exactly this.
- **It needs an authoriser that does not exist.** ADR-0013 §6 accepted an unauthenticated write
  *specifically because* a heartbeat is "data for a score, never a path, command or filename, so
  nothing in it reaches the layer where ADR-0006 turns a string into a remote shell command". An exec
  endpoint is that layer. The tailnet is not a set of trusted servers — it holds a phone, a tablet
  and peers with expired keys still in the netmap (R1) — so the agent would need its own identity
  check, on three operating systems, via a LocalAPI that ADR-0013 §5 deliberately avoided speaking;
  and Y-118 has the forwarded-identity hole open in the daemon's version of that check already.
- **It re-implements ADR-0006's hard-won semantics.** Exit status that survives a signal, quoting
  that survives a newline, transport failure distinguishable from command failure — a second exec
  path either reproduces all of it or is quietly worse.
- **It splits the transport asymmetrically.** Start through the agent, stop/log/status over ssh: two
  answers to *how is this machine reached*, and ADR-0009 and I-30 both assume one.
- **The resulting object is not a reporter.** A network-reachable process, in the owner's GUI
  session, with keychain reach and the ability to run commands, is the fleet-management product this
  project is named for not being.

And it buys nothing the chosen option does not, since both rest on §8's single untested premise.

### C. `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`

The only external path that keeps the subscription (R10 §6 corrects the widely repeated claim that it
switches billing — on 2.1.220 it does not). **Disqualified by §B4**: the docs say the token *"is not
saved anywhere"*, so the only place to put it is an environment variable Yantra sets on every launch
— a one-year secret *value* in the launch path. It is also the worst kind of fix, because I-53 makes
the gate report health for it whether or not it works (§Context).

### D. `apiKeyHelper`

The only mechanism in R10 with the *shape* §B4 asks for: a reference that fetches a secret rather
than a stored value. It loses on the thing it was supposed to fix — **the helper runs in `claude`'s
own process tree, in the same `Background` domain**, so anything it reaches for in the keychain fails
identically (R10 §5). The docs also group its output with the API-key credentials, and whether a
subscription OAuth token authenticates through it is undocumented and untested.

### E. `security unlock-keychain`, or `sudo launchctl asuser`

The first needs a password: refused by §B4 and by I-44, and it is the only remedy Anthropic's own
troubleshooting page offers. The second needs root, and a sudoers rule that lets a network-reachable
path enter the GUI session is a privilege grant, not a fix.

### F. `--bare`, or `ANTHROPIC_API_KEY`

Anthropic's supported no-keychain mode, and it states its own price: bare mode *"skips OAuth and the
system keychain"* and takes `ANTHROPIC_API_KEY` or `apiKeyHelper` only. **The supported way to avoid
the keychain is to stop using the subscription** — API billing, plus a secret value, so §B4 refuses
it twice.

### G. Wait for upstream, or copy Linux's `.credentials.json` to the Mac

Four issues, a year apart, all bot-closed and locked with no maintainer reply (R10 §8). And the copy
does not work even in principle: macOS never writes `claudeAiOauth` and there is no documented reader
for one (R10 §2.1).

## Consequences

**Gained**

- **ADR-0006 keeps its monopoly and needs no amendment.** One transport, one answer to where a
  session lives, ADR-0009 and I-30 undisturbed.
- **`yantra-agent` stays a reporter**, R-12's mitigation intact and ADR-0013 unamended, in the one
  change that had the strongest excuse to grow it.
- **No secret exists anywhere in the design** — nothing to hold, rotate, leak or log, and no place
  a future change could put one.
- **The failure mode is a refusal that names its reason**, not a session that looks healthy (R-23,
  I-53).
- Most of the cost is a plist and a precondition, not orchestration code.

**Paid**

- **Yantra depends on a state it cannot establish.** If nobody is logged in on the Mac — after a
  reboot, at the login window — there is no `gui/<uid>` session, no server, and the machine is
  unusable until a human logs in. Yantra can only say so.
- **A `Background` server is indistinguishable at the socket**, so §5's gate is the only detector and
  the check must live where the agent will run rather than where it is convenient.
- **Panes inherit the launchd job's environment, not a login shell's** — I-34's shape again, and this
  time it reaches the *user's* `startup` command, which Yantra does not resolve for them.
- **macOS gains a code path Linux does not have** (the §1 precondition and the §5 gate location),
  which is a small violation of *one code path, forever* bought knowingly to avoid a second
  transport.
- **The premise is unverified** until §8 is run, and the fallback if it fails is Alternative A.
- The tmux server becomes long-lived and shared, so a workspace's session sits in the same server as
  whatever else the owner runs there. That is already true on Linux; it becomes load-bearing here.

**Not decided here**

- **The launchd plist itself** — M7 owns install, and §7 lists what it must produce.
- **Whether the macOS precondition is checked per machine or per `up`**, and where the check lives.
- **The exact mechanism for running the gate inside the server** (§5): implementation, bounded by
  I-29 and I-34.
- **Windows** — R10 §2 records that credentials there are a file under `%USERPROFILE%`, so Q4 does
  not inherit this problem; it inherits its own.
- **A second agent CLI.** The one-agent-first guardrail holds, and nothing here generalises to a tool
  that keeps credentials somewhere else.
