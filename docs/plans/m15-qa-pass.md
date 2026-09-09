# M15 — the QA pass

**Owner's ask, 2026-09-09: *"what works, what doesn't, how good is the UI/UX, onboarding, empty
states."*** This is the script for that. It is written to be walked, not read.

Everything before this document was measured by a test. This is the first pass where a person
uses Yantra and says whether it is any good. The two questions are different, and a green suite
answers only the first one.

## How to use it

Each check is one line: what you do, then what should happen.

- `[x]` it works.
- `[ ]` you did not get to it.
- `[!]` it is wrong — **add a row to §12** and keep going. Do not stop to fix.

Every section ends with a **Feel** line. Give it 1–5 and one sentence. 3 means *usable and dull*.
That line is the point of the pass — the boxes say what works, the Feel says whether it is good.

Read §11 before you start. Twelve things are already known to be wrong and are already tracked;
finding one again costs you time and tells us nothing.

---

## 0. What the pass needs

- [ ] An always-on Linux box on the tailnet, `aarch64` or `x86_64`, with nothing of Yantra on it.
- [ ] At least two other machines on the tailnet, one of them **off** or asleep. The off machine
      is not optional — half of what this pass checks is what the dashboard says about a machine
      that does not answer.
- [ ] A phone and an iPad on the same tailnet. **M14 does not close without this.**
- [ ] A repository on GitHub you do not mind cloning.

Record the box: architecture, OS, and how you reach it. `http://<tailscale-ip>:7717`.

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
- [ ] Follow its four steps. `sudo systemctl enable --now yantrad.service yantra-agent.service`.
- [ ] `systemctl status yantrad` → active, running as `yantra`.
- [ ] `sudo -u yantra -H /usr/local/bin/yantra ssh-identity` → it prints a public key to place.

**Feel /5** — could a person who did not write this follow it? _____

---

## 2. The first run — onboarding

Open `http://<tailscale-ip>:7717` on the desktop. A fleet with no workspace and no machine
answering draws the setup checklist **instead of** the dashboard (D3 §4.8).

- [ ] The checklist is the page. There is no empty dashboard behind it.
- [ ] **Tailnet** → names your tailnet and says HTTP or HTTPS.
- [ ] **The ssh key** → before §1's last step, it says *not created yet* and names the command.
      After it, the fingerprint.
- [ ] **GitHub** → *not connected*. Start the sign-in. → the device flow, then *signed in as you*.
- [ ] **Machines** → *not checked yet*. Press Check. → it asks a machine over ssh and counts.
- [ ] Place the key on one machine, leave it off another. → the refused one says so plainly, and
      offers the `authorized_keys` line **with your real key in it**, ready to copy.
- [ ] Copy that line. → it copies. On the phone too.
- [ ] Every step goes green. → the checklist gets out of the way and the dashboard appears.

**Ask yourself:** did you ever have to guess what to do next? Did any step tell you a thing was
wrong without telling you how to fix it?

**Feel /5** ____ · **The worst step was:** ____________________

---

## 3. The core loop

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

**Feel /5** ____ · **How long from opening the dashboard to an agent running?** ____ min

---

## 4. Empty states

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

## 5. Every screen with something in it

- [ ] `/` **Dashboard** — bands, the status strip, the reorder pill, the stamp.
- [ ] `/fleet` **Fleet** — the work waiting, GitHub issues and reviews among it.
- [ ] `/machines` **Machines** — every machine, its checks, the sessions no workspace claims.
- [ ] `/m/$machine` **Machine** — one machine, its sessions, Doctor.
- [ ] `/m/$machine/s/$session` **Terminal** — the live pane.
- [ ] `/usage` **Usage** — spend, by workspace and by model.
- [ ] `/w/$name` **Session** — the transcript, status, tokens.
- [ ] `/w/$name/repair` **Repair** — reach it by breaking a workspace file (§9).
- [ ] `/new` **New session**.
- [ ] `/settings` and `/settings/$category` — §6.
- [ ] `/notifications` — the events the daemon held.
- [ ] `/m3` — the component gallery. Not linked from anywhere; type the URL.
- [ ] A route that does not exist → a 404 that looks like it was designed.

**Feel /5** ____ · **The best screen:** __________ · **The worst:** __________

---

## 6. Settings — seven categories

Two groups: **Workspace** is what the dashboard does, **Appliance** is the daemon itself.

- [ ] **General** — where clones land, what a new session assumes. Change one, reload, it held.
- [ ] **Notifications** — the relay. Write one, send the test message, **watch your phone**.
- [ ] **Providers** — GitHub is Yantra's own sign-in; agents use each machine's.
- [ ] **Agents** — what a session can start.
- [ ] **Appearance** — theme, seed colour, density, time format.
  - [ ] Light / Dark / System. **The three segments are the same width** (fixed in #287).
  - [ ] The custom hex field does not collide with its own label (fixed in #287).
  - [ ] Type a bad hex → it says so and does not apply a broken colour.
  - [ ] Set System, then change the OS theme → the dashboard follows without a reload.
- [ ] **Access** — the key the daemon holds, and who can reach the dashboard. **There is no login.**
      → does it say that clearly enough that you are not alarmed?
- [ ] **About** — version, target, build date, what it is listening on, the tailnet.
      → **it should now say 0.2.0.**

**Feel /5** ____ · **Anything here you could not find?** ____________________

---

## 7. The shell

- [ ] `⌘K` / `Ctrl-K` → the palette opens. Type a machine, a workspace, a screen. `Esc` closes it.
- [ ] The sessions rail — is it useful, or is it a list you ignore?
- [ ] The bell → the popover on desktop, the sheet on phone, the screen at `/notifications`.
- [ ] Your avatar → **Settings and About take a hover state** (fixed in #287) and both work.
- [ ] Tab through a whole screen with the keyboard. → the focus ring is always visible and never
      trapped.
- [ ] Announce — trigger the same error twice. → a screen reader says it both times.

**Feel /5** ____

---

## 8. Three form factors

**M14 does not close until this section is done on real hardware.** The e2e suite runs 390, 834
and 1440 px, and a browser at 390 px is not a phone.

- [ ] **Phone, portrait** — every screen in §5. Nothing scrolls sideways.
- [ ] **Phone, landscape.**
- [ ] **iPad, portrait and landscape.**
- [ ] **Desktop.**
- [ ] The terminal on the phone → can you actually type in it? Does the keyboard cover the pane?
- [ ] Rotate the device with a session open → the shell keeps its tree (Y-361).
- [ ] Every tap target is big enough for a thumb.
- [ ] Read the dashboard one-handed, standing up. → is that a thing you would do?

**Feel /5 phone** ____ · **/5 iPad** ____ · **/5 desktop** ____

---

## 9. When things go wrong

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

## 10. The CLI

`yantra` is the other half, and nothing above touches it.

- [ ] `yantra --version` → **0.2.0**.
- [ ] `yantra doctor` → says what each machine can and cannot do. It changes nothing.
- [ ] `yantra ls machines` · `ls sessions` · `ls workspaces` · `ls work` · `ls repos`.
- [ ] `yantra up X` **twice** → the second attaches. It does not open a second session. (§B4.)
- [ ] `yantra attach` from a terminal → keys reach the agent.
- [ ] `yantra logs` · `status` · `tokens` on a live workspace.
- [ ] `yantra down X` → the agent gets its chance to stop.
- [ ] `yantra --help` → is it readable? Do the verbs mean what you expect?
- [ ] Run something against a machine that is off → a sentence, not a panic.

**Feel /5** ____

---

## 11. Already known — do not re-report

Twelve open rows. Finding one of these again costs you time and tells us nothing new.

| Row | What you will see |
| --- | --- |
| [Y-372](../../tracker.md) | The appliance re-sends the whole dashboard on every open: 272 kB three times where it should be 5 kB. **Deferred past the tag by you.** |
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

**Not built at all, so do not look for it:** any fleet-wide action. ADR-0013 stands — no binary,
unit or script crosses ssh to a machine.

---

## 12. What you found

Add a row as you go. Do not stop to fix anything.

| # | Where | What happened | What you expected | Sev |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |

**Sev:** `blocker` — the release is wrong and should be pulled. `major` — a person hits this and
gives up. `minor` — it is wrong and they carry on. `nit` — it is ugly.

A row here becomes a `Y-NNN` in `tracker.md` after the pass, not during it.

## 13. The verdict

Three sentences when you are done. Not a list.

- **What works:** ____________________
- **What does not:** ____________________
- **Would you use this every day?** ____________________
