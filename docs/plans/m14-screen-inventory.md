# M14 — the screen inventory: 65 artboards against the product

- **Date:** 2026-09-06
- **Status:** evidence for [m14-the-material-dashboard.md](m14-the-material-dashboard.md)
- **Sources:** every `docs/design/canvas/*.dc.html` (text read, not guessed from filenames),
  `canvas.json`, `BRIEF.md`, and the whole of `web/src`.

Form factor: **D** desktop 1440×1024, **T** tablet 834×1194, **P** phone 390×844, **E** ESP32
(out of scope, Y-336).

## A. 65 boards in 34 screen groups

| # | Group | File | FF | Draws | Covered today by |
|---|---|---|---|---|---|
| 1 | **Dashboard** | `Main` | D | Sessions rail (Live/History) + bento: machines strip, hero "Needs you 3", Running, Worth a look, Idle collapsed | `routes/Fleet.tsx` bands, `Attention.tsx`, `Footer.tsx`; no rail, no bento |
| | | `MainDark` | D | Same, dark roles | none |
| | | `MainCompact` | D | Compact metrics; Idle expanded; **Recent** card (last 5 session events) | none |
| | | `TabletDashboard` | T | Nav rail + FAB, one-column bento | none |
| | | `PhoneDashboard` | P | Top app bar, bottom nav, FAB, vertical feed, Idle disclosure | none |
| 2 | **Dashboard, empty** | `EmptyDashboard`, `TabletEmptyDashboard`, `PhoneEmptyDashboard` | D T P | "No sessions yet" + New session | `Setup.tsx` when zero workspaces; `ui/empty` |
| 3 | **Notifications** | `NotificationsPopover` | D | Popover: Mark all read, Unread/All, Today/Earlier, rows with Answer, footer relay status | none |
| | | `TabletNotifications` | T | Right-docked side sheet 420 px | none |
| | | `PhoneNotifications` | P | Pushed screen, no bottom bar | none |
| 4 | **Command palette** | `CommandPalette` | D | ⌘K overlay, groups, match highlight, "never runs a verb" | `Palette.tsx`, `PalettePopup.tsx`, `ui/command` |
| 5 | **Fleet** | `Fleet`, `TabletFleet`, `PhoneFleet` | D T P | Reorder pill, Needs you cards, On GitHub card, Running rows (Open, Stop), Idle rows (Start), Show N more | `routes/Fleet.tsx` (today's `/`), `useHeldBands`, `Act.tsx` |
| 6 | **Kill confirmation** | `ConfirmKill` | D | Dialog repeating the Fleet row; Cancel/Kill | `Act.tsx` Confirm, `ConfirmPopup.tsx` |
| | | `PhoneConfirmKill` | P | M3 bottom sheet | none |
| 7 | **Delete confirmation** | `ConfirmDelete` | D | Dialog; file removed, repo and tmux stay | `EditWorkspace.tsx` Removed |
| 8 | **Machines** | `Machines`, `TabletMachines`, `PhoneMachines` | D T P | Add machine pill; machine cards with 4 inline checks, Open, Fix/Doctor; Worth a look unclaimed sessions | `routes/Machines.tsx` table, `Readiness`, `Unclaimed` |
| 9 | **One machine** | `Machine`, `TabletMachine`, `PhoneMachine` | D T P | About list, Readiness 9 of 9 checklist, Workspaces, Sessions with Terminal/Attach/Kill | `routes/OneMachine.tsx` |
| 10 | **Usage** | `Usage`, `TabletUsage`, `PhoneUsage` | D T P | Today/7/30 segmented; By workspace; By model cards; Sessions table; no fleet total | `routes/Usage.tsx` picker + one workspace |
| 11 | **Session, terminal** | `SessionTerminal` | D | Session rail, header with Stop/Resume/Delete, tabs, xterm pane, status line | `OneWorkspace.tsx` + `Terminal.tsx` |
| | | `PhoneSessionTerminal` | P | Key row Esc/Tab/Ctrl/Enter + Keyboard | none |
| 12 | **Session, transcript** | `SessionTranscript` | D | Turns, tool lines, waiting card, Refresh/Older | `Transcript.tsx`, `useTranscript.ts` |
| 13 | **Session, chat** | `SessionChat`, `TabletSessionChat`, `PhoneSessionChat` | D T P | Chat tab first; "Claude is asking" option rows; composer typing into the pane | none (`views.ts` has three views) |
| 14 | **Session, spend** | `SessionSpend`, `PhoneSessionSpend` | D P | Read spend; hero cost; five counts; per-model cards; Fast mode | `Spend.tsx`, `useSpend.ts` |
| 15 | **Session, ended** | `SessionEnded` | D | Frozen transcript, end card "claude exited 0", Resume/Delete | partial: `finished` state only |
| 16 | **New session 1** | `NewSession`, `PhoneNewSessionName` | D P | Stepper; name with generated `quiet-otter`, tile, upload; machine chips | `New.tsx`, `NewWorkspace.tsx` one form |
| 17 | **New session 3, provider** | `NewSessionSource`, `TabletNewSession`, `PhoneNewSession` | D T P | GitHub/GitLab/Local; signed-in line; repo search; rows with "already on" / "clone into" | none |
| 18 | **New session, local** | `NewSessionLocal` | D | Breadcrumb, folder rows with git badges, New folder + Make | `Dirs.tsx` (`/dirs`, `/probe`); no mkdir |
| 19 | **New session 4, start** | `NewSessionStart`, `PhoneNewSessionStart` | D P | Agent/command option cards; "What will happen"; phone recap | partial: startup field |
| 20 | **New session, starting** | `NewSessionCloning` | D | Four stages with clone progress; Run in background | none |
| 21 | **Settings shell + Providers** | `Settings`, `TabletSettings`, `PhoneSettings`, `PhoneSettingsProviders` | D T P | Two-pane categories; Providers Hosting/LLM rows | `routes/Settings.tsx` is the relay form only |
| 22 | **Settings, General** | `SettingsGeneral` | D | Clone home, default machine, time format, confirmations, language | none |
| 23 | **Settings, Notifications** | `SettingsNotifications` | D | Relay row with status; Push when switches; Quiet switch; edit sheet with masked token | relay POST only |
| 24 | **Settings, Agents** | `SettingsAgents` | D | Installed list, behaviour switches | none |
| 25 | **Settings, Access** | `SettingsAccess` | D | SSH identity, known hosts, tailnet, listen address, secret backends | none |
| 26 | **Settings, Appearance** | `SettingsAppearance` | D | Clean/Compact, colour seed swatches, Light/Dark/System, live previews | none |
| 27 | **Settings, About** | `SettingsAbout` | D | Version, built, target, uptime, listens on, update check, log, env file mode | none |
| 28 | **Settings, connect GitHub** | `SettingsProviderConnect` | D | Device-flow sheet: code, URL, validity, scopes | none |
| 29 | **Setup, first run** | `Setup`, `TabletSetup`, `PhoneSetup` | D T P | 6 steps: tailnet, ssh key with copyable line, machines with checks, GitHub, push, first session | `Setup.tsx` step 3 only |
| 30 | **Nothing can be reached** | `Unreachable` | D | Page card, two unknown chips, last good read, Try again / Open Tailscale | `work.ts unreachable()`, `Unreachable.tsx` |
| 31 | **Empty and pending catalogue** | `EmptyStates` | D | 12 blocks incl. skeleton and "reconnecting, attempt 3 of 5" | `ui/empty`, `ui/skeleton`, strings in routes |
| 32 | **Repair** | `Repair` | D | Numbered TOML editor with inline error marker | `routes/Repair.tsx` |
| 33 | **Workspace not found** | `WorkspaceNotFound` | D | Card + Fleet button | `OneWorkspace.tsx` `!entry` |
| 34 | ESP32 | `Esp32Tft`, `Esp32Paper` | E | out of scope | — |

## B. Shared UI pieces

- **Desktop shell**: wordmark, pill tab group (Dashboard · Fleet · Machines · Usage), search pill
  with ⌘K, bell with badge, avatar. Dashboard and New session keep the left sessions rail.
- **Tablet shell**: 80 px navigation rail with the New FAB on top; bell and avatar top-right.
- **Phone shell**: small top app bar, 80 px bottom navigation bar, FAB above it.
- **Per group**: hero card, status strip, list rows with tile, state mark + word, mono age,
  elapsed track bar, disclosure, popover / side sheet / pushed screen, segmented toggle, date
  group headers, command input with match highlight, dialog and bottom sheet with the repeated
  row, machine card with check grid, key/value list, readiness checklist, spend table, terminal
  pane and key row, transcript turns and tool lines, option card with numbered rows, composer,
  stepper, choice cards, repo rows, breadcrumb, progress list, two-pane settings, grouped list
  rows with switch, edit sheet with masked field, swatch row, device-code display, checklist with
  copyable block, error card, skeleton, numbered editor.

## C. API data each group draws, and what is missing

✓ exists in `web/src/api.ts` + `contract.gen.ts` · ~ partly · **MISSING** nothing on the wire.

**Dashboard / Fleet.** ✓ `Workspace`, `Listed`, `AgentState` (nine variants), `Machine`,
`Looked.age_seconds`, `MachineSessions`/`Session`, `Attention{reviews,issues}`. **MISSING**: the
"asked 4m ago" stamp and the pending command on `awaiting_trust`; per-session elapsed time (no
`started_at`); workspace tile colour and icon; the Recent events feed; the date a stopped
workspace last ran.

**Notifications.** **MISSING** as a list: `Attention.notifications` is a count by design (privacy
property in the doc comment); no read state, no mark-all-read, no relay status read-back.

**Command palette.** ✓; the route list changes to the new IA.

**Machines / one machine.** ✓ `Machine`, `Beat`, `Readiness`/`Check` (nine checks map to
present/absent/unknown), sessions, terminal socket, kill. **MISSING**: distro and version (`os`
is a family), tailnet IP, ssh latency as a field, "Added" date, ssh user, Add machine, Open a
shell, Fix terminfo.

**Usage.** **MISSING**: the by-workspace and by-model aggregates and the sessions table (spend is
per workspace on request, and D6 §5.1 forbids a fleet total); a time window; per-model counts and
session counts.

**Session.** ✓ status, down/resume/delete, terminal socket, `Transcript`, `Spend`. **MISSING**:
the origin URL on `Workspace`; a REST way to type into the pane (only the socket carries bytes);
the option text of a trust prompt; per-model counts; the exit code on `finished`.

**New session.** ✓ machines, `POST /api/workspaces`, `Listing`/`Dir`, `Probed`. **MISSING**:
mkdir; generated name; tile colour and upload; repository list and search; GitLab; batched
"already here" probe; clone with progress stages.

**Settings.** ✓ `POST /api/relay`. **MISSING**: every category's facts (General, Agents, Access,
About), relay status read-back, push-when switches, provider connection records, GitHub device
flow, Appearance preferences.

**Setup.** ✓ per-machine readiness. **MISSING**: overall progress, tailnet name, the appliance's
public key, the appliance's own GitHub state, relay state.

**Unreachable / Repair / Not found.** ✓ except "last good read 2m ago" (a failed `Looked` ages
the failure) and the error line number (parsed from `Broken.error`).

## D. Tests today

Twenty files, 379 tests, green on 2026-09-06. `test/inQuery.tsx` gives a hook a fresh
`QueryClient` with `retry: false`; `test/inRouter.tsx` renders a subject under a one-route memory
router after `router.load()`. `terminal.test.tsx` and `transcript.test.tsx` run against a real
WebSocket server and a real file. `visual.test.tsx` pins D3's numbers; `motion.test.ts` reads
`index.css` directly.

## E. Primitives by board count

Load-bearing (on ten boards or more): text roles `t1`/`t2`/`mono`/`eyebrow`/`clip`; `mark`
(needs, running, idle, unknown, done, failed) always with `state` word; `pill`; `icon-btn`;
`row` (min-height 44); `item` + `list`; `card` (radius 28); `tile` (36 px, radius 12); `lead`;
`chip`; `textbtn`, `btn-filled`, `btn-tonal`, `btn-text`; `track`; `dest` (bottom nav) and
`nav-item` (rail); `step`; `chev`; `group`. Second tier: `seg`, `switch`, `swatch`, `field`,
`kv`, `count`, `check`, `choice`, `repo`, `schematic`.

## Cross-cutting

1. The IA changes: `/` becomes Dashboard, Fleet is a sibling tab; `Shell.tsx` NAV and the
   palette's ROUTES change.
2. `views.ts` gains `chat`, first.
3. Nothing in the router or `work.ts` is form-factor aware; only `DataTable` and `OneWorkspace`
   read a media query.
4. Two boards reverse shipped decisions and need dated amendments: Appearance (D3 §0, Q6) and the
   notifications list (`Attention.notifications` count-only).
5. The largest API gap is one feature: the GitHub grant (ADR-0023) with repository search and
   clone progress, which is the spine of New session steps 3 and 4 and of Settings/Providers.
