# D7 — The M15 screens, end to end

- **Status:** accepted by delegation, 2026-09-13. Row [Y-397](../../tracker.md).
- **The owner's instruction, 2026-09-13:** *"design end to end for all the screens we discussed to
  build. take and discuss any decisions among yourselves… you can take decisions, run tests, design
  ui. keep it according to our brand scheme, and material expressive guidelines."*
- **Scope:** the screens the owner and Claude ruled on in
  [the walk-through](../plans/m15-qa-walkthrough.md) §1–§3. These are the setup checklist, Add a
  device, the machine page, the machines list, Settings → Access, Providers and Notifications, the
  notifications list, and where they touch the dashboard.
- **Binding:** [ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md) and its brass
  amendment, [`palette-brass.json`](palette-brass.json), [R14](../research/14-material-3-expressive-on-the-web.md),
  [D3](03-dashboard-surface.md). This document changes no ADR. Where it amends D3, it says so.
- **The number:** [00-plan](00-plan.md) §7 kept D7 for a visual system that ADR-0024 settled
  without it. This document takes the number, and 00-plan §2.2 says so.

This document is in three parts. §2 ranks what is wrong today. §3 records the decisions that cut
across screens. §4 gives each screen its target design. §6 splits the work into tasks that can run
in parallel.

---

## 1. How this was measured

The dashboard ran as a production build (`vite build --mode e2e` and `vite preview`) against the
fixture daemon, inside `mcr.microsoft.com/playwright:v1.63.0-noble`, as
[`web/README.md`](../../web/README.md) describes. A throwaway spec captured 19 screen states at
phone 390, tablet 834 and desktop 1440, in light and dark: 114 full-page images. Claude read the
images one by one. The spec and its two extra scenarios were not committed.

- **Scenarios:** `firstrun`, `busy`, `nogrant` and `down` as they are. Two more were written for the
  capture: one where machines are online with ten real checks (ready, missing, refused), and one
  whose notifications hold `joined`, `installed` and `install_stopped` events.
- **Not captured:** Add a device (Y-390 has no commits yet), the Install button (Y-386 shipped the
  route, and no screen calls it) and the one-off terminal (Y-394). Their designs in §4 come from
  the walk-through §3.2, ADR-0028 and ADR-0029.
- **Contrast** was computed from the brass hexes with the WCAG 2.2 formula. Every text pair the
  screens use passes AA. The failures and near-failures are in §2.

Seven captures are kept as evidence in [`canvas/m15/`](canvas/m15/), quantised to 48 colours. The
biggest is 107 KB.

### 1.1 The three questions, screen by screen

[The QA pass](../plans/m15-qa-pass.md) §2 asks three questions of a screen. Here are the answers
today.

| Screen | What is Yantra doing for me? | Where am I? | The one next thing? |
| --- | --- | --- | --- |
| Setup checklist | Partly. The subtitle says what the page does, not what Yantra does. | Yes: `2 of 6 done` and a track. | **No.** The join command is small text inside a step. Two filled buttons (*Set up*, *New session*) outrank it, and neither is the next thing. |
| Home after a machine comes online | **No.** The checklist vanishes and an empty dashboard asks for a session that cannot start. | No. | **Wrong.** It offers *New session*. |
| Machine page | Yes, for a ready machine. | Yes. | **Wrong.** It offers *New session* on a machine with no `tmux`, no `claude`, or a refused key. |
| Machines list | Yes. | Yes. | Partly. *Doctor* re-checks. Nothing fixes. |
| Notifications | Yes. | Yes. | **No** for installs and joins: the row has no action, and the command is cut off. |
| Settings | Yes. | Yes. | Access names a command that no longer exists as a step. |

---

## 2. Findings, ranked

**Blocker:** a person cannot finish setup, or the screen says something false. **Should-fix:**
a person finishes, but the screen costs them time or trust. **Nit:** it is ugly, or it is
inconsistent.

The *Task* column points at §6.

### 2.1 Blockers

| # | Route | Size | Where | Finding | Fix | Task |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | `/` | all | `screens/dashboard/Dashboard.tsx:756` | The checklist is the home page only while **no** Linux or macOS machine is online. The moment one laptop is online — not checked, not ready, no key — the checklist vanishes. The empty dashboard then says *Nothing needs you* and offers *New session*, which would fail. The ready, refused and missing lines on the checklist are therefore never seen in practice. [Evidence](canvas/m15/home-online-not-ready-light-phone.png). | Ruling (b): the checklist is home until the key exists **and** one machine is ready. After that, it is the *Finish setup* card (§4.9). | T1 |
| B2 | `/m/$machine` | phone, tablet | `screens/machine/Machine.css:69–75`, `Sessions.tsx` error line, the tailnet-name `Mono` | The page is wider than the screen on every phone capture: 405, 418, 451 and **983 px** in a 390 px viewport, and **1082 px** on the tablet. Y-381 recorded only the 418 px case. The worst one is the ssh error line under *Sessions*, which does not wrap. [Evidence](canvas/m15/machine-offline-light-phone.png). | Give every `Mono` detail `overflow-wrap: anywhere` and every grid track `minmax(0, …)`. Below 600 px, each check is two lines (name and state, then the detail). Add an e2e assertion: `scrollWidth <= innerWidth` on every route at 390. | T3 |
| B3 | `/m/$machine` | all | `Machine.tsx:180–183`, `232–246` | The page's only filled action is *New session*, even when `tmux` or `claude` is missing or the key is refused. Nothing on the page fixes a check. There is no Install button, although `POST /api/machines/{machine}/install` shipped with Y-386. | Readiness becomes the first card, and its verdict decides the action: *Install*, *Copy the join command*, or nothing while the machine is asleep. *New session* shows only when the machine is ready (§4.3). | T3 |
| B4 | `/` (setup) | all | `screens/setup/Setup.tsx:237–244`, `280`, `290` | The one thing a new owner must do — run the join command on a machine — is body-small text in the Machines step. *Set up* (push) and *New session* are filled terracotta pills, so the eye lands on an optional step and on a step that cannot work yet. | One filled action on the page, and it is the next required thing: *Add a device*, then *Install on <machine>*, then *New session*. Everything else is tonal or text (§3.1). | T1 |
| B5 | `/` (setup) | all | `Setup.tsx:205`, `214`, `220` | Three steps draw a check icon whatever their state. *This account's ssh key* says *not yet* beside a ✓. *Machines* says *in progress* beside a ✓ on a green disc. The step contradicts itself. [Evidence](canvas/m15/setup-firstrun-dark-desktop.png). | The lead is the state: ✓ when done, the step number when not yet, a spinner ring while in progress, and a warning when it could not be read. | T1 |

### 2.2 Should-fix

| # | Route | Size | Where | Finding | Fix | Task |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | every route with a mark | all | `m3/tokens.css:105`, `:109`, `m3/mark/` | *Running* and *failed* are both filled dots, and their colours differ by **1.21:1** (dark `#D77A4E` / `#CC6656`) and **1.19:1** (light). On `/machines` an *online* chip and a *missing* check look the same. D3 §6 says form carries state, and here form does not. | *Failed* gets its own shape: a filled diamond. Running stays a dot. The hexes stay the owner's (§3.2). | T5 |
| S2 | `/machines`, `/` strip | all | `screens/machines/Machines.tsx:80`, `Dashboard.tsx:158–161` | Phones, tablets and the Windows PC are cards in the machines grid, with *Open* and *not asked yet*. The status strip counts them (`5 of 8 machines online`) and offers *Fix →* for an Android tablet. That contradicts Q2.3, which the checklist already follows. | One rule everywhere: `runsSessions` machines are *Machines*, and the rest are *Devices that open the dashboard*, listed apart and never counted (§3.4). | T4, T1 |
| S3 | `/machines`, `/`, `/m/$machine` | all | `MachineCard.tsx:87`, `Setup.tsx:91`, `Setup.css:110–112` | Every machine that is off gets a red error chip, and on the checklist its line is in the error colour. On `firstrun` that is eight red chips. An asleep laptop is normal, and the walk-through says it must not hold the owner back. | *Asleep* is the dashed *unknown* mark on a neutral chip: *asleep · 3h*. Error tone is for a machine that is online and failing: the key refused, or ssh erroring (§3.3). | T4, T1, T3 |
| S4 | `/m/$machine` | all | `Machine.tsx:225–230` | An offline machine that was never asked shows *The checks could not be read · yantrad was not reached: HTTP 404* and a filled *Try again*. The daemon *was* reached; the 404 means *not asked yet*. | A 404 here reads *Not asked yet*. For an asleep machine, add *Yantra asks again when it comes back*, and draw no button. | T3 |
| S5 | `/` (setup) | all | `Setup.tsx:110` | *Check again* is offered on a machine that is off, where ssh cannot answer. | Asleep lines draw no button. They say *last seen 1h ago*. | T1 |
| S6 | `/`, `/m/$machine`, setup | all | row actions across `Dashboard.tsx`, `Machine.tsx`, `Setup.tsx` | Terracotta is spent everywhere. The phone dashboard's *Needs you* card holds five filled terracotta pills. Every text button is terracotta too. The owner's proportion is about 5% terracotta and 8% brass, and this is well past it. | §3.1: one filled button per view. Row actions are tonal, on brass `secondary-container`. | per screen |
| S7 | `/notifications`, bell | all | `shell/notifications.ts:44`, `shell/Notifications.tsx:19`, `:33–42` | `install_stopped` reads *pi-5 install stopped*, made by `replace('_', ' ')`. Its `commands` are never drawn, the sentence is cut off on the phone, and the row offers no action. A `joined` whose `logs_in_as` differs from `user` hides that warning in cut-off text. A machine's tile is a letter avatar, the same as a workspace's. [Evidence](canvas/m15/notifications-events-dark-phone.png). | Headline, supporting line, tile and action for each kind (§4.8). | T6 |
| S8 | `/settings/notifications`, `/notifications` | all | `settings/Notifications.tsx:84–86`, `:105`, `:118`; `shell/Notifications.tsx:98` | The relay row never says whether a relay is on, although `GET /api/about` sends `relay`. The footer of the notifications list says *Push to phone is not set up* always, even with a relay working. The *Push when* rows are disabled switches, which look like controls that are broken. | Relay row: *On · the daemon holds a relay* or *Off*, read from `about.relay`. The *Push when* rows show a value (*Sent* or *Not sent*), not a switch. The footer reads the same field (§4.7). | T7, T6 |
| S9 | `/settings/access` | all | `settings/Access.tsx:58`, `ListItem` clipping | With no key yet, it says *run `yantra ssh-identity` on the appliance*. ADR-0029 and Y-388 say the key is made when the first machine joins. On the phone, three rows are cut off: *Anyone on the tailnet <tai…*, *Listen …* and the command itself. | *Made when the first machine joins*, with *Add a device*. Supporting text wraps on the phone (§4.5). | T7 |
| S10 | `/m/$machine` | phone | `Machine.tsx:168–184`, `:236`, `:241`; `setup/steps.ts:87–98` | Four things. The action row wraps unevenly: *Doctor* sits on line one and *New session* alone on line two. Check details are cut with an ellipsis, and the detail is the part that says what to do. Readiness sits below About, so the useful card is below the fold. And checks are raw ids here (`agent-cli`, `provider-auth`) where the checklist says `claude` and `gh signed in`. One word should have one meaning. [Evidence](canvas/m15/machine-mac-missing-dark-phone.png). | Readiness first. Details wrap. One name table shared by every screen (§3.5). On the phone, the header actions move into the Readiness card and an overflow menu. | T3 |
| S11 | `/` (setup) | desktop | shell sessions rail | During first run, the rail spends 300 px on *Sessions have not been read yet*. | While the checklist is the page, the rail is hidden. | T8 |
| S12 | setup, `/machines`, error pages | phone, tablet | shell FAB | The *New session* FAB floats over the checklist, over `/machines` and over *Yantra cannot be reached*. On all three it competes with the right action, or is itself the wrong one. | The FAB carries the page's one next action, or is not drawn (§3.6). | T8 |
| S13 | `/machines`, `/` | all | the *Worth a look* band | When empty, and even while it loads, the band is the largest block of colour on the page: a full tertiary-container green panel saying *Nothing unaccounted for*. The loudest thing on the page is an empty state. | Empty collapses to one line on `surface-container`, as *Idle* already does. | T4, T1 |
| S14 | `/` (setup) | phone | `Setup.css:134–140` | A machine line on the phone squeezes its words into a column about 110 px wide. That is five lines of text beside the name. | On the phone, a machine line stacks: mark, name and chip; then the words; then the action at full width. | T1 |
| S15 | every screen using state colour as text | dark | `machines__check`, `machine__check` | In dark, `--yantra-state-failed` on a container is **4.40:1** and `--yantra-state-done` is **4.11:1**. That is fine for a mark (3:1), and it fails 1.4.3 where either colours words. The light captures colour missing check names this way. | State colour goes on the mark only. Words stay `on-surface` (§3.2). | T5 |

### 2.3 Nits

| # | Route | Where | Finding | Fix | Task |
| --- | --- | --- | --- | --- | --- |
| N1 | `/notifications` | desktop | The page's title is body-sized. Every other route has a display-small `h1`. | Use the same heading as the other routes. | T6 |
| N2 | `/m/$machine` | `Sessions.tsx` | *Kill asks first; it cannot be undone…* shows on a machine with no session. | Show it only beside a Kill button. | T3 |
| N3 | `/` | status strip | *as of 0s* wraps onto two lines at 1440. | `white-space: nowrap`. | T1 |
| N4 | setup | `Setup.tsx:177` | The subtitle starts lower case (*the appliance is running;…*), where titles use sentence case. QA §13 notes the same thing about two empty states. | Sentence case (§4.1 has the new line). | T1 |
| N5 | `/` | Running band | At desktop, an empty *Running* keeps a card about 470 px tall. | Empty *Running* takes its content height. | T1 |
| N6 | `/settings/providers` | phone | Disabled *Connect* for GitLab and OpenAI looks broken, not *later*. | A value, *Later*, and no button. | T7 |
| N7 | all | `--md-sys-color-outline-variant` | Dark `#38352B` on charcoal is 1.47:1. That is fine for a divider, and not for the only edge of the outlined *Idle* band. | Give the band a tonal fill as well. | T1 |

---

## 3. Decisions that cut across screens

### 3.1 One filled button per view, and it is the next thing

A view has at most one filled (terracotta, `primary`) button. It is the one next thing. Row
actions are **tonal** (`secondary-container`, brass). Everything else is a text button. The reason
is the owner's proportion — about 5% terracotta and 8% brass — and the QA pass's third question. A
page that fills five buttons has no next thing. This is M3's own emphasis ladder (filled, tonal,
outlined, text), and it needs no new token.

On the phone and the tablet, that one action lives in the **extended FAB** when the page has one
(§3.6). That puts it in thumb reach, and M3 already reserves that place for the primary action.

### 3.2 State: form carries it, the owner's hexes colour it, words stay neutral

- The five `--yantra-state-*` hexes stay as the owner gave them. They pass 3:1 as marks on every
  surface tier.
- **Failed gets its own shape**, a filled diamond. Today it is a dot beside a running dot of almost
  the same hue (1.2:1). Unknown stays dashed and idle stays hollow. A greyscale screenshot must
  still tell all five apart, which D3 §6.1 asked for.
- **State colour is never text colour.** The words beside a mark are `on-surface` or
  `on-surface-variant`. That settles S15 without moving the owner's hexes.

### 3.3 A machine that is off is asleep, not failed

*This amends D3 §6.2's row that puts "unreachable" under `critical`. The amendment covers machines
only.*

| What the daemon knows | Mark | Chip words | Tone |
| --- | --- | --- | --- |
| The tailnet says offline | unknown (dashed) | *asleep · 3h* | neutral (`surface-container-highest`) |
| Online, never checked | idle (hollow) | *not checked* | neutral |
| Online, a basic missing | needs (filled, ochre) | *2 missing* | neutral |
| Online, the key refused, or ssh failing | failed (diamond) | *key refused* | `error-container` |
| Online, every basic present | done (filled, green) | *ready* | neutral |

**Why:** the walk-through's Q2.3 ruling says an asleep laptop does not hold the owner back. A red
chip on every closed lid tells the owner the opposite, eight times over. An error colour should
mean *you can fix this now*.

### 3.4 Machines and devices that open the dashboard

`lib/platform.ts`'s `runsSessions` is the one test, and every screen uses it.

- **Machines** are Linux and macOS. They get cards, checks, a verdict and counts.
- **Devices that open the dashboard** are phones, tablets and Windows. They are a quiet list with
  no checks and no *Fix*. They are never in a count. Windows carries a *coming soon* chip, per
  Q3.4.

### 3.5 One name per check

Every screen takes the check's name from one table. Today `steps.ts` holds such a table, and the
machine page ignores it.

| Check id | Name on screen | What fixes it |
| --- | --- | --- |
| `reachable` | ssh | the join command |
| `sshd` | sshd | the join command |
| `tmux` | tmux | Install |
| `git` | git | Install |
| `agent-cli` | claude | Install |
| `terminfo` | terminfo | `yantra fix-terminfo`, shown with Copy |
| `provider-cli` | gh | the package manager's command, shown with Copy |
| `provider-auth` | gh signed in | `gh auth login` on that machine, shown with Copy |
| `login-session` | claude signed in | `claude` on that machine, then log in |
| `heartbeat` | heartbeat | the join command's `yantra-agent` offer |

*Doctor* on a button becomes **Check again**, the checklist's word. `yantra doctor` keeps its name
in the CLI.

### 3.6 The FAB carries the page's next action

| Route | FAB |
| --- | --- |
| `/` checklist | the next required step: *Add a device*, *Install on <machine>*, or *New session* |
| `/` dashboard | *New session* (as today) |
| `/machines` | *Add a device* |
| `/m/$machine` | none; the Readiness card holds the action |
| an error page | none |

### 3.7 Motion

Expressive springs only, from the R14 §1.4 tokens that `tokens.css` already carries.

- **A beat or a step ticks:** the mark scales 0.8 → 1 on *fast spatial*, and its colour changes on
  *fast effects*. The next beat opens on *default spatial*.
- **Install progress:** an indeterminate linear `Track`. When the result lands, the Readiness card
  changes its verdict on *default effects*.
- **A sheet** (the terminal, a relay edit) opens on *default spatial*.
- **Reduced motion:** no scale and no travel. The state changes in one frame. D3 §9.3 already has
  that floor.

### 3.8 The QR code is lazy, and only in Add a device

Walk-through §3.2 asks for a QR code so a phone can open the flow. No QR library is installed.
§B1 says to take a maintained package for the browser. The build task picks a small maintained QR
encoder that renders an SVG. It loads with the Add a device route only, never on `/`, and the
task measures it against the 200 KiB ceiling before it lands.

---

## 4. The target design, screen by screen

Layouts use the shell's three form factors: phone < 600, tablet 600–1239, desktop ≥ 1240.
Components are from `web/src/m3/` unless the text names them as **new**.

### 4.1 The setup checklist — `/` on first run

**When it is the page:** while there is no workspace, and either the key does not exist or no
machine is *ready*. This is ruling (b), and B1 is the fix.

> **2026-09-13, Y-390 review:** *ready* is the seven checks a session needs, all present:
> `reachable`, `sshd`, `tmux`, `git`, `agent-cli`, `terminfo` and `login-session`. GitHub and
> `yantra-agent` are optional, so `provider-cli`, `provider-auth` and `heartbeat` do not hold it
> back. The coordinator ruled this by the owner's delegation. One function holds it,
> `web/src/lib/ready.ts`, and the home gate and beat 4 below both use it. Where this document says
> *all ten checks*, read these seven.

**The words at the top.**

> **Set up Yantra** (display-small, emphasized)
> Yantra runs AI agents on your own machines. Four steps get the first one ready, and each step
> checks itself.

**The steps.** Required steps first, then optional ones under their own label. The count counts
required steps only: *1 of 4 done*. Today GitHub and push inflate the count and compete with the
required steps.

| # | Step | Done when | Its action |
| --- | --- | --- | --- |
| 1 | The appliance is on your tailnet | `about.tailnet` is set | *Open* (text) |
| 2 | Add a machine | one machine has joined; the key's fingerprint shows here as a supporting line | **Add a device** (filled) → `/machines/add` |
| 3 | Get it ready | one machine answers all ten checks | **Install on <machine>** (filled) on the first machine that has only Install-able checks missing |
| 4 | Your first session | a workspace exists, which ends the page | **New session** (filled) |
| — | *Later, when you want them:* GitHub | a grant is held | *Connect* (tonal) |
| — | *Later:* Push to your phone | `about.relay` | *Set up* (tonal) |

The ssh key is no longer a step of its own: ADR-0029 makes it on the first join, so it is a line
under step 2.

**The machine lines** sit under step 2. They are Linux and macOS only. Devices sit apart under
*Devices that open the dashboard*, as today.

| State | Mark | Words | Action |
| --- | --- | --- | --- |
| asleep | unknown | *asleep · last seen 1h ago* | none |
| online, not checked | idle | *not checked yet* | *Check* (text) |
| key refused | failed | *the key was refused · run the join command on it* | the join command in `Copyable` |
| missing basics | needs | *missing tmux, claude* | *Install* (tonal) |
| installing | running | *installing tmux, git, claude…* | an indeterminate `Track` under the line |
| sudo blocked | needs | *tmux needs your password* | *Open terminal* (tonal), Y-394 |
| missing a manual check | needs | *gh not signed in* | *Open* → `/m/$machine` |
| ready | done | *ready · 10 of 10* | none |

**Per size.**

- **Phone:** one column. The steps are one `List` in a card. A machine line stacks into three rows
  (S14). The next action is the extended FAB (§3.6), so the inline filled button in the step
  becomes tonal. *Skip for now* is the last line.
- **Tablet:** one column, 720 max. The FAB sits in the rail, as today.
- **Desktop:** one column, 880 max, centred. The sessions rail is hidden (S11). The filled action
  sits inline in its step.

**States.** Loading: skeleton, as today. Machines not readable: `ErrorSurface.Inline` in step 2.
Daemon down: the shell's `ErrorSurface.Page`. Every step keeps its `aria-live` line.

### 4.2 Add a device — new route `/machines/add`

It is a route, not a sheet. The flow must open on the new device from a link, and a link needs a
URL. `?platform=linux|macos|mobile|windows` holds the choice. `&machine=<name>` holds the device
once beat 1 has seen it.

**Layout, at every size:** one column, 720 max. A sequence reads top to bottom, and a second column
would only hold the QR code. On the desktop and the tablet, the QR code sits to the right of beat
2's command instead.

1. **Header:** *Add a device* (display-small) and one line: *Each step ticks itself when Yantra
   sees it happen.*
2. **Platform:** `Segmented` with *Linux*, *macOS*, *Phone or tablet* and *Windows*. The browser's
   platform preselects one (Q3.1).
3. **Beats:** a vertical `Stepper`. The Stepper has only a horizontal form today, so it gains
   **`orientation="vertical"`**. Each beat has a body, and a finished beat collapses to its title
   and ✓.

| Beat | Body | Detected by | Waiting | Stuck, after 3 min | Done |
| --- | --- | --- | --- | --- | --- |
| 1 On the tailnet | Tailscale's install for this platform, and *log in as <owner>* (the appliance's Tailscale account) | a node that was not in `/api/machines` when the flow opened, with this platform's `os` | a running mark: *watching the tailnet for a new Linux machine* | *Not seen yet. Check that the device logged in to Tailscale as <owner>.*, and *Open Tailscale* | *<name> is on the tailnet* |
| 2 Joined | the join command in `Copyable`, plus *Open this on <name>* (a link and the QR code) | a `joined` event for `<name>` after the flow opened | *run this in a terminal on <name>* | *No join yet. Is `curl` there? The command must run on <name> itself.* | *joined as <user>*. When `logs_in_as ≠ user`, the needs mark and *ssh logs in as <logs_in_as>; a config you wrote was kept* |
| 3 Reachable | nothing to do | the readiness re-check the daemon runs after a join (ADR-0029 §5): `reachable` and `sshd` present | *Yantra is checking <name> over ssh* | the check's own detail, and *Check again* | *reachable over ssh* |
| 4 Ready | **Install** (filled) | `installed`, or all ten checks | *installing…* with a `Track` | from `install_stopped`: its `commands`, *Open terminal* (Y-394) and *Copy* | *ready · open a session on <name>*, with **New session** |

Per platform:

- **macOS:** beat 2 gains a first line, *Turn on Remote Login: System Settings → General → Sharing*,
  before the command. Beat 4 names Homebrew's install command when `brew` is absent (ADR-0028 §5).
- **Phone or tablet:** beat 1 only. Then a last card: *Open the dashboard on it and add it to your
  home screen*, with the link and QR code. It never shows as a machine (§3.4).
- **Windows:** no beats. One card: *Windows is coming. Today a Windows PC can open the dashboard;
  it cannot run a session yet.* It links Y-391's research once that exists.

**No *I did it* button anywhere.** That is the owner's ruling.

**Motion:** §3.7. **Errors:** a failed `/api/machines` read is inline in beat 1. A failed
notifications read is inline in beat 2 with *Try again*. A down daemon is the page surface.

### 4.3 The machine page — `/m/$machine`

Order: **header → Readiness → Workspaces → Sessions → About.** About moves last, and on the phone
it is a `Disclosure`.

**Header:** the name (display-small), the verdict chip from §3.3, and *looked 20s ago*. No actions:
they move into the Readiness card. On the desktop, *New session* stays in the header as a tonal
button, and only when the verdict is *ready*.

**The Readiness card** has a title-large verdict, not the word *Readiness*:

| Verdict | Title | Primary action | Body |
| --- | --- | --- | --- |
| ready | *Ready for sessions* | **New session** (filled) | the ten checks, folded to one line: *10 of 10 · ssh, tmux, git, claude…* |
| basics missing | *tmux and claude are missing* | **Install** (filled) | the checks, missing first |
| installing | *Installing tmux, git and claude* | none | indeterminate `Track`, *started 20s ago*, and the checks |
| sudo blocked | *tmux needs your password* | **Open terminal** (filled) | the `commands` from `install_stopped`, each in `Copyable` |
| a manual check missing | *gh is not signed in* | none | that check's line, with its command in `Copyable` (§3.5) |
| key refused | *The key was refused* | none | the join command in `Copyable` |
| asleep | *<name> is asleep* | none | *last seen 3h ago · Yantra asks again when it comes back* |
| not asked | *Not checked yet* | *Check again* (tonal) | none |

*Check again* (today's *Doctor*) is a text button in the card's corner for every verdict except
*asleep*.

**Check lines:** mark, name (§3.5), state word, then the detail wrapping below on the phone. A
missing line that has a manual fix carries its command in `Copyable`. Missing lines sort first.

**The install result.** The page reads `/api/notifications` for the newest `installed` or
`install_stopped` on this machine after the press. It then invalidates that machine's readiness.
`installed` shows a `Snackbar`: *<name> is ready*. `install_stopped` switches the card to *sudo
blocked*.

**The one-off terminal (Y-394).** *Open terminal* opens a `SideSheet` on the desktop and the tablet,
and a full-height `BottomSheet` on the phone. It holds the session terminal component, lazy as
today. Above the pane: *This runs `sudo apt-get install -y tmux` on <name>. Your password goes to
<name> as keystrokes; Yantra does not keep it.* When the command exits, the sheet says so, keeps
*Close*, and the card re-checks.

**Per size.** Phone: one column; the card's action is full width at its foot. Tablet: one column,
with the checks in two columns (name and state | detail). Desktop: Readiness and Workspaces
side by side, and Sessions and About below.

### 4.4 The machines list — `/machines`

1. **Title row:** *Machines*, *looked 40s ago*, and on the desktop *Add a device* (tonal). On the
   phone and the tablet, the FAB carries it.
2. **Machines grid** (Linux and macOS): 1, 2 or 3 columns, as today. Each card has the name, the
   verdict chip (§3.3), one line about the machine, the four card checks, and **one** action from
   the verdict: *Install* (tonal), *Copy join command*, *Check* or *Open*. The whole card links to
   `/m/$machine`, so *Open* is not a button of its own.
3. **Devices that open the dashboard:** a `List`, one line per device, with the platform and *opens
   the dashboard*. Windows gets a *coming soon* chip.
4. **Worth a look:** as today. When empty it is one line (S13).

The empty state, when no Linux or macOS node exists: *No machine can run a session yet.* with
*Add a device*.

### 4.5 Settings → Access

| Row | Today | Target |
| --- | --- | --- |
| SSH identity, none yet | *not created · run `yantra ssh-identity` on the appliance* | *Made when the first machine joins* · *Add a device* (text) |
| SSH identity, made | path, fingerprint, *Show key* | unchanged; the sheet's line becomes *The join command places this key for you. To place it by hand, add it to `~/.ssh/authorized_keys` on the machine.* |
| Who may open the dashboard | clipped on the phone | supporting text wraps |
| Listen addresses | clipped on the phone | the addresses stack, one per line |

### 4.6 Settings → Providers

Y-393's PR (#306) adds *Use your own GitHub app* as a row with an Edit sheet. Keep that design,
with three changes:

- The row sits **directly under GitHub**, in the same group. Its headline is *GitHub app*, and its
  value is *Yantra's own* or *Your own*. It is a property of the GitHub row, not a fourth
  provider.
- After a save, the row's value reads *Your own · after yantrad restarts* until the next read shows
  the new id.
- GitLab and OpenAI show *Later* as a value, not a disabled button (N6).

### 4.7 Settings → Notifications

- **Relay row:** the supporting line reads `about.relay`. *On · the daemon holds a relay and pushes
  to it*, or *Off · nothing is pushed*. After a save in this session, it adds *· saved, used after
  yantrad restarts*. *Edit* stays.
- **Push when:** three rows with a value on the right, *Sent* or *Not sent*, not a disabled
  `Switch`. The group note stays.
- **Quiet while a dashboard is open:** the value *Always*.
- **Turning the relay off** needs a route that clears it, and none exists. It is not in this design.
  The build task opens a row for it, if the owner wants one.

### 4.8 Notifications — the list, the bell popover and the phone screen

Each kind gets its own row. The tile for a machine event is an `IconTile` holding the machine
glyph, so a machine never looks like a workspace.

| Kind | Headline | Supporting | Mark | Action |
| --- | --- | --- | --- | --- |
| `joined`, and `logs_in_as` is `user` | *<machine> joined* | *as <user>* | done | *Open* → `/m/$machine` |
| `joined`, and `logs_in_as` differs | *<machine> joined, as another account* | *ssh logs in as <logs_in_as>, not <user> · a config you wrote was kept* | needs | *Open* |
| `installed` | *<machine> is ready* | *tmux, git and claude are installed* | done | *Open* |
| `install_stopped` | *<machine> needs your password* | the first command, in mono | needs | *Open terminal* (tonal, Y-394). Until Y-394 lands, *Copy command* |

The footer reads `about.relay`: *Push to your phone is on* or *…is off · Settings*. On the
desktop, the route's title is the display-small `h1` every other route uses (N1).

### 4.9 The dashboard, where setup touches it

**The *Finish setup* card.** Once the key exists and one machine is ready, the checklist stops being
home and this card appears **above** *Needs you* until the optional steps are done:

- `surface-container-high`, the card radius (28), and a title-large *Finish setup*.
- A `Track` for the whole checklist, and one line per step still open: GitHub (*Connect*, tonal),
  Push to your phone (*Set up*, tonal) and *Add another device* (text).
- *Hide* (text) keeps it hidden on this device, in the preferences key ADR-0024 §5 already uses.

**The status strip:** it counts machines only (§3.4). *Fix →* becomes *Open*, and asleep machines
read *asleep 3h*, not *unreachable*.

---

## 5. Components

**Reused as they are:** `Button` (filled, tonal, text), `Fab` (extended), `Copyable`, `Track`,
`Segmented`, `List`, `ListItem`, `Card`, `Chip`, `Mark` and `State`, `SideSheet`, `BottomSheet`,
`Disclosure`, `Snackbar`, `ErrorSurface`, `Skeleton`, `IconTile`, and the session `Terminal`.

**Changed:**

- `Stepper` gains `orientation="vertical"`, with a body per step and a *stuck* state beside
  *done*, *current* and *ahead*.
- `Mark` gains the diamond form for *failed* (§3.2).

**New:**

- A QR code component, lazy, in the Add a device route only (§3.8).
- The check name table, one module shared by setup, the machines list and the machine page (§3.5).

---

## 6. Build tasks

Each task names the files it owns. Two tasks that own no file in common can run at the same time.
**T9 goes first**, or in the same hour, because every other task's tests need its fixture.

| Task | What | Owns | Row | Waits on |
| --- | --- | --- | --- | --- |
| **T9** | The fixture learns install and join: `POST …/install` answering 202 and then an `installed` or `install_stopped` event, `joined` events, and a `setup` scenario with ready, missing, refused and asleep machines | `web/e2e/fixture/server.mjs`, `web/e2e/fixture/scenarios/setup.json` | new | — |
| **T1** | The checklist and home: B1, B4, B5, S5, S14, N3–N5, N7, the *Finish setup* card, and the strip's counts (§4.1, §4.9) | `web/src/screens/setup/*`, `web/src/screens/dashboard/*` | **Y-390** (in flight) | T9 |
| **T2** | Add a device (§4.2), the vertical `Stepper`, and the QR code | `web/src/screens/add-device/*` (new), `web/src/router.ts`, `web/src/m3/stepper/*`, `web/src/lib/platform.ts` | **Y-390** (in flight) | T9, T3's install mutation |
| **T3** | The machine page: B2, B3, S4, S10, N2, the Install button and its result (§4.3), and the check name table | `web/src/screens/machine/*`, `web/src/screens/machines/Doctor.tsx`, `web/src/lib/checks.ts` (new), `web/src/api/mutations.ts` (the install mutation) | **Y-396** (in flight) and Y-381 | T9 |
| **T3b** | The one-off terminal sheet | `web/src/screens/machine/SudoSheet.tsx` (new), the daemon route | **Y-394** | T3 |
| **T4** | The machines list: S2, S3, S13 on `/machines`, devices apart, verdict chips and card actions (§4.4) | `web/src/screens/machines/Machines.tsx`, `MachineCard.tsx`, `facts.ts`, `Machines.css`, `Unclaimed.tsx` | new | T3's `checks.ts` and install mutation |
| **T5** | The failed diamond and state colour off text (S1, S15, §3.2) | `web/src/m3/mark/*`, the `machines__check` and `machine__check` colour rules | new | — (a one-line CSS merge with T3 and T4) |
| **T6** | Notifications: S7, N1, and the footer half of S8 (§4.8) | `web/src/shell/notifications.ts`, `web/src/shell/Notifications.tsx`, `Notifications.css`, `NotificationsScreen.tsx` | new | T9 |
| **T7** | Settings: S8's relay row, S9, N6, and §4.6's changes to Y-393 | `web/src/screens/settings/Access.tsx`, `Notifications.tsx`; `Providers.tsx` **only after #306 merges** | new; the Providers part rides on Y-393 | #306 for Providers |
| **T8** | The shell: the FAB per route (§3.6) and no rail during setup (S11, S12) | `web/src/shell/*` except the notification files | new | T1's *is setup the page* export |

**What runs in parallel now:** T9, T5, T6 and T7 (Access and Notifications). Then T1, T3 and T8.
Then T2 and T4, which need T3's mutation and name table. T3b follows T3.

**Verification, for every task:** e2e at 390, 834 and 1440, in light and dark, with axe `wcag22aa`.
Add `scrollWidth <= innerWidth` on every route (B2). Take a greyscale screenshot of one page that
shows all five marks (S1). Test every waiting, done and stuck state of every beat, as Y-390's row
requires.
