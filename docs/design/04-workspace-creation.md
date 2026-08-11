# D4 — Creating a workspace

**Status:** proposed. Written 2026-08-11 from the owner's instruction of the same day — *"less
filling, more selecting"* — and settled in a four-question interview whose answers are recorded
inline. Opens no rows (§B0); §8 proposes them and the owner mints them.

**Read [D3](03-dashboard-surface.md) §14 first.** It gives `/new` its route and says the form
*"selects with `ui/select` and `ui/combobox` and confirms the directory through `yantra probe`
(Y-184)"*. [Y-185](../../tracker.md#3-task-board) is that row, and its page half landed in M13. This
document settles the half that is left, and **one measurement changes the shape of it.**

---

## 0. What this settles, and what it does not

**It settles how a directory becomes a choice.** What Yantra asks a machine, how often, what it does
with an answer it could not get, and what the form fills in for you.

**It does not settle pigment or type** — D3 §0's split holds unchanged, and every rule here is
written against tokens.

**It does not touch `POST /api/workspaces`.** The daemon's create route, its refusals and
`workspace::validate_name` are Y-126's and stay exactly as they are. Everything here happens
*before* the file is written.

---

## 1. What is wrong today

[`NewWorkspace.tsx`](../../web/src/components/NewWorkspace.tsx) is three free-text fields and one
optional fourth. It checks none of them against the machine they name.

| Field | Today | What goes wrong |
| --- | --- | --- |
| Name | free text | a name the daemon refuses is found by the 400 |
| Machine | a `select` — **already right** | — |
| Repo | free text, with *"Nothing here checks it"* written under it | **`up` discovers the path was wrong, after the workspace exists** |
| Startup | free text | accepts anything; ADR-0011 ships one agent |

The Repo row is the one that costs something. A typo produces a workspace file that looks fine,
lists fine, and fails at the moment you most want it to work — and the failure surfaces as an `up`
that could not `cd`, which reads like a machine problem rather than a spelling one.

---

## 2. The measurement that changes the design

The obvious answer is a **sweep**: run `find -maxdepth N -name .git` over ssh and offer what comes
back. It was measured on 2026-08-11 and **it does not work.**

Measured against `bishwajeets-macbook-pro`, the one machine on this fleet that answers ssh today
(`cachyos-g14` refuses on port 22 — R13 §5), and against this Linux box for contrast.

| What | Mac, over ssh | This box, local |
| --- | --- | --- |
| bare ssh round trip | **0.33 s** | — |
| `probe` as it ships today (`test -d` + `git remote`) | **0.28 s** | — |
| **one level of `$HOME`, entries marked as repos** | **0.23 s**, 15 entries | — |
| `find $HOME -maxdepth 3 -name .git` | 1.54 s | — |
| `find $HOME -maxdepth 4 -name .git` | **8.60 s**, 12,157 dirs | **0.026 s**, 3,933 dirs |
| the same, run again warm | **8.54 s** | — |
| the same, `Library`/`node_modules`/`.Trash` pruned | **7.33 s** | — |
| `find $HOME -maxdepth 5 -name .git` | **11.86 s** | 0.42 s |

**Three things follow, and each of them is a decision.**

**A whole-home sweep costs eight to twelve seconds with a person watching.** That is not a cold
cache — the warm run is 8.54 s — and it is not one tarpit: pruning `Library`, which holds 8,583 of
the 12,157 directories, buys back only 1.3 s. The cost is per-directory and it is macOS's, at
roughly 0.7 ms against this Linux box's 0.007 ms for the same work. **A design that is fine on the
developer's own machine is unusable on the fleet's other one**, which is the failure mode §B3 exists
to catch and the reason this was measured rather than assumed.

**Shallow and scoped is thirty times cheaper than deep and open, and it is the same price as the
probe already accepted.** One level with the git marker is 0.23 s against `probe`'s 0.28 s. ADR-0019
settled that a person may wait for a probe; anything at that price inherits the ruling.

**So the verb walks, it does not search.** One directory at a time, each step the cost of a probe.
That is also the better interface: a search returns a flat list of paths you must still read, and a
walk shows you where you are.

---

## 3. The verb

**`yantra ls dirs <machine> [path]`** — lists one level, and says which entries are git repositories.

`ls` because the CLI already has `yantra ls machines` and `yantra ls sessions`, and this is the same
question asked of a third thing. `path` defaults to the machine's `$HOME`; the daemon never composes
one, and a relative path is the caller's error rather than something to resolve.

**One round trip, for `probe`'s reason.** Whether an entry is a repository, and what origin it
holds, only matter for entries you are being shown right now, and a person is waiting on all of it.
The command is one loop, and its shape is
[`probe.rs`](../../crates/yantra-core/src/probe.rs)'s widened by one level:

```sh
for d in "$PATH"/*/; do
  [ -d "$d" ] || continue
  if [ -d "$d/.git" ]; then
    printf '%s\trepo\t%s\n' "$d" "$(git -C "$d" remote get-url origin 2>/dev/null)"
  else
    printf '%s\tdir\t\n' "$d"
  fi
done
```

`git`'s own failure is swallowed exactly as `probe` swallows it: *not a repository* and *a repository
with no origin* are both "no origin here", and neither is a reason to fail a listing.

**It is a `POST`**, on [ADR-0019](../adr/0019-a-probe-that-asks-a-machine-is-a-post.md)'s precedent
and for its reasons unchanged. The answer depends on a path nobody typed until now, so the snapshot
is structurally unable to hold it; and `crates/yantrad/CLAUDE.md`'s *never `await` ssh inside a
handler* is not being softened, it is the write exception that already exists being used a fourth
time. **The ADR needs no amendment** — it classified the case, and this is the case.

### 3.1 What it does not do

- **It does not recurse.** §2 is the whole reason.
- **It does not cache.** The daemon persists nothing (Y-044), and a directory listing is exactly the
  kind of thing that is wrong the moment it is stale.
- **It does not list files.** A workspace names a directory.
- **It does not hide dotfiles**, but it does not go looking for them either: `*/` skips them, which
  is the shell's own default and means `~/.config` is reached by typing it. Say so rather than
  leaving a reader to wonder where their directory went.

---

## 4. The page

Four things, in the order a person decides them.

```
Machine     cachyos-g14 ▾

Directory   ~/Github/homelab/                                   ↑ up
            ─────────────────────────────────────────────────────────
            ▸ yantra              github.com/2002Bishwajeet/yantra
            ▸ landing             github.com/2002Bishwajeet/landing
              scratch             not a repository
            ─────────────────────────────────────────────────────────
            or type a path                     [                    ]

Name        yantra                                    ← filled in, editable

Opens with  ( ) claude     ( ) a plain shell     ( ) other…

                                                  [ Create workspace ]
```

### 4.1 Machine first, and it is already right

The existing `select` offers every machine including the asleep ones, because ADR-0009 says Yantra
never resolves a machine and an asleep one is a legitimate target. **Keep it.** It becomes
`ui/select` for §7.4's reason — a hand-rolled control loses its focus ring when the tokens change —
and for no other.

Changing the machine clears the directory. A path is a fact about one machine.

### 4.2 The directory is walked

Each step is one `POST` and about 0.3 s. A repository is offered as a destination and a plain
directory as somewhere to go; both are also somewhere to go, because a repository can hold another.

**Typing stays.** `⌕` filters what is listed, and a full path typed into the box is taken as one and
probed directly — a machine with 109 entries at `$HOME` is a real case, measured, and scrolling it
is worse than typing four characters. This is `ui/combobox`'s job and is why D3 §14 named it.

**Where it starts.** `$HOME`, because that is the only directory Yantra can name without asking. Any
memory of where you were last would be daemon state, and the daemon persists nothing.

### 4.3 The name is derived

From the chosen directory's basename, or from the repository name in `origin` where the probe found
one. **It stays editable**, and editing it stops it tracking the directory — a field that keeps
overwriting what you typed is worse than one you have to fill.

`workspace::validate_name` still decides. A derived name that it would refuse is said before the
button rather than by the 400: this is a rule the CLI already owns, restated in the browser for the
same reason `USABLE_NAME` is restated in `columns.tsx` — *a command someone pastes must not depend on
the daemon's promise*.

### 4.4 Startup is a choice with an escape

**claude · a plain shell · other…** ADR-0011 has one `Agent` variant and D1 §4.2 records that the
owner wants Codex and others; this renders the guardrail rather than relaxing it, and the third
option is a text field so nothing that works today stops working.

The secrets sentence stays word for word. It is the only place in the interface that says Yantra
never holds a value, and §B4 is why.

---

## 5. What refuses, and what only says

**The owner's decision, 2026-08-11:** *only a proven absence blocks.*

| The probe says | The button |
| --- | --- |
| the directory is there | allowed |
| **the directory is not there** | **blocked**, naming the machine and the path |
| the machine could not be asked | **allowed**, and the row says it is unchecked |

This is R-23's own shape one layer out. *Absent* and *unknown* are different answers and only one of
them is a reason to stop — and stopping on the other would mean you cannot set up a workspace for a
laptop that is shut, which is a thing the owner does.

**Not a repository is not a refusal.** The probe answers `origin`, so a directory without one is
named beside the field — *"not a git repository — fine, if that is what you meant"* — and blocks
nothing. A workspace is a directory and a command; git is a convention it usually follows.

**The cost of blocking, stated.** A machine that answers ssh and truthfully reports *not there* will
block a create that a person may have wanted anyway — a directory they are about to `mkdir`. They
must create it first. That is the price of the row saying *confirmed present before the file is
written*, and it is worth naming because it is the one case where this design is more work than the
form it replaces.

---

## 6. Words

D3 §8 binds this page too. Two that matter here:

- **A refusal names what would change it.** *"cachyos-g14 has no directory at /home/you/thing. Make
  it there, or choose another."*
- **An unchecked answer says what it could not do, not what is wrong.** *"cachyos-g14 could not be
  asked, so this path is unchecked. It will be tried when the workspace is opened."*

*Directory*, not *repo*, everywhere in the interface. The field is a directory that is usually a
repository, and D3 §8's one-word-one-meaning rule is what makes the *not a repository* note
readable rather than contradictory.

---

## 7. What this needs that does not exist

[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md): *anything the web UI can do must be
expressible in `yantra` first.*

| Need | § | CLI first | Decision needed |
| --- | --- | --- | --- |
| list one level of a machine's filesystem | 3 | **new** — `yantra ls dirs` | none. ADR-0019 already classified it |
| `POST /api/machines/{machine}/dirs` | 3 | the verb above | none |
| the page | 4 | — | none |

**No new ADR.** ADR-0019 decided that a question which must ask a machine on demand is a `POST`
inside the write exception; §2 shows this one costs what the probe costs. If it had needed a sweep,
it would have needed an ADR, because eight seconds inside a handler is a different decision from
0.3 s — and that is worth writing down as the reason there is no ADR here.

### 7.1 The path reaches a shell, and that is not new

The listing interpolates a caller-supplied path into a shell command, exactly as `probe` does, and
it is quoted the same way — [`tmux::sq`](../../crates/yantra-core/src/tmux.rs). **The tests are the
quoting**, which is this crate's convention: a path holding a quote, a `$`, a backtick and a newline
must come back as that path or as nothing.

**I-63 is next to this and is not solved by it.** The *machine* name reaches `ssh`'s argv unguarded,
so a name beginning with `-` is read as an option; that is shared with `probe` and with the
readiness re-check, and it predates all three. This route adds a caller to it and no new exposure.
The caller is an owner node the tailnet identified either way (ADR-0016).

---

## 8. Work units

Sized to be taken one at a time. **Proposed, not opened** (§B0).

| # | Work | Done when |
| --- | --- | --- |
| **D4.1** | `yantra ls dirs <machine> [path]` (§3) | one level listed, repositories marked with their origin, one round trip, and a path holding a quote or a newline comes back whole or not at all |
| **D4.2** | `POST /api/machines/{machine}/dirs` (§3) | it answers the verb's shape, sits on `allowed()`, and a machine that cannot be reached is a 503 naming the ssh chain rather than an empty list |
| **D4.3** | The directory is walked, not typed (§4.2) | each step is one request, typing filters, a full path typed is probed directly, and changing the machine clears it |
| **D4.4** | Only a proven absence blocks (§5) | the three rows of §5's table, each asserted |
| **D4.5** | The name is derived and stays editable (§4.3) | it follows the directory until you touch it, and a name `validate_name` would refuse is said before the button |
| **D4.6** | Startup is a choice with an escape (§4.4) | claude, a plain shell, and a command; the secrets sentence unchanged |
| **D4.7** | The machine picker becomes `ui/select` (§4.1) | no hand-rolled control left in the form, and an asleep machine is still offered |

**D4.1 and D4.2 come first**, and the page is worth nothing without them.

**One thing is worth doing before any of it:** run §2's measurements against `cachyos-g14` once it
answers ssh. Every number here is from one macOS laptop and one Linux desktop, and the design turns
on a ratio between them.

---

## Sources

Measured **2026-08-11** on branch `m13-dashboard-surface`, against `bishwajeets-macbook-pro` over a
real ssh hop from `cachyos-g14`, and against `cachyos-g14`'s local filesystem for contrast.
`cachyos-g14` refuses ssh on port 22, so **no number here was taken over ssh to a Linux machine** —
the Mac's per-directory cost may not be representative, and §8 says to re-measure.

- Bare ssh round trip 0.33 s; `probe` as shipped 0.28 s; one level with the git marker 0.23 s over
  15 entries.
- `find $HOME -maxdepth 4 -type d -name .git`: 8.60 s cold and 8.54 s warm over 12,157 directories
  on the Mac, against 0.026 s over 3,933 directories locally. At `-maxdepth 5`, 11.86 s against
  0.42 s.
- Pruning `Library`, `node_modules` and `.Trash` at depth 4: 7.33 s. `Library` alone holds 8,583 of
  the 12,157 directories and costs 2.06 s of the total.
- `$HOME` holds 109 entries at one level on the Mac.

**Decisions** — four taken by the owner on 2026-08-11, in a structured interview: the listing verb
over a probe-on-submit, blocking only a proven absence, deriving the name, and making startup a
choice. Each is recorded at the section it governs, with its cost.

**Yantra internal** — [D1](01-dashboard.md) §3.3, §4.2; [D3](03-dashboard-surface.md) §3, §8, §14;
[R13](../research/13-dashboard-revamp-and-github.md) §5; ADRs
[0009](../adr/0009-machine-names-are-ssh-destinations.md),
[0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
[0019](../adr/0019-a-probe-that-asks-a-machine-is-a-post.md);
[`probe.rs`](../../crates/yantra-core/src/probe.rs); R-23; I-63; Y-126, Y-184, Y-185.
