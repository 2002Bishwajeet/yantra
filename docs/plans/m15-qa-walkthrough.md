# M15 — the QA walk-through, one stage at a time

**Started 2026-09-11, owner's ask:** *"we will go step by step now since a lot of things in the qa
analysis is missing. Keep a tracker somewhere so we can discuss and revisit."*

[`m15-qa-pass.md`](m15-qa-pass.md) is the script a person walks. This file is the conversation
around it: for each stage, what should happen, what happens today, the gaps, and what the owner
decided. A gap becomes a `Y-NNN` row in [`tracker.md`](../../tracker.md) only after the owner rules
on it. Row [Y-382](../../tracker.md) owns this file.

**Evidence tags.** `[C]` means read from the code and not yet run. `[M]` means measured on real
hardware. A `[C]` gap is a prediction until the walk confirms it.

## Stages

| # | Stage | State |
| --- | --- | --- |
| 1 | First install on the appliance | ✅ ruled → [Y-384](../../tracker.md). Agent installs accepted as [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md) → [Y-386](../../tracker.md) |
| 2 | The dashboard walkthrough — machines, ssh key, AI agents, GitHub | ✅ ruled 2026-09-12 → [Y-387](../../tracker.md), [Y-388](../../tracker.md), [Y-389](../../tracker.md) |
| 3 | Bringing each other device into the fleet | ✅ ruled 2026-09-12 → [Y-390](../../tracker.md); native Windows → research [Y-391](../../tracker.md) |
| 4 | The first session | ⬜ |
| 5 | Every device, and what travels between them | ⬜ |
| 6 | When things go wrong | ⬜ |

---

## Stage 1 — first install on the appliance

**The scenario (owner, 2026-09-11).** Four bare devices that do not know about each other. The owner
buys a Raspberry Pi or a Wyse thin client and installs Yantra on it first.

### 1.1 The ruling

> *"it should be interactive. install.sh should install necessary softwares and programs required
> for this to work … then once its done, we should start up the web server for dashboard, and allow
> user to continue the walkthrough and process from there, so setting up tailscale machines, AI
> agents, ssh key everything, github also. install.sh should only install this and tailscale on
> asking a confirmation."* — owner, 2026-09-11

So the split is:

| `install.sh`, in the terminal, once | The dashboard, afterwards |
| --- | --- |
| Installs Yantra | The other machines on the tailnet |
| **Asks**, then installs Tailscale | The appliance's ssh key |
| Starts the dashboard | The AI agents on each machine |
| Prints the one URL to open | GitHub |

### 1.2 What happens today

A person runs **at least five commands** before the dashboard is useful, and must guess one URL.

1. `curl … install.sh | bash` — installs the binaries and the units, starts nothing, and prints four
   manual steps ([`install.sh`](../../install.sh) lines 170–180).
2. `sudo tailscale up`, if the box is not enrolled. install.sh reports this at the end, after the
   download.
3. `provision.sh` — *"from wherever you fetched this"* (install.sh line 179). With `curl | bash` there
   is no *where*, so the person has to build the raw URL themselves.
4. `printf 'YANTRA_DAEMON=100.x.x.x:7717\n' | sudo tee -a /etc/yantra/agent.env` — the appliance's
   own address, typed by hand, because ADR-0013 §4 keeps it out of the script.
5. `sudo -u yantra -H /usr/local/bin/yantra ssh-identity` — the key. Nothing runs it for you, because
   [D2.10](../design/02-setup.md) (is generating a key Yantra's job?) has been open since 2026-08-09.
6. `tailscale serve …` for HTTPS, which no script does
   ([`appliance.md`](../appliance.md) last section).

### 1.3 Gaps

| # | Gap | Evidence | Sev | After the ruling |
| --- | --- | --- | --- | --- |
| G1.1 | The tailnet prerequisite is said last, not first. | install.sh 152–163 | major | **Y-384** — the install asks first |
| G1.2 | Two scripts, and the second has no URL. | install.sh 179 | major | **Y-384** — one script; §1.6 Q4 |
| G1.3 | Five or more commands before the dashboard works. | §1.2 | major | **Y-384** |
| G1.4 | The checklist's footer says *"Nothing here needs a terminal"*; its ssh step names a terminal command. | `web/src/screens/setup/Setup.tsx:277`, `steps.ts` `sshKey` | major | Stage 2 — the key moves into the dashboard |
| G1.5 | **Likely blocker: with no workspace, no machine can go green.** `ssh-identity` writes a `Host` block only for machines a workspace names; production ssh never passes `-i`, so `id_yantra` is never offered; no `User` is sent, so it logs in as `yantra` on a laptop with no such account; the remedy line does not name the account. The last step needs one ready machine, so a first install can deadlock. | `[C]` `yantra-core/src/identity.rs` `prepare`, line 138; `ssh.rs` `identity` set only in tests; `steps.ts` `remedy` | blocker? | Stage 2 |
| G1.6 | Copy does nothing on plain HTTP: `navigator.clipboard` needs a secure context, and the error is swallowed. | `[C]` `Setup.tsx:39–58` | major | **Y-384** if the install turns on HTTPS (§1.6 Q3); a fallback in stage 2 either way |
| G1.7 | HTTPS is a manual step that no script mentions. | `appliance.md` last section | minor | §1.6 Q3 |
| G1.8 | GitHub sign-in refuses on a fresh box: no `YANTRA_GITHUB_CLIENT_ID` in the release build or in `daemon.env`. | `[C]` `yantra-core/src/github.rs:73` | major | Stage 2 |
| G1.9 | `appliance.md` says *"v0.1.0 is published"* and gives a URL whose script now refuses. | `appliance.md` 7, 129, 135 | major | **Y-384** rewrites it (§B5); Y-159 still owns the hosted name |
| G1.10 | A tagged enrolment may refuse every write from the dashboard; Y-143 never measured it. | tracker Q17, Y-143 | unknown | §1.6 Q1 |

### 1.4 What `install.sh` does after the ruling — proposed, for Y-384

1. Reads answers from `/dev/tty`, because `curl | bash` makes stdin the script. With no terminal it
   asks nothing and does what it does today, which is also what keeps
   [`installer.rs`](../../crates/yantrad/tests/installer.rs) able to run it in a container.
2. Says in its first lines what it will do and that every device must end up on one tailnet.
3. **Tailscale absent →** *"Install Tailscale? [Y/n]"* → Tailscale's own installer.
   **Not up →** runs `sudo tailscale up`, which prints a login URL the owner opens on a phone.
   Then `tailscale serve --bg --https=8443` puts HTTPS in front of the dashboard. On a tailnet that
   never had HTTPS, it prints one link to turn it on. Before it runs, the install says that the
   box's name goes into the public certificate log.
4. Installs Yantra exactly as today — checksum, account, binaries, units.
5. Writes the appliance's own `YANTRA_DAEMON` from `tailscale ip -4`, only when `agent.env` is absent.
6. `systemctl enable --now` both units, and waits until `yantrad` answers.
7. Ends with one line: the dashboard's URL.
8. **A second run is the updater:** it asks nothing it already has an answer to, and it touches no
   configuration (D2 §1).

### 1.5 Decided

| Date | Ruling |
| --- | --- |
| 2026-09-11 | The installer is interactive. It installs Yantra, and installs Tailscale only after a yes. |
| 2026-09-11 | The installer starts the dashboard. Everything after that is a walkthrough in the dashboard: the tailnet's machines, AI agents, the ssh key, GitHub. |
| 2026-09-11 | That settles D1.1 (install Tailscale on a yes), D1.3 (one script that starts the units) and D1.2 (the key is made from the dashboard, not by the install). |
| 2026-09-11 | **Q1 accepted.** `tailscale up` runs inside the install, and the box joins untagged. Q17's *tagged* answer is superseded. The owner turns off key expiry for this node in the admin console. |
| 2026-09-11 | **Q3 folded into Q1.** The Tailscale step also runs `tailscale serve`; it is not a separate question. HTTPS is **not** automatic after a login: it is one `serve` command, one click on a tailnet that never had HTTPS ([Tailscale KB 1153](https://tailscale.com/kb/1153/enabling-https), [KB 1312](https://tailscale.com/kb/1312/serve), read 2026-09-11), and the machine's name goes into a public certificate log. It matters on the Linux box where setup happens too: `http://100.x:7717` is not a secure context there either — only `localhost` is. |
| 2026-09-11 | **Q4 agreed.** `provision.sh` is retired in Y-384. |
| 2026-09-11 | **Q5 agreed.** The install does not install `gh`. GitHub is the dashboard's. |
| 2026-09-11 | **Q2: the owner overruled the recommendation. Yantra installs the AI agents on the other machines**, because a command per machine is too tiresome. This reverses [ADR-0027](../adr/0027-the-appliance-pulls-its-own-update.md) §7 and the fleet clause of [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md), so ADR-0028 comes before any code — [Y-385](../../tracker.md), §1.8. |
| 2026-09-12 | **ADR-0028 accepted.** `git` is part of the minimum, so the list is `tmux`, `git` and `claude`. One press installs every missing basic on that machine. Optional tools come later, chosen by checkbox. [Y-386](../../tracker.md) builds it. |

### 1.6 Open — the ruling raises these

| # | Question | Why it is a question | Recommendation |
| --- | --- | --- | --- |
| Q1 | **`tailscale up` has to finish inside `install.sh`.** Is that all right? | `yantrad` refuses to start until the box holds a tailnet address, by design (`crates/yantrad/CLAUDE.md`). The dashboard cannot exist before the box is on the tailnet, so this one login cannot move into it. An interactive login enrols the box **untagged**, which overturns Q17's *tagged* answer in practice. It also sidesteps Y-143. The cost is key expiry, which the owner turns off once for this node in the admin console. | Yes. Record Q17 as superseded. |
| Q2 | **AI agents on the other machines: does the dashboard install them, or hand you the command?** | [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md) non-goals: *"a control plane that can push a binary to five machines is the fleet-management product this project exists not to be (R-12)."* A dashboard that runs `curl claude.ai/install.sh` over ssh is that. | The dashboard hands over the exact command for that machine and re-checks after. Installing would need a superseding ADR. |
| Q3 | Does the Tailscale prompt also turn on HTTPS (`tailscale serve`)? | Plain HTTP breaks Copy (G1.6) and every other secure-context API on a phone. | Yes, as part of the same yes. |
| Q4 | What happens to `provision.sh`? | Its box half moves into `install.sh`, and its fleet half is the dashboard's walkthrough. | Retire it in Y-384, and point `appliance.md` at the dashboard. |
| Q5 | The ruling says *"github, optional stuff"*. Does `install.sh` install `gh` on the appliance? | The dashboard's GitHub sign-in is its own device flow ([ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md)) and needs no `gh` on the appliance. `gh` on the *other* machines is a per-machine check (`provider-cli`). | No. The dashboard handles GitHub. |

### 1.7 Verify on real hardware before a row is opened

- G1.5: a fresh Pi, no workspace, `ssh-identity` run, key placed on a laptop's own account → does
  Check go green, or does it answer *refused*?
- G1.6: tap Copy on the phone over `http://`.
- G1.8: a fresh Pi's GitHub step → does it answer 500?

### 1.8 ADR-0028 — Yantra installs what a machine needs

**Drafted 2026-09-11 as
[ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md), accepted 2026-09-12.** The ADR is the
current text. This section keeps the first proposal and the owner's answers to it. The answers
changed one thing: the install runs in the background, not in a terminal a person watches.

**What it changes.** ADR-0027 §7, accepted 2026-09-08: *"Yantra still ships no software to the
fleet. No binary, no unit, no script and no update instruction crosses ssh to any machine."*
ADR-0013's non-goals say the same. §B0 says an accepted ADR is superseded in writing, not worked
around.

**The proposed shape reuses the clone route's pattern** (Y-344):

1. **A person presses Install** on one machine, for one missing check. There is no sweep, no
   schedule and no fleet-wide button.
2. **The daemon opens a tmux session on that machine.** Its start command is the vendor's own
   installer, for example `curl -fsSL https://claude.ai/install.sh | bash`. The route answers `202`.
   Progress is that session's terminal in the browser (ADR-0022), and completion is a re-check.
3. **The person types any sudo password** in that terminal. `tmux` and `gh` come from the package
   manager and need root, and ssh runs with `BatchMode=yes`, so nothing else can type it.
4. **Yantra runs the vendor's published command and ships no binary of its own.** The list of
   commands is a constant in the code and is reviewed like any other code.
5. **What stays closed:** no update pushed across the fleet, no inventory of versions, a heartbeat
   reply that is still `204`, and a `yantra-agent` that stays heartbeat-only.

**The owner's answers, 2026-09-11:**

- **Q8.1 → the bare minimum Yantra needs to work.** In ADR-0028 that is `tmux` and `claude`.
  `yantra-agent` and `gh` are out.
- **Q8.2 → install only.** Updates are a later ADR.
- **Q8.3 → run in the background.** So `sudo` is `sudo -n`: a machine whose sudo needs a password
  stops at `tmux`, and the dashboard names the command.
- **2026-09-12 → `git` is in, and one press installs every basic.** ADR-0028 is accepted. Optional
  tools come later, as checkboxes.

**The questions as they were asked:**

- **Q8.1** Which installs are in scope? Only the agent CLIs, or also `tmux`, `gh` and `yantra-agent`?
  `yantra-agent` is Yantra's own binary, which is exactly what R-12 was written against.
- **Q8.2** Is **update** in scope too, for example a newer `claude` on every machine? Or install only?
- **Q8.3** The terminal shape means a person watches each install. Is that all right? Or should an
  install that needs no sudo run without a terminal? The Claude installer writes to `~/.local/bin`
  and needs no sudo.
- **For stage 3:** every install rides ssh, so the key must already be on a machine before Yantra can
  install anything there. That first step stays manual.

---

## Stage 2 — the dashboard walkthrough

**The scenario.** `install.sh` has finished (Y-384). The owner opens the dashboard on the laptop.
Three other devices are on the tailnet. No workspace exists, so `/` draws the setup checklist.

### 2.1 What should happen

1. The checklist lists the machines that can run a session. A phone or a tablet is not one of them.
2. For each machine there is **one thing to do**, and it is on the screen, ready to copy.
3. After that, Check goes green. Install (ADR-0028) puts `tmux`, `git` and `claude` there.
4. The machines step is done when **one** machine is ready. An asleep laptop does not hold the
   owner back from a first session.

### 2.2 The blocker — confirmed

**On a first install, placing the key on a machine does not make it reachable.** Three facts:

- `ssh::machine_at` builds every connection with `user: None` and `identity: None`
  (`crates/yantra-core/src/ssh.rs:48–60`). ADR-0009 leaves both to the `yantra` account's
  `~/.ssh/config`.
- `yantra ssh-identity` writes a `Host` block only for machines a workspace names
  (`identity.rs` `prepare`). On a first install there is no workspace, so it writes none.
- `[M]` With a key named `id_yantra` and no config, `ssh -G laptop` (OpenSSH 10.4p1, 2026-09-12)
  offers only `id_rsa`, `id_ecdsa`, `id_ecdsa_sk`, `id_ed25519` and `id_ed25519_sk`, and logs in as
  the **local** user. On the appliance that user is `yantra`, and the laptop has no such account.

So the key is never offered, the account is wrong, and the checklist's remedy
(`echo '<key>' >> ~/.ssh/authorized_keys`) does not say which account to run it as. The last step
needs one ready machine, so the first install cannot finish.

### 2.3 Other gaps on this screen

| # | Gap | Evidence | Sev |
| --- | --- | --- | --- |
| G2.1 | The blocker above. | §2.2 | blocker |
| G2.2 | **The checklist lists every tailnet node**, phones and tablets included, and the machines step is done only when **every** machine is ready. An iPhone on the tailnet keeps it from ever going green. | `[C]` `Setup.tsx:136` takes the list unfiltered; `steps.ts` `machines` wants `done.length === lines.length` | major |
| G2.3 | **It assumes `sshd` runs on the machine.** Most desktop Linux installs and every Mac ship with it off. The checklist names no step for it. | `[C]`; `docs/machines.md` measured no `sshd` on `cachyos-g14` | major |
| G2.4 | The ssh key step names a terminal command. Stage 1 ruled the dashboard makes the key (D1.2). | G1.4 | major |
| G2.5 | GitHub sign-in refuses: no client id in the release. | G1.8 | major |
| G2.6 | *Push to your phone* is hard-coded `todo`, so it says *not yet* after the relay works. | `[C]` `Setup.tsx:161` | minor |
| G2.7 | Copy fails silently on HTTP. Y-384's HTTPS removes the cause; a select-the-text fallback is still owed. | G1.6 | minor |

### 2.4 Proposal and questions

**Proposal: one join command per machine.** The checklist shows, for each machine:

```
curl -fsSL https://<appliance>.<tailnet>.ts.net/join | sh
```

The person runs it once, in a terminal on that machine. It:

1. Turns on `sshd` if it is off. It asks for sudo, which works here because a person is typing.
2. Adds the appliance's public key to **that account's** `authorized_keys`.
3. Offers to install `tmux` and `git` while it has sudo. The background install (ADR-0028) then has
   only `claude` left, which needs no sudo.
4. Tells the daemon which account it ran as. The daemon names the machine from the caller's tailnet
   address (ADR-0016's `whois`), never from the body, so a machine can only join itself.
5. The daemon appends `Host <machine>` / `User <account>` / `IdentityFile ~/.ssh/id_yantra` /
   `IdentitiesOnly yes` to its config. It never rewrites a block the owner wrote (ADR-0009).

**Why this over asking for the account in the dashboard:** a typed account name is one more thing to
get wrong. The join command also covers G2.3 and the sudo half of ADR-0028 in the one moment a
person is at that machine anyway.

**Why it does not reopen ADR-0028:** the person runs the script, in their own terminal. Nothing
crosses ssh, and the daemon initiates nothing.

| # | Question | Recommendation |
| --- | --- | --- |
| Q2.1 | How does Yantra learn the account on each machine? (a) The dashboard asks you to type it. (b) The join command tells it. | (b) |
| Q2.2 | May the join command turn on `sshd` and install `tmux` and `git` while it has your sudo? | Yes, each after a yes. |
| Q2.3 | Is the machines step done at **one** ready machine, with phones and tablets shown apart as *devices that open the dashboard*? | Yes. |
| Q2.4 | Is the key made automatically the first time a machine joins, or by a Create button? | Automatically. The join command needs it. |

**To verify before it is built:** how a Mac turns on Remote Login from a script. `systemsetup
-setremotelogin on` needs Full Disk Access on recent macOS, so the Mac may get a *System Settings*
step instead.

### 2.5 Decided

| Date | Ruling |
| --- | --- |
| 2026-09-12 | **Q2.1, as said:** *"since the main machine installs tailscale, and the account it registered, when we register or add new devices we try to match it with same account. for simplicity support only account for now."* Read as: **one Tailscale account owns every device, and Yantra supports only that one.** This matches ADR-0016, which already refuses any caller that is not the owner's own untagged node. **Clarified 2026-09-12 → (b):** the login account on each machine is whoever runs the join command there. Yantra assumes no username. |
| 2026-09-12 | **Q2.2 yes.** The join command turns on `sshd` and installs `tmux` and `git` with the person's sudo, each after a yes. |
| 2026-09-12 | **Q2.3 yes.** The machines step is done at one ready machine. Phones and tablets are listed apart, as devices that open the dashboard. **Later (owner):** *"we will also work on something to delegate some work on phones and tablets as well."* Not scoped, and no row yet. |
| 2026-09-12 | **Q2.4 automatically.** The daemon makes its ssh key the first time a machine joins. That closes D2.10 in [D2](../design/02-setup.md) §2: generating the key is Yantra's. |

---

## Stage 3 — bringing each other device into the fleet

### 3.1 The ruling

> *"since we onboard them via dashboard, we can show interactively tutorial for each platform"*
> — owner, 2026-09-12

**Adding a device is a guided flow in the dashboard, one per platform.** Each step ticks itself from
something the daemon already sees. The person never presses *I did it*.

### 3.2 The shape — proposed

The flow starts at **Add a device** on the setup checklist, and later from `/machines`. The person
picks a platform. Each flow has the same four beats, and each beat is detected, not declared:

| Beat | What the person does | How the dashboard knows it happened |
| --- | --- | --- |
| 1. On the tailnet | Install Tailscale and log in with **the same account** as the appliance (Q2.1) | A new node appears in the tailnet inventory the daemon already reads, owned by that account |
| 2. Joined | Run the join command in a terminal on that device (Y-387) | The join command reports back |
| 3. Reachable | Nothing | Check answers `reachable` and `sshd` green |
| 4. Ready | Press Install (Y-386) | Check answers `tmux`, `git` and `claude` green |

**Beat 1 is read on the device the person already has open.** Before it, the new device is not on
the tailnet and cannot open the dashboard. **From beat 2 the flow can move to the new device:** the
page offers *open this on the new device* — a link, and a QR code for a phone — and there the
join command is one tap to copy, on the machine that runs it.

Per platform:

| Platform | Beat 1 | Beat 2 | Beat 4 | Notes |
| --- | --- | --- | --- | --- |
| **Linux** | Tailscale's install command, then `sudo tailscale up` | the join command | Install | The whole flow works today's way, once Y-387 exists |
| **macOS** | Tailscale from the App Store or the standalone package | **Remote Login** is a switch in System Settings → General → Sharing, shown as a step; then the join command | Install needs Homebrew for `tmux` and `git`. Without it, the flow shows Homebrew's install command, or the Command Line Tools dialog for `git` | The script cannot flip Remote Login without Full Disk Access (to verify) |
| **Phone / tablet** | The Tailscale app, same account | none — it runs no session | none | It ends at *open the dashboard and add it to your home screen*. It is listed apart (Q2.3) |
| **Windows** | — | — | — | Not supported: Q4 is open and the probes refuse to compile there. The flow says so. |

### 3.3 What it costs

- **No new poll.** Beat 1 reads the inventory the daemon already refreshes; beats 2–4 are events and
  checks that Y-386 and Y-387 already produce.
- **The screens are new.** Four platforms, four beats, and each beat has a waiting state, a done
  state and a stuck state. It is the largest piece of UI in M15.

### 3.4 Questions

| # | Question | Recommendation |
| --- | --- | --- |
| Q3.1 | Does the flow detect the platform from the browser and preselect it on the new device? | Yes, and the person can change it. |
| Q3.2 | `yantra-agent` (the heartbeat) — does the flow offer it? | Not now. It joins the optional checkbox list (ADR-0028 §3). |
| Q3.3 | Are the screens drawn first in the design tool, or built straight from this table? | Drawn first: it is new UI with many states. |
| Q3.4 | Windows says *not supported yet* in the flow. Right? | Yes, until Q4 is answered. |

### 3.5 Decided

| Date | Ruling |
| --- | --- |
| 2026-09-12 | **Q3.1 yes.** The flow guesses the platform from the browser, and the person can change it. |
| 2026-09-12 | **Q3.2: the flow adds `yantra-agent`.** The join command installs it with its unit and writes its `agent.env`. The daemon serves the join command, so it knows its own address and nobody types it. This is a person running an installer, so it stays inside ADR-0028 §6 (no Yantra binary crosses **ssh**) and D2 §1 (the installer provisions). **macOS ships no launchd plist today**, so the Mac half needs one. |
| 2026-09-12 | **Q3.3: build it, and iterate as it is built.** No design pass first. |
| 2026-09-12 | **Q3.4: native Windows, not WSL2** (owner: *"i don't want wsl i want pure windows"*). Q4 is answered. tmux and `/bin/sh` are absent there, so how a session survives on Windows is research first — [Y-391](../../tracker.md). Until it lands, the flow says *Windows is coming*. |

### 3.6 Why Windows is not supported

[Q4](../../tracker.md) has been open since 2026-07-28, and the owner declined to commit to WSL2 then.
Three things stop a Windows machine being a target today:

1. **No tmux.** The agent runs as a TUI inside tmux
   ([ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md)): tmux is what survives a closed
   browser and what lets a phone and a laptop watch one session. tmux does not run on Windows itself.
2. **No `/bin/sh`.** Every command reaches a machine as base64 decoded by `/bin/sh`
   ([ADR-0006](../adr/0006-ssh-exec-transport.md), I-26). Windows OpenSSH lands in `cmd.exe` or
   PowerShell.
3. **The heartbeat does not build.** `yantra-agent`'s probes carry a `compile_error!` for any OS
   but Linux and macOS (`crates/yantra-agent/src/probes.rs:35`). This one is small.

**One reason the tracker gives is wrong.** Q4 lists the missing `ControlMaster` in Windows OpenSSH.
That limit applies when Windows is the ssh **client** ([R7](../research/07-ssh-transport.md) §8). In
Yantra the appliance is always the client, so a Windows target needs no `ControlMaster`. Q4 now
carries a correction.

**What would make it work: WSL2.** Inside WSL2 there is a real Linux, with tmux and `/bin/sh`, and
`claude` runs there. Two ways in, neither measured yet:

- **Windows OpenSSH with its default shell set to WSL.** One `sshd`, on Windows, and every command
  lands in Linux.
- **Tailscale inside WSL2.** WSL2 becomes its own node, reports itself as `linux`, and is a Linux
  target like any other. ADR-0013 §269 notes the reverse case: Tailscale on Windows reports `windows`
  while the agent runs in Linux.

**The cost of saying yes:** a Windows flow in §3.2, a WSL2 step inside it, and one measured path on
a real Windows machine. The only Windows node on this tailnet today is the second boot of a laptop
that also runs Linux ([`machines.md`](../machines.md)), so supporting Linux only costs no machine.

| # | Question | Recommendation |
| --- | --- | --- |
| Q3.4 | Windows: (a) *not supported yet* for now, (b) WSL2-only support in this milestone, or (c) native Windows? | (a) now, and (b) as its own row after M15. Native Windows means replacing tmux, which §B2 says is the signal the project is misread. |
