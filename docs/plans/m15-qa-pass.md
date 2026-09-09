# M15 — the QA pass

**Owner's ask, 2026-09-09: *"what works, what doesn't, how good is the UI/UX, onboarding, empty
states"*, and then *"ease of use, setup checklist, how easy it is to sync up devices."*** This is
the script for that. It is written to be walked, not read.

Everything before this document was measured by a test. This is the first pass where a person
uses Yantra and says whether it is any good. The two questions are different, and a green suite
answers only the first one.

## How to use it

Each check is one line: what you do, then what should happen.

- `[x]` it works.
- `[ ]` you did not get to it.
- `[!]` it is wrong — **add a row to §14** and keep going. Do not stop to fix.

Every section ends with a **Feel** line. Give it 1–5 and one sentence. 3 means *usable and dull*.
That line is the point of the pass — the boxes say what works, the Feel says whether it is good.

**§12 is the ease-of-use section and it is counts, not opinions.** Keep a tally as you walk:
every time you drop to a shell, every time you open the docs, every time you do not know what to
do next. Those three numbers say more than any score. Start counting at §1.

Read §13 before you start. Twelve things are already known to be wrong and are already tracked;
finding one again costs you time and tells us nothing.

---

## 0. What the pass needs

- [ ] An always-on Linux box on the tailnet, `aarch64` or `x86_64`, with nothing of Yantra on it.
- [ ] At least two other machines on the tailnet, one of them **off** or asleep. The off machine
      is not optional — half of what this pass checks is what the dashboard says about a machine
      that does not answer.
- [ ] **One machine you have not prepared at all.** §3 is about turning it into a usable one, and
      that section is worthless if the machine is already set up.
- [ ] A phone and an iPad on the same tailnet. **M14 does not close without this.**
- [ ] A repository on GitHub you do not mind cloning.

Record the box: architecture, OS, and how you reach it. `http://<tailscale-ip>:7717`.

**Start the tally.** Shell drops: ____ · Doc lookups: ____ · Dead ends: ____

---

## 1. The install

The first release `install.sh` can install. It has been inert since #282 by design.

- [ ] `curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash`
      → it resolves v0.2.0 on its own. **You name no version.**
- [ ] It prints the checksum it verified. → the archive is checked before anything is written.
- [ ] It creates the `yantra` account and installs three binaries to `/usr/local/bin`.
- [ ] `/etc/systemd/system/yantrad.service` and `yantra-agent.service` are there.
      → **these came out of the archive, not off the internet.** That is Y-365's whole point.
- [ ] It enables nothing and starts nothing. → it ends with a numbered list of what is left.
- [ ] Run it a second time. → it says `/etc/yantra/agent.env` was already there and left alone.
- [ ] `YANTRA_VERSION=v0.1.0 … | bash` → it refuses by name: *"carries no units"*. Nothing installs.
- [ ] Now run `provision.sh`. → it starts what it can and prints the rest as numbered steps.
- [ ] `systemctl status yantrad` → active, running as `yantra`.
- [ ] `sudo -u yantra -H /usr/local/bin/yantra ssh-identity` → it prints a public key to place.

**Time from the first command to a running daemon:** ____ min · **Shell commands you ran:** ____

**Feel /5** — could a person who did not write this follow it? _____

---

## 2. The setup checklist — onboarding

Open `http://<tailscale-ip>:7717` on the desktop. A fleet with no workspace and no machine
answering draws the setup checklist **instead of** the dashboard (D3 §4.8). Judge this section
hardest. It is the only screen a new user is guaranteed to see.

**Before you touch anything, look at it for ten seconds.** Then answer:

- Do you know what Yantra is going to do for you?
- Do you know how many steps there are and where you are in them?
- Is there one obvious thing to do next, or four things competing?

Then walk the four steps.

- [ ] The checklist is the page. There is no empty dashboard behind it.
- [ ] **Tailnet** → names your tailnet and says HTTP or HTTPS.
- [ ] **The ssh key** → before §1's last step it says *not created yet* and names the command.
      After it, the fingerprint.
      → **it names a command you must run in a terminal.** Count that as a shell drop. Should the
        dashboard be able to press this button itself?
- [ ] **GitHub** → *not connected*. Start the sign-in. → the device flow, then *signed in as you*.
      → does it tell you what GitHub is for **before** you sign in, or after?
- [ ] **Machines** → *not checked yet*. Press Check. → it asks a machine over ssh and counts.
- [ ] Leave one machine's `authorized_keys` empty. → it says *refused*, and offers the
      `authorized_keys` line **with your real key in it**.
- [ ] Copy that line. → it copies. On the phone too.
- [ ] Every step goes green. → the checklist gets out of the way and the dashboard appears.

**Then the question that matters:** the checklist told you a thing was wrong. Did it tell you how
to fix it **and could you fix it from where you were standing**? For each of the four steps:

| Step | Told you what is wrong? | Told you how to fix it? | Could you fix it here? |
| --- | --- | --- | --- |
| [ ] Tailnet |  |  |  |
| [ ] ssh key |  |  |  |
| [ ] GitHub |  |  |  |
| [ ] Machines |  |  |  |

**Time from opening the dashboard to every step green:** ____ min
**Times you had to leave the dashboard:** ____

**Feel /5** ____ · **The worst step was:** ____________________

---

## 3. Syncing a machine into the fleet

Take the machine you prepared nothing on. This is the section the owner asked for, and it is the
one nobody has walked.

**What is free.** A machine appears the moment Tailscale sees it. `online` is read from the
tailnet inventory, not from anything Yantra installs. So the fleet list needs nothing from you.

**What is not free.** Nine checks decide whether that machine is *usable*: `reachable`, `sshd`,
`tmux`, `agent-cli`, `terminfo`, `provider-cli`, `provider-auth`, `login-session`, `heartbeat`.

- [ ] The unprepared machine appears in `/machines` on its own, with no checks read.
- [ ] Press Check. → it reports all nine, and names what is absent rather than saying *failed*.
- [ ] Read the nine lines. **For each one, ask: does it tell me the command that fixes it?**
- [ ] Settings → Access → **Show key** → **Copy**. Paste it into that machine's
      `authorized_keys`. Check again. → `reachable` and `sshd` go green.
- [ ] Install `tmux` on it. Check again. → one more goes green.
- [ ] Install the agent CLI on it. Check again.
- [ ] `yantra fix-terminfo` for `terminfo`. → **does the dashboard mention this verb exists?**
- [ ] Install `gh` and sign it in for `provider-cli` and `provider-auth`.
- [ ] `login-session` — do you understand what it is asking for from the dashboard alone?
- [ ] `heartbeat` stays *unknown* until `yantra-agent` runs there. Install it:
      - **Linux** → `install.sh`, then `YANTRA_DAEMON=<appliance ip>:7717` in
        `/etc/yantra/agent.env`, then `systemctl enable --now yantra-agent`.
        → **note that this also installs `yantrad` and `yantra` on a box that needs neither.**
      - **macOS** → the archive holds `yantra-agent`, a README and a LICENSE. **There is no
        installer and no launchd plist.** Do it by hand and record how long it takes.
- [ ] Now open a session on that machine from `/new`. → it works end to end.

**Count it.** Steps to take one bare machine to all-green: ____ · Shell commands: ____ ·
Times you had to look something up: ____ · Minutes: ____

**Then the design question, and answer it honestly.** How many of the nine checks could you fix
**without leaving the dashboard**? ____ / 9.

If the answer is zero, that is [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md)
working exactly as written — no binary, unit or script crosses ssh to a machine, ever. The
prohibition is not up for review. **What is up for review is whether the dashboard makes the
manual path pleasant**: the right command, on the right machine, ready to copy, in the place you
are already looking. Say which of the nine fell short of that.

**Feel /5** ____ · **The step that made you want to give up:** ____________________

---

## 4. The core loop

This is the product. Everything else is furniture.

- [ ] **New session** — press it from the dashboard.
- [ ] Pick a machine → the list shows only machines that answered.
- [ ] Pick a repository → your GitHub repos, newest push first. And a local directory instead.
- [ ] Name it, pick an agent, start. → the progress stages are honest about which one is running.
- [ ] It clones, opens a tmux session, and starts the agent.
- [ ] The workspace appears on the dashboard, in the right band.
- [ ] Open it → `/w/$name`. The transcript is there. The spend is there.
- [ ] Open the terminal → `/m/$machine/s/$session`. **Type in it.** Keys reach tmux.
- [ ] Resize the window → the pane reflows and the mono cell measures right.
- [ ] Close the tab, reopen it → the socket reconnects and you are back in the same session.
- [ ] Stop it from the dashboard. → the agent gets its chance to shut down.
- [ ] Delete the workspace while the session is open. → it refuses, and says why.
- [ ] Run `yantra up X` twice → the second attaches. It does not open a second session. (§B4.)

**Time from opening the dashboard to an agent running:** ____ min · **Taps or clicks:** ____

**Feel /5** ____

---

## 5. Empty states

Thirteen of them. They are the first thing a new user sees and the last thing anyone tests.
Reach each with nothing in it and read the words out loud.

| Where | What it should say |
| --- | --- |
| [ ] Dashboard, no workspaces | `no workspaces yet` |
| [ ] Dashboard, none idle | `Nothing is idle` |
| [ ] Dashboard, none running | `Nothing is running` |
| [ ] Fleet, no workspaces | `no workspaces yet` |
| [ ] Fleet, GitHub not connected | `GitHub not looked at yet` |
| [ ] Fleet, nothing waiting | `Nothing needs you` |
| [ ] Machines, no stray sessions | `Nothing unaccounted for` |
| [ ] Machines, never checked | `Nothing read yet` |
| [ ] Machine page, no sessions | `No session is open here` |
| [ ] Machine page, no workspace | `No workspace lives here` |
| [ ] Usage, no spend | `No spend yet` / `Nothing was counted` |
| [ ] Usage, no model named | `No model was named` |
| [ ] Session, no transcript | `No transcript answered` |

For each one, three questions:

- Does it say **why** it is empty, or only **that** it is?
- Does it offer the next action, and is that action right there?
- Would you know the difference between *empty* and *broken*?

**Feel /5** ____ · **The emptiest-feeling screen was:** ____________________

---

## 6. Every screen with something in it

- [ ] `/` **Dashboard** — bands, the status strip, the reorder pill, the stamp.
- [ ] `/fleet` **Fleet** — the work waiting, GitHub issues and reviews among it.
- [ ] `/machines` **Machines** — every machine, its checks, the sessions no workspace claims.
- [ ] `/m/$machine` **Machine** — one machine, its sessions, Doctor.
- [ ] `/m/$machine/s/$session` **Terminal** — the live pane.
- [ ] `/usage` **Usage** — spend, by workspace and by model.
- [ ] `/w/$name` **Session** — the transcript, status, tokens.
- [ ] `/w/$name/repair` **Repair** — reach it by breaking a workspace file (§10).
- [ ] `/new` **New session**.
- [ ] `/settings` and `/settings/$category` — §7.
- [ ] `/notifications` — the events the daemon held.
- [ ] `/m3` — the component gallery. Not linked from anywhere; type the URL.
- [ ] A route that does not exist → a 404 that looks like it was designed.

**Feel /5** ____ · **The best screen:** __________ · **The worst:** __________

---

## 7. Settings — seven categories

Two groups: **Workspace** is what the dashboard does, **Appliance** is the daemon itself.

- [ ] **General** — where clones land, what a new session assumes. Change one, reload, it held.
- [ ] **Notifications** — the relay. Write one, send the test message, **watch your phone**.
- [ ] **Providers** — GitHub is Yantra's own sign-in; agents use each machine's.
      → is that distinction clear, or does it read as one thing?
- [ ] **Agents** — what a session can start.
- [ ] **Appearance** — theme, seed colour, density, time format.
  - [ ] Light / Dark / System. **The three segments are the same width** (fixed in #287).
  - [ ] The custom hex field does not collide with its own label (fixed in #287).
  - [ ] Type a bad hex → it says so and does not apply a broken colour.
  - [ ] Set System, then change the OS theme → the dashboard follows without a reload.
- [ ] **Access** — the key the daemon holds, and who can reach the dashboard. **There is no login.**
      → does it say that clearly enough that you are not alarmed?
- [ ] **About** — version, target, build date, listen addresses, the tailnet.
      → **it should now say 0.2.0.**

**Feel /5** ____ · **Anything here you could not find?** ____________________

---

## 8. The shell

- [ ] `⌘K` / `Ctrl-K` → the palette opens. Type a machine, a workspace, a screen. `Esc` closes it.
- [ ] The sessions rail — is it useful, or is it a list you ignore?
- [ ] The bell → the popover on desktop, the sheet on phone, the screen at `/notifications`.
- [ ] Your avatar → **Settings and About take a hover state** (fixed in #287) and both work.
- [ ] Tab through a whole screen with the keyboard. → the focus ring is always visible and never
      trapped.
- [ ] Announce — trigger the same error twice. → a screen reader says it both times.

**Feel /5** ____

---

## 9. Your own devices

Two halves. The first is whether each device works. The second is whether they know about each
other, and that half has a known answer you should still feel for yourself.

### 9.1 Does each one work

**M14 does not close until this is done on real hardware.** The e2e suite runs 390, 834 and
1440 px, and a browser window at 390 px is not a phone.

- [ ] **Phone, portrait** — every screen in §6. Nothing scrolls sideways.
- [ ] **Phone, landscape.**
- [ ] **iPad, portrait and landscape.**
- [ ] **Desktop.**
- [ ] The terminal on the phone → can you actually type in it? Does the keyboard cover the pane?
- [ ] Rotate the device with a session open → the shell keeps its tree (Y-361).
- [ ] Every tap target is big enough for a thumb.
- [ ] Read the dashboard one-handed, standing up. → is that a thing you would do?

**Feel /5 phone** ____ · **/5 iPad** ____ · **/5 desktop** ____

### 9.2 What travels between them, and what does not

**Nothing does, and that was decided rather than overlooked.**
[ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md) decision 5 puts Appearance
(theme, density, seed) and General (clone home, default machine, time format) in one `localStorage`
key, and ends: *"The boards' 'on every device you sign in from' becomes 'on this device'."* The
marker for which notifications you have read rides the same key by the same reasoning, although
the decision does not name it. Server-held preferences are in that ADR's rejected list, with the
reason: *a third bend of persists nothing for a colour.*

**The boards promised this and the ADR took it back. You are the person who finds out what that
costs.**

Walk it anyway, because reading that sentence and feeling it are different things.

- [ ] Set **dark** and a custom seed colour on the desktop. Open the phone.
      → sage, and system theme. Set it again there.
- [ ] Set a **default machine** and a clone home on the desktop. Open `/new` on the phone.
      → it does not know.
- [ ] **Read your notifications on the phone.** Open the desktop.
      → still unread. This is the one that will annoy you.
- [ ] Set the time format to `clock` on one device only, and look at both.
- [ ] Open the same live session on the phone and the desktop at once. → **the session itself is
      shared**, because it lives in tmux on a machine. Only the browser's opinions are not.
- [ ] Clear the phone's site data, or open a private window. → every preference is gone.

**Then decide, because this is a decision and not a bug.** Three preferences are genuinely
per-device — theme by ambient light, density by screen size, and arguably the time format. Three
are not: the clone home, the default machine and the read marker describe *you*, and you have one
of you.

- **Which of the six should follow you between devices?** ____________________
- **Is `seenAt` the one that has to?** A notification you cleared on the phone greeting you on
  the desktop is either a small annoyance or the reason you stop trusting the bell. Which? ____
- **How annoyed were you, 1–5?** ____

If the answer is that some should travel, that is a new row and probably an ADR-0024 amendment:
the daemon persists nothing about the fleet today, so where they would live is a real question,
not a small one.

**Feel /5** ____

---

## 10. When things go wrong

Failure paths are a design surface. Break each one on purpose.

- [ ] `sudo systemctl stop yantrad` with the dashboard open → *"Nothing here can be reached"*,
      naming both unknowns: off the tailnet, or yantrad down. Start it again → it recovers on
      its own, without a reload.
- [ ] Turn a machine off → the dashboard says unreachable **and how long since it was last seen**.
- [ ] Take the key out of a machine's `authorized_keys` → *refused*, with the remedy.
- [ ] Break a workspace file: `sudo -u yantra sh -c 'echo "{" > ~/.config/yantra/workspaces/x.json'`
      → the workspace does not vanish. It offers Repair.
- [ ] Disconnect the GitHub grant → the surfaces that need it degrade; the rest keeps working.
- [ ] Kill the terminal's socket (turn off wifi for five seconds) → it says it is reconnecting,
      then reconnects.
- [ ] Pull the tailnet on the phone mid-session → the error names the tailnet, not a stack trace.

**For every error above:** does it say what happened, and what you can do? An error that says
only *"failed"* is a `[!]` even when the behaviour is right.

**Feel /5** ____

---

## 11. The CLI

`yantra` is the other half, and the dashboard touches none of it.

- [ ] `yantra --version` → **0.2.0**.
- [ ] `yantra doctor` → says what each machine can and cannot do. It changes nothing.
- [ ] `yantra ls machines` · `ls sessions` · `ls workspaces` · `ls work` · `ls repos`.
- [ ] `yantra attach` from a terminal → keys reach the agent.
- [ ] `yantra logs` · `status` · `tokens` on a live workspace.
- [ ] `yantra down X` → the agent gets its chance to stop.
- [ ] `yantra --help` → is it readable? Do the verbs mean what you expect?
- [ ] Run something against a machine that is off → a sentence, not a panic.
- [ ] **Name three things the CLI can do that the dashboard cannot**, and say whether any of them
      should move: ____________________

**Feel /5** ____

---

## 12. Ease of use — the counts

Opinions are in the Feel lines. This section is numbers, and it is the section to fill in even if
you skip others.

| Count | Value |
| --- | --- |
| Minutes from `curl \| bash` to a running agent | |
| Times you dropped to a shell **because the dashboard could not do it** | |
| Times you dropped to a shell **because you did not know it could** | |
| Times you opened the docs or asked someone | |
| Times you did not know what to do next | |
| Times something happened and nothing told you | |
| Times you pressed something and nothing happened | |
| Taps to open a running session from a cold phone | |
| Taps to start a new session from a cold phone | |

The second and third rows are the important pair. The second is missing capability. The third is
missing signposting, and it is much cheaper to fix.

Then three sentences:

- **The thing you did most often was:** ____________________
- **The thing that took longest for no good reason was:** ____________________
- **If you could fix one thing before anyone else sees this:** ____________________

---

## 13. Already known — do not re-report

Twelve open rows. Finding one again costs you time and tells us nothing new.

| Row | What you will see |
| --- | --- |
| Y-372 | The appliance re-sends the whole dashboard on every open: 272 kB three times where it should be 5 kB. **Deferred past the tag by you, and the tag is cut.** |
| Y-381 | `/m/$machine` lays out 418 px wide inside a 390 px viewport. And `.fleet__detail` draws in the plain face, not mono. |
| Y-375 | Account, the bell popover and the notifications sheet load on every page although they claim to be lazy — 45 kB. |
| Y-373 | Usage cannot split spend per model in a two-model workspace: the daemon does not send the token counts. |
| Y-376 | New session is a page, not the modal the boards drew. |
| Y-371 | The Disclosure costs 3.6 kB for one animation. |
| Y-374 | `npm test` times out under its own load. Test-only. |
| Y-377 | `console.spec.ts` never reaches `networkidle`. Test-only. |
| Y-378 | The screenshot threshold hides a changed word. Test-only. |
| Y-367 | The dashboard does **not** yet say a newer release exists. Not built. |
| Y-368 | Applying an update from the dashboard. Not built. |
| — | Two empty states are lowercase (`no workspaces yet`) where the other eleven are sentence case. Found while writing this document, not yet a row. |

**Known and by design, so weigh it rather than report it:**

- **No preference follows you between devices** (§9.2). ADR-0024 §5.
- **Nothing Yantra installs crosses ssh to a machine** (§3). ADR-0013. Every fleet-wide action is
  refused by that ADR, not missing by oversight.
- **There is no login.** The tailnet is the door.

---

## 14. What you found

Add a row as you go. Do not stop to fix anything.

| # | Where | What happened | What you expected | Sev |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |

**Sev:** `blocker` — the release is wrong and should be pulled. `major` — a person hits this and
gives up. `minor` — it is wrong and they carry on. `nit` — it is ugly.

A row here becomes a `Y-NNN` in `tracker.md` after the pass, not during it.

## 15. The verdict

Three sentences when you are done. Not a list.

- **What works:** ____________________
- **What does not:** ____________________
- **Would you use this every day?** ____________________
