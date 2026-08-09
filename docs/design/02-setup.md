# D2 — Setting a machine up

**Status:** proposed. Written 2026-08-09 from the owner's spec. Opens no rows (§B0) — §7 proposes
them and the owner mints them. **The owner ruled §6's scope question on 2026-08-09** and opened
[Y-160](../../tracker.md#3-task-board) beside Y-157; the DNS blocker on D2.8 was mine and is
withdrawn. **[Y-163](../../tracker.md#3-task-board) is D2.1 and D2.2**, minted 2026-08-09.

Companion to **[D1 — The dashboard you work in](01-dashboard.md)**. Both read the same probe (§3).

---

## 0. The principle

> *we try to take as much as stuff from them as possible. we are only responsible of handing off
> only if we can't handle it and needs manual intervention* — owner, 2026-08-09

**Yantra does everything it can do. Where it genuinely cannot, it names the step, says why, and
hands over the exact command.** A manual step is a *refusal with a reason*, never an omission.

The test for any install path: **a reader who does nothing but follow it ends with a working
machine, or with a numbered list of things only they can do.** Never a gap they have to notice.

---

## 1. This overrules what is written today

[`docs/appliance.md`](../appliance.md) states the opposite policy:

> *"The recipe copies binaries and units. It creates no accounts, writes no configuration and enrols
> nothing."*

and then lists six things a person must do by hand first: enrol Tailscale, create the `yantra`
system account, provide an ssh account that can `sudo`, write `/etc/yantra/agent.env`, place the
appliance's own ssh identity (Y-144, still open), and `scp` workspace TOMLs in. Ten steps, three of
them file-editing.

Each refusal had a written reason —
[ADR-0013 §4](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md) for `agent.env`, Y-144
for the ssh identity — and **"deliberate" and "consistent with the founding principle" are different
claims**. [`brainstorm.md:394`](../brainstorm.md) says *"No YAML editing. No configuration files.
Configuration files are implementation details."* The dashboard honours that for workspaces and the
install path violates it completely.

**The distinction that resolves the conflict without discarding those reasons:**

> **The installer provisions. The updater does not touch configuration.**

ADR-0013 §4 constrains the *update* recipe, which must be safe to re-run against a live box. An
interactive installer that asks for the daemon address once and writes `agent.env` is a different
program with a different contract. Both statements stay true, and `docs/appliance.md` gains a section
rather than losing one.

---

## 2. The handoff boundary

| | Yantra does it | Yantra prepares it, you finish | Only you |
| --- | --- | --- | --- |
| **Tailscale** | `tailscale up` with a key supplied out of band | prints the exact `tailscale up --authkey …` when it cannot run it | ACLs, tags, key-expiry policy, the admin console (**Q17**) |
| **ssh** | generates the keypair, writes `~/.ssh/config` and `known_hosts` | **prints the public key to place** | placing it in `authorized_keys` on each machine |
| **`yantra` account** | `useradd --system --create-home …`, directories, permissions | — | — |
| **daemon config** | writes `/etc/yantra/agent.env` from one interactive prompt | — | — |
| **provider CLI** | detects `gh` / `glab`, reports auth state | prints `gh auth login` or `glab auth login --hostname <host>` | the browser login itself |
| **systemd + ports** | installs units, `enable --now`, checks the port is listening | — | — |
| **terminfo** | runs `yantra fix-terminfo` | — | — |
| **workspaces** | created from the dashboard, never `scp`'d | — | — |

**The ssh row is split deliberately.** The owner said ssh keys are theirs. Generating a keypair
locally is zero-risk and saves a step; only *distributing* the public key is genuinely theirs. If
even generation should be manual, this table is where that changes.

**Secrets never enter this path.** §B4 is unconditional: the Tailscale auth key is read from a prompt
or the environment and never written to a file Yantra owns, never logged, never echoed, and never
put in a command line visible to other local users. A provider token is never read at all — Yantra
runs `gh` or `glab` *as* the user and lets their credential helper answer.

---

## 3. One probe, four consumers

The owner wants two install paths:

> *the user can either do one click install via yantra or let their agent handle it*

**These do not need two implementations.** Both consume the same reading:

```
yantra doctor            human-readable: what is missing, and why it matters
yantra doctor --json     a machine-readable work list
```

| Consumer | Uses it as |
| --- | --- |
| the dashboard | readiness cards on `/` and `/m/{machine}` (D1 §1) |
| the installer | the list of things to fix, in order |
| an agent | its task list — *fix what this lists, re-run until clean* |
| the reconcile screen | the "is this machine even usable" precondition (D1 §3) |

This is the same reading [R13 §6](../research/13-dashboard-revamp-and-github.md) proposed after
measuring five facts by hand that a probe would have surfaced. **It is the first thing to build**:
four separate pieces of work want it.

### 3.1 What `doctor` checks per machine

| Check | Command | Why it matters |
| --- | --- | --- |
| reachable | `ssh -o BatchMode=yes <m> true` | everything else depends on it |
| sshd present | the same, distinguishing refusal from timeout | `cachyos-g14` has none `[V]`, so it cannot be a clone target |
| tmux | `agent.rs::CANDIDATES` lookup | ADR-0011 needs it |
| the agent CLI | the same lookup per agent | a missing `claude` is a silent placement failure (I-34) |
| terminfo | `terminfo.rs` | the browser terminal is unusable without it (D1 §4.5) |
| provider CLI | `gh --version`, `glab --version` | browsing repositories needs one (D1 §5.2) |
| provider auth | `gh auth status`, `glab auth status` | the Mac has neither `gh` nor a registered key `[V]` |
| login session | ADR-0018's gate | macOS only; `/rc` and `claude` both need it (I-44) |
| heartbeat | last beat age | the agent unit is running |

Each result is **present / absent / unknown**, and *unknown* is never rendered as *absent* — the same
three-state honesty the dashboard already keeps for readings (D1 §2).

**2026-08-09, [Y-163](../../tracker.md#3-task-board), built:** the check names are
`reachable`, `sshd`, `tmux`, `agent-cli`, `terminfo`, `provider-cli`, `provider-auth`,
`login-session`, `heartbeat`, in that order, and the list is reported whole even for a machine that
answered nothing. Two clauses of this table are narrower than they read.
**`heartbeat` answers *unknown* from the CLI** and from anything else that is not the daemon: the
beats live in `yantrad`'s memory and nothing persists them (Y-044), while ADR-0012 keeps the CLI a
caller of the library rather than a client of the daemon — so the caller that can answer it is the
one D2.3 puts the cards in. And **`login-session` is both halves of ADR-0018**: §1's *is there a
server a login session started*, asked with `list-sessions` so none is created, and then §5's gate
inside it — on Linux the same question asked directly, since the credential is a file that ssh
session can read.

### 3.2 What it must not do

`doctor` is a **read**. It changes nothing, installs nothing, and logs no credential. `yantra doctor
--fix` — if it ever exists — is a separate verb with a separate confirmation.

---

## 4. The one-click path

```
curl -fsSL https://<host>/install.sh | sh
```

Interactive, step by step, and **it must survive being run twice** (§B4 idempotency). Order:

1. **Verify itself** — checksum against the release's `SHA256SUMS`, which
   [`.github/workflows/release.yml`](../../.github/workflows/release.yml) already produces and
   verifies. Y-156 must land first: nothing has ever been published, and the workspace is `0.0.0`.
2. **Detect the platform** and fetch the right static musl binary.
3. **Run `doctor`** and show what is missing.
4. **Fix what it may** (§2 column 1), asking before each.
5. **Print what it may not** (§2 columns 2–3) as a numbered list with exact commands.
6. **Re-run `doctor`** and either declare the machine ready or restate what remains.

**The one file it must never overwrite** is an existing `/etc/yantra/agent.env` or an existing
workspace TOML. Scaffold when absent, leave alone when present, and say which it did.

**2026-08-09, [Y-160](../../tracker.md#3-task-board), built:** steps 1–2 are
[`install.sh`](../../install.sh) and steps 3–5 are [`provision.sh`](../../provision.sh) beside it.
Four clauses above turned out narrower than they read. **Nothing asks before each fix**, because
piping to a shell makes stdin the script — so the two fixes are the ones safe to make unasked
(`systemctl enable --now` for a unit whose precondition holds, and `fix-terminfo`, which writes to a
`~/.terminfo` and wants no root), and everything else is printed. **`agent.env` is never written**:
`install.sh` always scaffolds it, so *leave alone when present* leaves nothing for step 4 to do, and
the address is named as a command instead. **Step 6's re-run of `doctor` is not there** — the only
fix that changes an answer is `fix-terminfo`, whose own exit status is the same evidence a re-read
would collect, and a second sweep costs an ssh round trip per machine to learn it twice. And
**`doctor`'s exit status is unreadable to this consumer**, since §3.1's `heartbeat` is never
*present* from a caller that is not the daemon; the checks are read from `--json` instead, and that
one is reported as the standing non-answer it is rather than as work.

---

## 5. The agent path

Almost free once §3 exists: ship a fragment that says *run `yantra doctor --json`, fix what it
lists, re-run until clean, and stop at anything the boundary table marks as the owner's.* Claude Code
already does that shape well.

**The agent must be told the boundary**, not just the task list — an agent that helpfully edits a
Tailscale ACL or generates and distributes an ssh key has crossed a line the owner drew.

---

## 6. What blocks this

| Blocker | Effect |
| --- | --- |
| **Y-156 — nothing has ever been published** | there is no artifact for an installer to fetch and no version to name. The release workflow exists and was rehearsed green; what is missing is a tag and a version. |
| **Q17 answered** | *tagged*, recorded 2026-08-09 — but **Y-143 is a condition on it, not a follow-up**. The hazard it names is read from the code and never measured, and if a tagged node turns out to refuse every write, the enrolment step is written against a different answer. |
| **Q15 answered** | the Pi 5, 2 GB, ruled 2026-08-09. It never blocked this — it blocks M8 and M9. |
| **Y-144 open** | the appliance has no ssh identity of its own; §2 row 2 is the design for creating one. |

### The scope question, ruled 2026-08-09

**Y-157 is narrower than §4, and it stays that way.** The owner's ruling is **beside, not wider**:
[Y-160](../../tracker.md#3-task-board) carries the provisioning half and Y-157 keeps its original
text.

**The seam is testability, not taste.** Y-157 is exactly the part
[Y-158](../../tracker.md#3-task-board) can prove against a real systemd as PID 1 in a disposable
podman container (§B3, Q19). Enrolling a real Tailscale, logging into `gh`, generating a keypair —
none of that is provable that way. Fold them together and Y-158 loses its subject.

---

## 7. Work units

Sized to be picked up one at a time. **Proposed, not opened** (§B0).

### Blocked on nothing

| # | Work | Done when | Touches |
| --- | --- | --- | --- |
| **D2.1** | `yantra doctor` — the checks in §3.1, human-readable | ✅ **[Y-163](../../tracker.md#3-task-board)**, 2026-08-09 — run against the real fleet, and against a real sshd in a container for each state | `crates/yantra-core/src/doctor.rs`, `crates/yantra/src/main.rs` |
| **D2.2** | `yantra doctor --json` and its schema | ✅ **[Y-163](../../tracker.md#3-task-board)**, 2026-08-09 — pinned by a test in the CLI, where the bytes a consumer reads are produced. `yantrad` serves none of it yet: that is D2.3's, and it reads the same types | as above |
| **D2.3** | Readiness cards on `/` and `/m/{machine}` | ✅ **[Y-168](../../tracker.md#3-task-board)**, 2026-08-09 — `GET /api/readiness` and `GET /api/machines/{name}/readiness` off the daemon's own sweep, answering `heartbeat` from the beats it holds, and a card on each route drawing every §3.1 check. The card overrules that one answer against the machines reading, because a check is a verdict where an age is not | `crates/yantrad/src/api.rs`, `web/src/components/Readiness.tsx` |
| **D2.4** | The agent fragment (§5) | an agent given only it and a bare machine reaches "ready" or stops at a boundary row | a skill or `AGENTS.md` fragment |
| **D2.5** | Rewrite [`docs/appliance.md`](../appliance.md) around §0–§2 | the six manual prerequisites become the boundary table; the installer/updater distinction is stated | `docs/appliance.md` |

### Blocked on a release

| # | Work | Blocked on |
| --- | --- | --- |
| **D2.6** | `install.sh` — §4 steps 1–6 | **Y-156**: a tag, a version, and a published artifact to fetch |
| **D2.7** | Run it against a real systemd | D2.6 |
| **D2.8** | Host it on a name that resolves off the tailnet | D2.6 alone. The host is the landing site, which [`landing.yml`](../../.github/workflows/landing.yml) already deploys publicly; the dashboard's own name stays on `.ts.net` (ruled 2026-08-09), and the two were never the same problem. |

### Blocked on a decision

| # | Work | Blocked on |
| --- | --- | --- |
| **D2.9** | The Tailscale enrolment step | **Y-143** — Q17 is answered *tagged*, and the measurement it is conditional on decides what the `tailscale up` line says |
| **D2.10** | Generate the appliance's ssh identity and print its public key | **Y-144**, and confirmation that generation is Yantra's rather than the owner's (§2) |

**Y-156…Y-159 already exist** and cover publishing, an installer, exercising it against systemd, and
hosting it. D2.6–D2.8 are those rows seen through this document. **[Y-160](../../tracker.md#3-task-board)
is D2.1's consumer** — the §4 steps Y-157 deliberately leaves out — and shipped 2026-08-09 as
[`provision.sh`](../../provision.sh); what it does rather than prints, and why, is the note in §4.
D2.9 and D2.10 are untouched by it: it prints both of those steps and performs neither.

---

## Sources

**Yantra internal**, read 2026-08-09 — [`docs/appliance.md`](../appliance.md) *What the box needs
before the first install*; [`docs/brainstorm.md`](../brainstorm.md) line 394;
[`.github/workflows/release.yml`](../../.github/workflows/release.yml);
[`crates/yantra-agent/src/probes.rs`](../../crates/yantra-agent/src/probes.rs);
[`crates/yantra-core/src/agent.rs`](../../crates/yantra-core/src/agent.rs) `CANDIDATES`;
[`crates/yantra-core/src/terminfo.rs`](../../crates/yantra-core/src/terminfo.rs);
[R13 §2.6, §6](../research/13-dashboard-revamp-and-github.md);
[ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md) §4;
[ADR-0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md); `tracker.md` rows Y-144,
Y-156–Y-159 and questions Q15, Q17; invariants I-34, I-44.

**`[V]` — measured 2026-08-08 and 2026-08-09**, recorded in full in
[R13](../research/13-dashboard-revamp-and-github.md) and [D1](01-dashboard.md): `cachyos-g14` has no
sshd; the Mac has no `gh` and an ssh key not registered with the account; `gh` 2.96.0 and `glab`
1.109.0 are present on `cachyos-g14`, `tea` is not.

**One of those is no longer true, measured 2026-08-09 by `yantra doctor` itself
([Y-163](../../tracker.md#3-task-board)):** the Mac **has** `gh`, in `/opt/homebrew/bin`, and it
finds no credential there — so what §3.1's `provider CLI` row cites the Mac for is now the
`provider auth` row's. `cachyos-g14` still refuses the connection, which is the same run's evidence
for the `sshd` row.
