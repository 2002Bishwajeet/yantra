# R13 — Everything from the dashboard, and the credential a `git clone` needs

**Question.** The owner asks for three things: a dashboard that does everything rather than the CLI
doing it, Git-provider integration starting with GitHub that *"also clones to the machines that I
want"*, and a *"remote coding agent or ssh terminal"* started from that UI. What of this already
exists, what collides with a decision this repo has already taken, and what does GitHub actually
offer a **tailnet-only tool with no public ingress**?

**Short answer.** Two of the three are largely built and one of them is blocked on a decision nobody
has taken. The remote agent is [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) and
shipped; the browser terminal is M6 and shipped; the *router* the spec implies is cheaper than the
code says it is, because the reason written down for not having one has since stopped being true.
The clone is the hard one, and not for the reason it looks like: **GitHub's better-designed
authentication is the one this daemon cannot hold**, and the only mechanism that satisfies
[§B4](../../CLAUDE.md) without a superseding ADR is the one where **Yantra never sees a token at
all** — verified working on this machine below.

Accessed **2026-08-08**. Re-verify anything version-sensitive before relying on it — §B6. This note
proposes and opens no tracker rows (§B0).

---

## Bottom line

1. **This is not a new requirement.** [`docs/brainstorm.md:394-404`](../brainstorm.md) already says
   *"Everything should be configurable from the interface. No YAML editing. No configuration files.
   Configuration files are implementation details. The interface should generate them
   automatically."* The dashboard honours that for **workspaces** and violates it completely for
   **setup**. §1 measures both halves separately.
2. **GitHub integration is a stretch goal being promoted.** It sits at
   [`brainstorm.md:535`](../brainstorm.md) under *Future Possibilities* and at
   [`docs/vision.md:270`](../vision.md) under *Stretch Goals*. It is in no milestone M0–M10. Promoting
   it changes scope, and that is the owner's call, not an oversight to be corrected.
3. **The sharpest conflict is persistence, and it inverts the usual security advice.** A GitHub App
   issues an 8-hour user token with a 6-month refresh token; an OAuth App issues a token with no
   expiry and no refresh token. The App is the better security object and is **the one a daemon that
   persists nothing cannot use**. §2.1.
4. **The credential does not have to enter Yantra.** `gh` is already installed, already logged in,
   and already registered as git's credential helper on this machine — measured in §2.2. A private
   clone over ssh needs no token from the daemon. That is the only option that is §B4-clean by
   construction rather than by policy.
5. **The single most important thing nobody has tested** is whether that holds on the Mac. If `gh`
   keeps its token in the login keychain there, `ssh mac 'git clone …'` fails for exactly the reason
   **I-44** documents for Claude Code, and the whole clean path has a hole in it on one of the two
   machines that are on. §2.6. **Unverified — and cheap to test.**

---

## 1. Ground truth — and "barebones" is half right

### 1a. What exists, read from the code

| Surface | Where | What it is |
| --- | --- | --- |
| The page | [`web/src/App.tsx`](../../web/src/App.tsx), 259 lines | One `<main>`, five fixed sections, a conditional edit form, and a terminal above them when one is open. No router. |
| Sections | same | Machines · Workspaces · *Edit `<name>`* (only when a row asks) · New workspace · Sessions · Agents |
| Components | [`web/src/components/`](../../web/src/components/) | `Act` (212), `EditWorkspace` (226), `NewWorkspace` (191), `Terminal` (184), `DataTable` (101), `Section`, `Command`, `Age`, `Status`, plus five `ui/` primitives — **2,051 lines** in total with `columns.tsx` and `useLooked.ts` |
| Reads | [`crates/yantrad/src/api.rs:39-42`](../../crates/yantrad/src/api.rs) | `GET /api/machines`, `/api/workspaces`, `/api/sessions`, `/api/workspaces/{name}/status` |
| Writes | [`crates/yantrad/src/write.rs:97-101`](../../crates/yantrad/src/write.rs) | `POST /api/workspaces`, `PATCH /api/workspaces/{name}`, `POST /api/workspaces/{name}/{up,down,resume}` |
| Socket | [`crates/yantrad/src/terminal.rs:76`](../../crates/yantrad/src/terminal.rs) | `GET /api/workspaces/{name}/terminal`, upgrading to a WebSocket |
| Everything else | [`crates/yantrad/src/main.rs:140-151`](../../crates/yantrad/src/main.rs) | `GET /healthz`, `POST /heartbeat`, and the dashboard as the router's fallback |

**That is not barebones.** It polls four independent readings, each stamping its own age; it
distinguishes *nobody has looked* from *a look failed* from *a machine did not answer*; it draws a
workspace file that would not parse **below** the table with its reason rather than dropping it; it
runs a real xterm.js over a real pty with a capped reconnect. It is a small page carrying a lot of
correctness.

**What it is not is addressable.** There is one URL. Nothing on the page can be linked to, bookmarked,
or reopened after a reload in the state it was in. That, and not the feature count, is what "handle
everything via dashboard" collides with.

### 1b. Against the founding principle, honestly, in two halves

**The workspace half meets it.** `brainstorm.md:400-404` asks for *"No configuration files… the
interface should generate them automatically"*. [`NewWorkspace.tsx`](../../web/src/components/NewWorkspace.tsx)
and [`EditWorkspace.tsx`](../../web/src/components/EditWorkspace.tsx) do exactly that: they `POST`
and `PATCH` against `write.rs`, which calls
[`yantra_core::workspace`](../../crates/yantra-core/src/workspace.rs)`::create_in` / `update`, and the
TOML is rendered by `render()` at `workspace.rs:287`. Nobody edits a workspace file by hand unless
they want to. **The principle is met here and it should be said out loud**, because the spec reads as
though nothing meets it.

**The setup half violates it completely**, and [`docs/appliance.md:24-76`](../appliance.md) is the
evidence in the repo's own words. Before the appliance runs anything, a person must by hand: enrol
Tailscale; `useradd --system --create-home … yantra`; provide an ssh account that can `sudo`; write
`/etc/yantra/agent.env` with `printf 'YANTRA_DAEMON=100.x.x.x:7717\n' | sudo tee`; place an ssh key,
config and `known_hosts` (Y-144, still open); `scp ~/.config/yantra/workspaces/*.toml <host>:/tmp/`
and `install` them into the daemon's account; then `systemctl enable --now` both units. Ten steps,
three of them file-editing, one of them literally copying configuration files between machines.

The doc is explicit that this is deliberate — *"The recipe copies binaries and units. It creates no
accounts, writes no configuration and enrols nothing"* — and each refusal has a defensible reason
(`agent.env` is ADR-0013 §4's; the ssh identity is Y-144's). **But "deliberate" and "consistent with
the founding principle" are different claims, and only the first one is true.** The gap the spec
names is real, it is in the install path rather than the dashboard, and it is larger than any GitHub
feature.

### 1c. Where the clone would slot in, exactly

`up` already refuses a repository that is not there. [`up.rs:216`](../../crates/yantra-core/src/up.rs):

```rust
fn exists_command(repo: &str) -> String {
    format!("test -d {}", tmux::sq(repo))
}
```

and the error at `up.rs:66`:

```
workspace `{workspace}` opens at `{repo}`, and `{machine}` has no such directory
```

**That refusal is the seam.** The spec's clone is the answer to a question the code already asks. It
is also the whole of the integration: `Workspace` is `{ name, machine, repo: PathBuf, startup:
Option<String> }` — a *path on the far machine*, with no URL, no provider and no branch (ADR-0010
dropped `branch` on purpose).

**Confirmed absent:** `grep -rn -i 'github\|clone' crates/*/src/ --include=*.rs` returns only
`.clone()` calls. There is no git code anywhere in the Rust.

---

## 2. The architectural conflicts

This is the section the rest of the note exists for. Each conflict names the decision it collides
with, quotes it, and says whether the collision needs a superseding ADR or only a choice.

### 2.1 "The daemon persists nothing" versus a GitHub token — the sharpest one

The rule is stated in three places and it is not a preference:

- Root [`CLAUDE.md`](../../CLAUDE.md) §B1: **"The daemon persists nothing."**
- [ADR-0004](../adr/0004-rust-for-the-daemon.md), amendment 2026-08-02 (Y-044): *"The session state
  store was dropped without being built… `rusqlite` is in no `Cargo.toml` and no `Cargo.lock`."*
- [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md): *"Nothing is persisted… A store
  returns only for a question about the past."*

A GitHub credential is not a question about the past. It is state that must survive a restart, and
**the daemon restarts** — `yantrad.service` is `Restart=on-failure`, and the crate's own notes
already record a restart as a hole (*"The first look after a start says nothing… A restart is
therefore a hole, recorded as I-58's neighbour"*).

Now put §3's verified numbers against that rule:

| Credential | Survives a restart without storage? | What a persist-nothing daemon must do |
| --- | --- | --- |
| GitHub App user token (`ghu_`, **8 h**) + refresh (`ghr_`, **6 months**) | no | re-run the device flow **every 8 hours**, at a keyboard |
| OAuth App token (`gho_`, no expiry, **no refresh token issued**) | no | re-run the device flow **every restart** |
| Fine-grained PAT (up to 366 days, or `none`) | no | re-paste it every restart |
| **A credential that lives on the target machine** | **yes — it was never the daemon's** | **nothing** |

**The inversion is the finding.** GitHub's most carefully designed option — the App, with a
short-lived token and a rotating refresh token — is the one that makes the persistence problem
*worse*, because it turns "hold a secret" into "hold a secret and rotate it on a timer". The
sloppiest option, a non-expiring OAuth token, is the one that would hurt least to hold. Any design
that reasons "use the App, it is more secure" walks straight into this.

**Three ways out, and only one of them is free.**

**(a) Store nothing; the credential lives on the machine being cloned to.** Needs no ADR, no schema
change and no new secret handling. It is §2.2's verified path, and it is the recommendation. Its
cost is that the daemon cannot answer *"what repositories does this user have?"* on its own — it has
to ask a machine, which §4 prices.

**(b) The daemon holds a token.** This requires, at minimum: a superseding ADR to ADR-0004's
2026-08-02 amendment (which is an *amendment*, so the supersession is of the sentence, not of the
language choice); an edit to root §B1's four-word rule; a re-opening of **Q5**, which closed
*"reference-only, always"* with the sentence *"Holding secrets would mean earning the right to —
encryption at rest, key management, stream redaction, audit. That is a security product, not a
workspace orchestrator."* It also puts a file on the appliance under a `--shell /usr/sbin/nologin`
system account with no keyring. **This is not a small decision and it should not be taken by an
implementation PR.**

> **If it is taken, the shape is already argued.** Y-044's archived row names what would bring a
> store back — *"the first question about the past"* — and says what it would be: *"at roughly five
> placements a day, append-only and read newest-first, **the shape to argue for is a file** — I-14
> already refuses an ORM for four small tables."* A credential is not a question about the past, so
> it does not meet that condition; but if the daemon persists anything, that row has already ruled
> out reaching for SQLite to do it.

**(c) Delegate to the reference mechanism Q5 already blessed.** Q5's closure names the shape
verbatim: *"Workspaces store a pointer (`op://…`, `pass show …`, a sops path); Yantra resolves it at
launch, hands it to the process, and never writes it."* A GitHub token reachable as `op://…` fits
the letter of that exactly. **But read the second half of the sentence** — *resolves it at launch,
hands it to the process* — the resolved value then has to reach a `git` process on **another
machine**, which is §2.2's problem again, and §2.2 shows the value would end up on a command line.
Option (c) is Q5-compatible at the daemon and turns into option (b)'s problem at the wire.

### 2.2 §B4 versus a private clone — the mechanisms, priced

§B4 is absolute: **"Never store secrets. Workspaces hold *references*, never values."** The clone
target needs a credential. Six mechanisms, each judged on where the secret sits.

| # | Mechanism | Where the secret sits | §B4 | Verdict |
| --- | --- | --- | --- | --- |
| 1 | **`gh` already logged in on the target, as git's credential helper** | the target machine's credential store | **compatible by construction** | recommended |
| 2 | Deploy key on the target | the target machine's `~/.ssh` | compatible | does not scale — see below |
| 3 | ssh agent forwarding | the operator's agent, *lent* to the target | compatible in the letter | lends the key; see below |
| 4 | Short-lived token on the ssh command line | **`argv`, world-readable** | **refused** | measured below |
| 5 | GitHub App installation token (`ghs_`, 1 h) | the app **private key**, wherever it lives | refused unless the key is a reference | pushes the problem up one level |
| 6 | Fine-grained PAT pasted into the dashboard | wherever the daemon puts it | refused | §2.1(b) |

**Row 1, measured on this machine on 2026-08-08.** `gh` 2.96.0 is installed at `/usr/bin/gh`, `git`
is 2.55.0, and:

```
$ gh auth status
github.com
  ✓ Logged in to <owner> account (keyring)
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

$ git config --global --get-regexp credential
credential.https://github.com.helper
credential.https://github.com.helper !/usr/bin/gh auth git-credential
```

**So `git clone https://github.com/<owner>/<private-repo>.git` already works on this box today, for
private repositories, with no token anywhere near Yantra.** The empty first `helper` line is `gh
auth setup-git`'s reset entry; the second is the helper itself. Yantra does not hold, resolve, pass
or log anything — §B4 is satisfied the way [ADR-0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md)
§4 satisfies it, *"by construction rather than by policy"*, and there is no place in the design where
a secret would sit. This is the same argument ADR-0018 used to keep `claude`'s credential out of
Yantra, applied to `git`'s.

**Row 2 is real and does not scale.** GitHub's own documentation: a deploy key *"grants access to a
single repository"*, *"You can't reuse a deploy key for multiple repositories"*, and they *"don't
have an expiry date"*. A repo browser that lists 200 repositories and offers a *Clone* button next
to each cannot be backed by a mechanism that needs a key pair created per repository per machine.
GitHub itself recommends Apps over deploy keys.

**Row 3 lends the key rather than copying it.** `ForwardAgent yes` in `~/.ssh/config`, and GitHub's
warning is the operative sentence: the forwarded host *"will be able to use them **as you** while the
connection is established"*, and *"You should only add servers you trust and that you intend to use
with agent forwarding."* Note the interaction with **I-20**: this transport uses `ControlMaster` with
`ControlPersist=300`, so "while the connection is established" is not the duration of one command —
it is five minutes past the last one, on a socket the daemon keeps warm by polling every 30 s. That
turns an occasional lend into a near-permanent one. **And it is not Yantra's to configure**:
[ADR-0009](../adr/0009-machine-names-are-ssh-destinations.md) makes `~/.ssh/config` the single
authority on what a machine name means, so `ForwardAgent` is a line the owner writes, not a flag
Yantra adds.

**Row 4 is refused, and here is the measurement.** The pattern everyone reaches for is embedding a
token in the clone URL. Run on this machine, 2026-08-08:

```
$ nohup bash -c 'sleep 4; echo https://x-access-token:ghp_FAKE9876@github.com/o/r.git' &
$ ps -eo pid,user,args | grep x-access-token
3787422 <user>  bash -c sleep 4; echo https://x-access-token:ghp_FAKE9876@github.com/o/r.git

$ mount | grep ' /proc '
proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)
```

**Any local user on the target reads the token out of `ps` for as long as the clone runs**, and
`/proc` here carries no `hidepid`, so it is not even a race. [ADR-0006](../adr/0006-ssh-exec-transport.md)'s
base64 payload does not help — encoding is not concealment, and the base64 is in `argv` too. A clone
of a large repository is minutes of exposure. This is the mechanism to name and refuse in writing,
because it is the one a plausible implementation arrives at by itself.

**Row 5 pushes the problem up a level rather than solving it.** An installation token expires after
one hour, which is genuinely good, but obtaining one needs a JWT signed with the **app's private
key** (`POST /app/installations/{installation_id}/access_tokens`). That key is a long-lived secret
value and it would live wherever the daemon lives. §B4 refuses it for the same reason it refuses the
token — and the appliance is the worst possible home for it.

**This repo has refused a fleet-wide secret once already, on the same reasoning.** R-22's 2026-08-02
restatement lists what was deliberately *not* built for the heartbeat: *"no shared secret, no
per-agent token, no mTLS, no request signing — **a pre-shared key across five machines is a secret
Yantra would have to store, and §B4 says it never stores secrets.**"* A GitHub token the daemon
distributes to machines is that object with a different name.

### 2.3 Two identity systems, or one credential? — they are different problems

[ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) §2: a write is
authorised *"if and only if the caller's source address resolves to a node that is owned by the same
user as this daemon's own node, and carries no tags"*, resolved **live** (§3), never from the body
(§4), failing **closed** (§5), with [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
supplying *which* address that is when a proxy is in the path.

**Adding "Sign in with GitHub" would introduce a second answer to *who is calling*, and the spec does
not need one.** Separate the two questions:

| Question | Who answers it today | Does GitHub change it? |
| --- | --- | --- |
| *Is this caller allowed to drive Yantra?* | `tailscale whois` — ADR-0016 | **no, and it must not** |
| *Can Yantra (or a machine) reach github.com?* | nothing — no such code exists | **yes, this is the whole gap** |

The spec asks for the second and never the first. **Q2** measured this tailnet at *"six nodes, one
user, no tags"* — there is nobody for a second identity system to distinguish. **Q6** closed
*personal-first* and binds the web UI by name: *"single-tenant, no auth beyond Tailscale, no theming,
no settings screen."* A GitHub login screen is precisely the settings surface Q6 refused.

**Recommendation: no GitHub identity, ever.** If a token flow is added at all, it authenticates
*Yantra to GitHub*, not *a person to Yantra*, and it must not be allowed to become a login. If
someone does want GitHub sign-in later, ADR-0016's *"Not decided here → Per-user authorisation"*
reserves the ground and it is a superseding ADR.

### 2.4 ssh is the only transport — what that constrains about a clone

[ADR-0006](../adr/0006-ssh-exec-transport.md) makes the system `ssh` binary the way a command reaches
a machine, and ADR-0009 makes `machine` an ssh destination passed *verbatim*, with `~/.ssh/config`
the single authority. A clone runs `ssh <machine> 'git clone …'` through the same `Exec`. Four
constraints follow, and only the first is obvious:

1. **`Exec` is one-shot, `RequestTTY=no`, and has no stdin** — recorded as one of the two findings
   that made Y-132 need its own pty layer. So **no interactive credential prompt is possible**. Git
   must find a non-interactive credential or fail, and the honest flag is `GIT_TERMINAL_PROMPT=0`, so
   a missing credential is an immediate error rather than a hang. Without it, a clone that cannot
   authenticate blocks until the ssh times out and reports nothing useful.
2. **A clone is unbounded, and every existing write is not.** `crates/yantrad/CLAUDE.md`'s rule is
   *"Never `await` ssh inside a handler"*, with a stated exception: *"`write.rs` awaits it because a
   person tapped a button once."* That exception is priced on `up`, which is a handful of ssh
   round-trips. A clone of a large repository is minutes. **Whether a write handler may await an
   unbounded operation is an open design question this note does not answer** — the two shapes are a
   `202` plus a progress route (which implies state, so §2.1 again) or an awaited request with a long
   client timeout. Name it before building it.
3. **Host keys.** Cloning over `git@github.com:` needs `github.com` in the *target machine's*
   `known_hosts`. Over HTTPS it needs nothing. **Unverified** for this fleet, and it is one more
   reason HTTPS-plus-`gh` beats ssh-plus-deploy-keys.
4. **The appliance has no ssh identity yet.** Y-144 is open, and `docs/appliance.md` says plainly
   *"without it the daemon starts and every verb that reaches a machine fails."* **Q18 was answered
   on 2026-08-08** — the appliance keeps its own `~/.ssh/config` — so this is scoped, not solved. A
   clone driven from the appliance inherits that dependency whole.

### 2.5 The remote coding agent is already built — say what is actually missing

[ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) launches `cd <repo> && claude
--session-id <uuid>` into a tmux pane via `respawn-pane -k` (I-29), gates on `claude auth status`
before launching, and reads status back from `claude agents --json`.
[ADR-0015](../adr/0015-resume-forks-the-conversation.md) adds `--continue --fork-session` for resume.
The dashboard already drives all three verbs from [`Act.tsx`](../../web/src/components/Act.tsx) via
`POST /api/workspaces/{name}/{up,down,resume}`.

**So "start up a remote coding agent" from the dashboard is shipped.** What is missing is narrower
than the spec sentence suggests:

- **the repository being there first** — §1c, which is the clone and nothing else;
- **a second agent.** `brainstorm.md:370-380` lists five agents and says *"Future agents should be
  plugins"*, but **Q6 closed that off**: *"no plugin architecture… one fleet, one owner."* The
  one-agent-first guardrail holds. `AgentArg` in [`crates/yantra/src/main.rs`](../../crates/yantra/src/main.rs)
  is deliberately an enum with one variant *"so that adding a second agent is a new variant, not a
  new flag"*. Do not build a plugin system for this.

**"or ssh terminal" is also shipped, with one real gap.** `GET /api/workspaces/{name}/terminal` plus
[`Terminal.tsx`](../../web/src/components/Terminal.tsx) is a real xterm.js over a real pty, with
reconnect capped at five attempts half a second apart and no server-side buffer. But it is
**per-workspace only** — there is no *"give me a shell on machine X"* that is not a workspace. That
is a genuine gap, it is small, and it mirrors an existing route exactly. §4 prices it.

### 2.6 macOS — where the clean path may quietly fail, and nobody has checked

[ADR-0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md) §1: on macOS `up`
**requires an existing tmux server and refuses when there is none**, because a server started over
ssh is in launchd's `Background` domain and the `claude` it forks cannot read the login keychain
(**I-44**). §7 hands M7 a launchd job to keep such a server alive; that job is not built.

Two consequences for a GUI-driven *clone, then start an agent* on the Mac:

**The clone succeeds and the launch refuses, and that is correct.** `git` in the `Background` domain
can clone perfectly well; `claude` in a `Background` tmux server cannot authenticate. So the flow
half-completes, and ADR-0018's refusal — which names its reason — is the right outcome rather than a
bug. A GUI must render that refusal as *"the Mac needs a login session"*, not as *"clone failed"*.

**And here is the thing nobody has tested.** `gh auth status` on this Linux box reports its token is
in the **keyring**. GitHub CLI's documentation says a token *"will be stored securely in the system
credential store"*, falling back to *"writing the token to a plain text file"* when that is
unavailable. On macOS the system credential store is **the login keychain** — which is exactly what
I-44 proves an ssh session cannot read.

> **Unverified, and it is the highest-value measurement in this note.** If `gh` on
> `bishwajeets-macbook-pro` keeps its token in the login keychain, then
> `ssh bishwajeets-macbook-pro 'git clone https://github.com/<owner>/<private>.git'` **fails to
> authenticate for the same architectural reason Claude Code does** — and §2.2's clean path has a
> hole in it on one of the two machines in this fleet that are on. I could not test it: I have no
> access to that machine, and the `gh` documentation I could reach does not name its macOS backend.
>
> **The test is one command and it settles the design**, in the shape ADR-0018 §8's probe already
> established: from this machine, `ssh bishwajeets-macbook-pro 'gh auth status'` and
> `ssh bishwajeets-macbook-pro 'git ls-remote https://github.com/<owner>/<a-private-repo>.git >/dev/null && echo ok'`.
> If those work, §2.2 row 1 is the answer for the whole fleet. If they do not, macOS needs a
> different mechanism and this note's recommendation is Mac-incomplete.

**The appliance has the same shape of problem and a different cause.** `docs/appliance.md` creates
the daemon's account as `useradd --system … --shell /usr/sbin/nologin yantra` — no GUI session, no
desktop keyring, no login shell. `gh`'s documented fallback there is a plain-text file, which is a
stored secret value by another name. **Also unverified**, and it means the recommendation in §2.2 may
hold for the fleet's *workstations* and not for the box that is meant to run unattended.

### 2.7 Routing — half the recorded objection has expired, and the repo already says so

[`App.tsx:29-31`](../../web/src/App.tsx) states the decision in a comment:

```
// A sixth section rather than a route: nothing else on this page is
// addressable, and one that was would promise a deep link that survives a
// reload, which is a socket this page cannot yet reopen (Y-132).
```

**The tracker has already been here, and it is more careful than that comment.** Y-132's closing
paragraph, verbatim:

> **The routing decision is reopened and deliberately not taken.** This row said it should be, and
> half of Y-130's objection is now spent: a deep link promised a socket reopened on load, and a
> socket that reopens itself exists. The other half does not follow from it — reconnect happens
> inside a terminal already on the screen, while a URL has to survive a reload, which needs the
> workspace name to come from somewhere and the dashboard to have a router at all. That is a
> decision about the page rather than a patch to it, and it belongs to whoever takes it.

**So the correct statement is "half spent", not "expired"** — and the surviving half is real:
reconnecting a socket you are already looking at is not the same as opening one from a cold page
load. What is settled is that nothing on the Rust side blocks it. Y-130's row records the same:

> There is no router… while [`web.rs`] *already* SPA-falls-back deep links to `index.html`, so the
> server is ready for `/workspaces/<name>/terminal` and the client would land on the same page.

Confirmed in code — [`web.rs:63-66`](../../crates/yantrad/src/web.rs) is
`ServeDir::new(dir).fallback(ServeFile::new(&index))`, and the crate's notes say *"Unknown paths get
`index.html` rather than a 404, which is what makes a deep link work."*

So the cost of a router is one dependency and a refactor of `App.tsx`, not a redesign. `web/package.json`
carries no router today (deps are React 19, `@base-ui/react`, xterm, Tailwind and four utilities), so
this is a real addition — but note [R9](09-component-libraries.md) and
[ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md) set the bar for adding one, and the
React Compiler check in `npm run build` must stay green through it.

**The honest counter-argument, which the owner should hear:** §A2 says no abstraction for single-use
code, and one route is single-use. What changes that is the spec itself — a repo browser, a machine
detail page and a linkable terminal are three more addressable things, and three is past the third
use. **The router is justified by the spec, not by taste**, and it should land with the pages, not
before them. Y-132 left it to *"whoever takes it"*; the spec is what makes it takeable.

### 2.8 The provisioning non-goal — does a clone cross it?

This is the guardrail most likely to be invoked against the spec, so it should be answered rather
than dodged. [`tracker.md`](../../tracker.md) §1:

> **Provisioning is a permanent non-goal.** Yantra adopts machines that already exist; it never
> creates, images, or destroys them. This is precisely the line that separates it from Coder — and
> R4's verdict is blunt: *if Yantra ever grows a provisioning layer it becomes a worse Coder and
> should be deleted.*

and **R-6**, status *permanent*: *"Scope creep into provisioning. The gravitational pull from 'adopt
a machine' toward 'create a machine' is strong."*

**Read literally, a clone does not cross it.** Every clause of the guardrail is about **machines** —
create, image, destroy — and a clone creates a *directory on a machine that already exists*, which is
the same category of act as `up` creating a tmux session or `new` writing a TOML. Yantra already
mutates the far side; `test -d <repo>` exists precisely because it does not mutate *that* part of it
yet.

**But R-6 is about a gravitational pull, not a definition, and the pull is real here.** The sequence
that ends badly is short and each step looks reasonable: clone a repo → clone into a *container* →
create the container → choose the image. That is Coder, arrived at in four moves. **The line worth
writing into whatever ADR covers the clone is that Yantra places files on machines it was given and
never creates a place to put them** — and §B2's `docker` clause (Y-125) is the precedent for how this
repo phrases intended-but-unshipped scope.

Worth stating plainly: **nothing about cloning is tracked anywhere.** A search of `tracker.md`, every
crate tracker and all of `docs/` finds no row, no question and no ADR about repository provisioning;
the only occurrences of the word mean *the operator cloned it themselves*. The gap is real and it is
not an oversight — see §6's last note.

---

## 3. GitHub, verified against the official documentation

All of this was fetched from `docs.github.com` on 2026-08-08. **The search budget for this session
was exhausted, so everything here comes from pages fetched directly by canonical URL** — the Sources
section lists every one. Where a page did not answer a question, it says so rather than guessing.

### 3.1 The headline, stated as a negative finding

> **The device flow is the only browser-based authorisation that works with no public ingress — and
> it is off by default.** Both an OAuth App and a GitHub App support it, neither redirects anywhere,
> and neither needs a reachable callback. But *"Before you can use the device flow to authorize and
> identify users, you must first enable it in your app's settings"*, and the error you get when you
> forget is `device_flow_disabled`.

Two further things that look like ingress requirements and are not:

- **An OAuth App's registration form *requires* an "Authorization callback URL".** The docs list it as
  a numbered step alongside Application name and Homepage URL. **Nothing in the device flow ever
  redirects to it** — the device-flow documentation states the redirect URL is not required. So the
  field must be *filled in* and never *reached*. This is the single most likely reason someone
  concludes GitHub OAuth is impossible on a tailnet-only tool. It is not.
- **A GitHub App's callback URL is optional outright** — *"Optionally, under 'Callback URL'…"* — and
  webhooks can be switched off by deselecting **Active**. Only the app name and Homepage URL are
  required.

### 3.2 The three options, side by side

| | Fine-grained PAT | OAuth App + device flow | GitHub App + device flow |
| --- | --- | --- | --- |
| Public ingress needed | **no** | **no** (callback field filled, never used) | **no** (callback optional) |
| Owner setup | create in the web UI | register an OAuth App, **enable device flow** | register a GitHub App, **enable device flow**, install it |
| Created by software? | **no** — docs describe web-UI creation only | n/a | n/a |
| Token | pasted by hand | `gho_…` | `ghu_…` |
| Lifetime | 1–366 days, or `none` | not documented as expiring | **8 h** (`expires_in: 28800`) |
| Refresh | none — recreate by hand | **no refresh token issued** | `ghr_…`, **6 months** (`refresh_token_expires_in: 15897600`); expiry can be disabled in *Optional Features* |
| Client secret | n/a | not needed for the device flow | not needed for device flow; **required to refresh** (`grant_type=refresh_token`) |
| Org friction | may be `pending` until an org admin approves | scopes | permissions + installation |

**Negative findings worth stating loudly:**

- **Fine-grained PATs cannot be minted by software.** The documentation describes web-UI creation and
  nothing else. Any design whose "connect GitHub" button ends in a fine-grained PAT ends at a browser
  tab and a paste.
- **The OAuth App gives no refresh token.** That is usually a downside. Here it is the *only* option
  whose credential does not need rotating — see §2.1's inversion.
- **Refreshing a GitHub App token needs the client secret**, so a daemon that refreshes holds two
  secrets, not one.

### 3.3 Exact shapes, for whoever implements it

**Device flow, step 1** — `POST https://github.com/login/device/code`, `client_id` required, `scope`
optional:

```json
{ "device_code": "<40 chars>", "user_code": "XXXX-XXXX",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900, "interval": 5 }
```

**Step 2** — the person opens `verification_uri` on any device and types `user_code`. **This is what
makes it ingress-free**: the browser talks to github.com, never to Yantra.

**Step 3** — poll `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code`
and `grant_type=urn:ietf:params:oauth:grant-type:device_code`, no faster than `interval`:

```json
{ "access_token": "gho_…", "token_type": "bearer", "scope": "repo,gist" }
```

Errors to handle by name: `authorization_pending` (keep polling), `slow_down` (**add 5 s to the
interval**), `expired_token` (the 900 s ran out — start again), `access_denied`,
`unsupported_grant_type`, `incorrect_client_credentials`, `incorrect_device_code`,
`device_flow_disabled`.

**Refresh (GitHub App only)** — `POST https://github.com/login/oauth/access_token` with `client_id`,
`client_secret`, `grant_type=refresh_token`, `refresh_token`; the response carries a **new**
`refresh_token` as well as the access token, so the stored value rotates every time.

**Listing repositories** — all paginated by the `Link` header, `per_page` default **30**, max
**100**, `page` default 1:

| Endpoint | Notable defaults |
| --- | --- |
| `GET /user/repos` | `visibility=all`, `affiliation=owner,collaborator,organization_member`, `type=all`, `sort=full_name`, `direction=asc`; also `since` / `before` (ISO 8601) |
| `GET /orgs/{org}/repos` | `type=all`, `sort=created` |
| `GET /users/{username}/repos` | `type=owner`; **public repositories only** |

For a GitHub App the shape is different and two-level: `GET /user/installations` returns
`{ total_count, installations[] }`, then `GET /user/installations/{installation_id}/repositories`
returns `{ total_count, repository_selection, repositories[] }`.

**Cloning.** The documented URL forms are `https://github.com/user/repo.git` and
`git@github.com:user/repo.git`. For HTTPS, *"Git will ask for your GitHub username and password. When
Git prompts you for your password, enter your personal access token"* — and *"Password-based
authentication for Git has been removed."* A GitHub App needs the **Contents** repository permission:
*"If you want your app to use an installation or user access token to authenticate for HTTP-based Git
access, you should request the 'Contents' repository permission."*

> **Could not verify:** the `https://x-access-token:<token>@github.com/owner/repo.git` URL form. It is
> universally used and I found no `docs.github.com` page stating it — the installation-token page
> does not document git usage at all, and the search budget was spent. **This matters more than it
> looks**, because that URL form is precisely §2.2 row 4, the mechanism this note refuses on measured
> evidence. Treat its absence from the docs as a reason not to design around it, not as a reason to
> go looking.

---

## 4. What a GUI-first control plane actually needs

The binding rule first, because it changes the shape of every line below.
[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md): *"the CLI's own verbs and nothing more…
**A new verb here starts in the CLI.**"* and *"Anything the web UI can do must be expressible in
`yantra` first. That is what stops the daemon growing a second, richer API that the CLI cannot
reach."* So **every endpoint below implies a CLI subcommand, and the CLI one comes first.**

### 4.1 Routes in the page

| Path | Draws | Needs |
| --- | --- | --- |
| `/` | today's overview | — |
| `/machines/{name}` | one machine: beat, sessions, agents on it | existing reads, filtered client-side |
| `/workspaces/{name}` | one workspace: status, act buttons, edit form | existing reads + writes |
| `/workspaces/{name}/terminal` | the terminal, full height, linkable | existing socket + §2.7 |
| `/machines/{name}/shell` | a shell not tied to a workspace | **new route**, §4.2 |
| `/repos` | the repo browser and the clone flow | **new routes**, §4.2, blocked on §2.1 |

Nothing on the Rust side is needed for the first four — `web.rs` already serves any path as the app.

### 4.2 New daemon endpoints, method and shape

Each row names what blocks it. **None of these should be built before the row above it is decided.**

| Method + path | Returns | CLI verb first | Blocked on |
| --- | --- | --- | --- |
| `GET /api/machines/{name}/repos` | `{ machine, reached: "yes"\|"no", repos: [{ full_name, private, updated_at, clone_url }] }` | `yantra ls repos --machine <m>` | **§2.1** — this is the §B4-clean version: it runs `gh repo list --json` **over ssh on the target**, so the credential never leaves that machine. Its cost is that it is a *read that awaits ssh*, which `crates/yantrad/CLAUDE.md` forbids by name. It must therefore either be cached into `refresh.rs`'s snapshot or be shaped as a write. **This is a real design question, not a detail.** |
| `GET /api/repos` | the same, from `GET /user/repos` | `yantra ls repos` | **§2.1(b)** — needs the daemon to hold a token. Superseding ADR. |
| `POST /api/machines/{name}/clone` `{ url, path }` | `{ machine, path, cloned: bool }` or `202` + a poll | `yantra clone <url> --machine <m> --into <p>` | **§2.4.2** — awaiting an unbounded ssh operation in a handler is outside `write.rs`'s stated exception |
| `GET /api/machines/{name}/shell` | WebSocket, exactly `terminal.rs`'s protocol | `yantra shell <machine>` | nothing — mirrors an existing route. **But note it widens what a terminal reaches**: `terminal.rs` today opens a pane in a workspace's session; a free shell is any command on any machine, and ADR-0016's authoriser is what stands between that and the tailnet. Worth a paragraph in whatever ADR covers it. |
| `POST /api/workspaces` | already exists | `yantra new` | — the clone flow *ends* here, and the call is already built |

**The clone flow, end to end, with no new persistence:** pick a machine → `GET
/api/machines/{name}/repos` (credential stays on the machine) → pick a repo and a path → `POST
/api/machines/{name}/clone` → `POST /api/workspaces` with `{ name, machine, repo }` → the existing
*Up* button. **Four calls, three of them new, one already shipped, and no token anywhere in Yantra.**

---

## 5. The TUI question — there is no TUI, and there should not be one

Read from [`crates/yantra/src/main.rs`](../../crates/yantra/src/main.rs): the CLI is `clap` with a
`Command` enum of eleven variants — `Up`, `New`, `Edit`, `Attach`, `Resume`, `Logs`, `Status`,
`Down`, `Ls`, `Notify`, `FixTerminfo` — printing text and choosing exit codes. There is **no
`ratatui`, no full-screen mode and no interactive picker anywhere in the repo.**

So *"alter TUI if needed"* has no referent unless it means one of two things that already exist:

- **the terminal inside the dashboard** — xterm.js over the M6 socket, shipped;
- **`yantra attach`** — which hands the terminal to `tmux`, and tmux *is* the TUI. §B2 is explicit
  that reimplementing a multiplexer is the signal you have misread the project.

**Recommendation: build no TUI.** §A2 forbids speculative surface, Q6 closed *personal-first* with no
second user to build for, and a TUI would be a third client of the library that has to be kept in
step with the CLI and the dashboard forever. **The work the spec actually implies for the CLI is not
a TUI at all** — it is that `yantra clone`, `yantra ls repos` and `yantra shell` must exist, because
the daemon's own rule will not let the dashboard have those verbs otherwise. That is a feature of the
rule, not a tax: it keeps the CLI at parity for free.

---

## 6. Sizing and sequencing

### Genuinely independent — buildable today, no decision owed

1. **The router and the page split** (§2.7). Web only. `web.rs` has served deep links since Y-073, and
   Y-132 removed the recorded objection. Add one dependency, split `App.tsx` into routes, keep the
   React Compiler check green.
2. **`/machines/{name}` and `/workspaces/{name}` pages.** Existing reads, filtered. No daemon change.
3. **A linkable terminal.** The socket and the reconnect already exist; this is a URL.

### Blocked on a measurement, not on code — and each is one command

4. **Does `gh`/`git` authenticate over ssh on the Mac?** (§2.6.) This decides whether the whole clean
   path is fleet-wide or Linux-only. **Run this first — it is cheaper than any of the above and it
   can invalidate §6's ordering.**
5. **Can the appliance's `nologin` system account hold a `gh` credential at all?** (§2.6.) Decides
   whether the always-on box can drive a clone or only the workstations can.

### Blocked on an ADR — §B0 forbids quietly building something else

| # | The decision | What it supersedes or amends |
| --- | --- | --- |
| **A** | **Where a git credential lives.** If the answer is *on the target machine*, this is a short ADR that records the choice and needs no supersession. If the answer is *the daemon holds a token*, it must **supersede ADR-0004's 2026-08-02 amendment**, change root `CLAUDE.md` §B1's *"The daemon persists nothing"*, and **re-open Q5** (*reference-only, always*). | ADR-0004 amendment · §B1 · Q5 |
| **B** | **Does a workspace gain an origin?** Today `Workspace` is `{ name, machine, repo, startup }` and `repo` is a `PathBuf` on the far machine — there is no `url`, `origin`, `remote`, `provider` or `branch` field. ADR-0007 lists what v1 excludes by name: *"agent selection, environment variables, **secret references**, port forwards, multiple panes, machine preferences"*, each *"deferred until something needs it"*. A clone URL is a schema change; a credential reference is one ADR-0007 already anticipated. | [ADR-0007](../adr/0007-workspace-schema-v1.md), in the shape [ADR-0010](../adr/0010-drop-branch-from-the-workspace-schema.md) already used to *remove* a field |
| **C** | **May a write handler await an unbounded operation?** A clone is not `up`. | `crates/yantrad/CLAUDE.md`'s *"Never `await` ssh inside a handler"* and its stated write exception |
| **D** | **What a free shell on a machine may reach**, if `GET /api/machines/{name}/shell` is built. | nothing directly, but it widens ADR-0016's blast radius and should say so |
| **E** | *(only if ever wanted)* **GitHub as a second identity.** §2.3 recommends never. | ADR-0016 *"Not decided here → Per-user authorisation"* |

### And one thing that is not an ADR at all

**Promoting GitHub integration out of *Future Possibilities*.** It sits at `brainstorm.md:535` and
`vision.md:270` and is in **no milestone** — M6 and M7 are open and hardware-blocked, M8–M10 are
queued behind them. A search of `tracker.md`, every crate tracker and all of `docs/` finds **no row,
no open question and no ADR** about repository cloning; the guardrail nearest to it is the
provisioning non-goal (§2.8), which it does not cross. So there is nothing to slot this into and no
milestone that claims it. **That is a scope decision and it belongs to the owner** (§B0: the plan
proposes, the owner opens rows). This note deliberately opens nothing.

For whoever writes them: the next unused ADR number is **0019** (0003 was withdrawn and is not
reused; numbers are assigned when an ADR is written, never reserved).

**A suggested order, if it helps:** measurement 4 → decision A → the router and pages (1–3, which
need neither) → `yantra shell` + its route → `yantra clone` + decisions B and C → the repo browser
last, because it is the only piece that might need decision A to come out the expensive way.

---

## Sources

All accessed **2026-08-08**.

**GitHub, official documentation**

- [Authorizing OAuth apps — device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
  — the three endpoints, `grant_type=urn:ietf:params:oauth:grant-type:device_code`, the
  `device_code`/`user_code`/`verification_uri`/`expires_in: 900`/`interval: 5` shape, the eight error
  codes, *"you must first enable it in your app's settings"*, and that no redirect URL is required.
- [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
  — Application name, Homepage URL and **Authorization callback URL** are the required fields.
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
  — name and Homepage URL required; *"Optionally, under 'Callback URL'…"*; webhooks disabled by
  deselecting **Active**.
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
  — GitHub Apps support the device flow, `client_id` only, no client secret, `ghu_` prefix, 8-hour
  expiry.
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
  — *"eight hours"* / *"six months"*, `expires_in: 28800`, `refresh_token_expires_in: 15897600`,
  `ghu_`/`ghr_` prefixes, `grant_type=refresh_token` with `client_secret`, and that expiry can be
  opted out of.
- [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
  — JWT then `POST /app/installations/{installation_id}/access_tokens`; *"will expire after 1 hour"*;
  `ghs_` prefix. **Documents no git-clone usage** — see §3.3's unverified note.
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  — fine-grained PATs: 1–366 days or `none`, single user or org owner, org approval leaves them
  `pending`, and creation documented only through the web UI.
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
  — *"you should request the 'Contents' repository permission"* for HTTP-based Git access.
- [REST — Repositories](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28) —
  `GET /user/repos`, `GET /orgs/{org}/repos`, `GET /users/{username}/repos`; parameters, defaults,
  `per_page` 30/100, Link-header pagination.
- [REST — Apps / installations](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28)
  — `GET /user/installations` and `GET /user/installations/{installation_id}/repositories` with their
  `total_count` shapes.
- [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
  — per-repository, *"You can't reuse a deploy key for multiple repositories"*, no expiry, and the
  four alternatives including installation tokens.
- [Using SSH agent forwarding](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/using-ssh-agent-forwarding)
  — `ForwardAgent yes`; *"will be able to use them **as you** while the connection is established"*;
  *"You should only add servers you trust."*
- [About remote repositories](https://docs.github.com/en/get-started/git-basics/about-remote-repositories)
  — the two clone URL forms; the PAT goes in the password prompt; password authentication removed.
- [Caching your GitHub credentials in Git](https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git)
  — `gh auth login` stores git credentials automatically; Git Credential Manager uses the macOS
  keychain and the Windows credential manager.
- [`gh auth login` manual](https://cli.github.com/manual/gh_auth_login) — flags including
  `--with-token`, `--web`, `--git-protocol`, `--insecure-storage`; *"The default authentication mode
  is a web-based browser flow"*; the token is stored in the system credential store, falling back to
  *"writing the token to a plain text file"*.

**Measured on `cachyos-g14`, 2026-08-08**

- `gh` 2.96.0, `git` 2.55.0, `ssh` present. `gh auth status` reports the account logged in with the
  token in the **keyring** and scopes `gist, read:org, repo, workflow`.
- `git config --global --get-regexp credential` shows `credential.https://github.com.helper` set to
  `!/usr/bin/gh auth git-credential` — so a private clone over HTTPS already authenticates on this
  machine with no token from Yantra.
- A token embedded in a command string is visible to every local user in `ps -eo pid,user,args`, and
  `/proc` is mounted `rw,nosuid,nodev,noexec,relatime` with no `hidepid`.

**Yantra internal** — [`CLAUDE.md`](../../CLAUDE.md) §A2, §B0, §B1, §B2, §B4, §B5, §B6;
[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md) (the routes that act, the terminal route,
*never `await` ssh inside a handler*, *nothing is persisted*);
[`docs/brainstorm.md`](../brainstorm.md) lines 266-302, 368-390, 394-404, 408-427 and 535;
[`docs/vision.md`](../vision.md) line 270; [`docs/appliance.md`](../appliance.md) §*What the box needs
before the first install*; [`docs/architecture.md`](../architecture.md) §5;
[`docs/archive/m4-m5.md`](../archive/m4-m5.md) the Y-044 row and its audit of five candidate
consumers; [R9](09-component-libraries.md);
ADRs [0004](../adr/0004-rust-for-the-daemon.md) (amendment), [0006](../adr/0006-ssh-exec-transport.md),
[0007](../adr/0007-workspace-schema-v1.md), [0009](../adr/0009-machine-names-are-ssh-destinations.md),
[0010](../adr/0010-drop-branch-from-the-workspace-schema.md), [0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md), [0015](../adr/0015-resume-forks-the-conversation.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
[0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
[0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md);
[`tracker.md`](../../tracker.md) §1 (the provisioning non-goal), Q2, Q5, Q6, Q18, milestones M6–M10,
risks R-6, R-21, R-22 and R-23, and rows Y-044, Y-125, Y-130, Y-132, Y-144, Y-155;
[`web/src/`](../../web/src/) `App.tsx`, `api.ts`, `components/`;
[`crates/yantrad/src/`](../../crates/yantrad/src/) `api.rs`, `write.rs`, `terminal.rs`, `web.rs`,
`main.rs`; [`crates/yantra-core/src/`](../../crates/yantra-core/src/) `workspace.rs`, `up.rs`;
[`crates/yantra/src/main.rs`](../../crates/yantra/src/main.rs).
