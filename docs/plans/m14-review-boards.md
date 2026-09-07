# M14 — the boards against the build (Y-352, 2026-09-07)

Read-only. Nothing here changed code. The findings ledger continues
[m14-quality-phase1.md](m14-quality-phase1.md); rows 30 to 90 are closed there and rows 66, 67,
77, 79, 83, 84 and 86 are open, so this file numbers from **91**.

**What was compared.** All 63 boards (65 artboards less the two ESP32 ones, Y-336), each against
the screen the build draws for it. Then two audits over `web/src/m3/`, `web/src/shell/` and
`web/src/screens/`: the design guidelines, and accessibility.

**How.** The board source is `docs/design/canvas/*.dc.html` in this repo, read as HTML.

> **The Figma file was not reachable, and this is the loud part.** `get_metadata` on
> `9HzDailb9rpFWMS3174nu4` answered *"You've reached the Figma MCP tool call limit on the Starter
> plan"*. `whoami` works, so the account is fine and the quota is not. Every board comparison below
> is against the canvas HTML, which the Figma file was made from. If the Figma boards have moved
> since 2026-09-06, this review does not know it.

The built side is `web/e2e/__screenshots__/*.png` where a baseline exists. Fourteen boards have no
baseline; those were rendered live against the fixture server at 1440, 834 and 390 and read as
images. Measurements were taken at `3900836` with a working tree still moving under other agents.

---

## 1. The boards

Verdict is *matches* only where nothing on the board is missing from the screen.

| # | Board | Built screenshot | Verdict | The difference |
|---|---|---|---|---|
| 1 | Main | `dashboard-busy-desktop` | differs | Worth-a-look wraps to two lines; the crashed row's Open is a text button; Attach lost its white fill |
| 2 | MainDark | none — rendered now | matches | inherits row 1's three |
| 3 | MainCompact | none — rendered now | matches | compact tokens hit the board's numbers; Idle grid and Recent card both present |
| 4 | TabletDashboard | `dashboard-busy-tablet` | differs | search, bell and avatar sit in a top row; the board puts bell and avatar at the foot of the rail and draws no search |
| 5 | PhoneDashboard | `dashboard-busy-phone` | differs | keeps the desktop headlines and clips them mid-word instead of the board's short phone strings |
| 6 | EmptyDashboard | `dashboard-empty-desktop` | differs | the rail says "Sessions have not been read yet"; the board says "No sessions yet"; the Running card stretches to fill |
| 7 | TabletEmptyDashboard | `dashboard-empty-tablet` | differs | rows 4 and 6 together |
| 8 | PhoneEmptyDashboard | `dashboard-empty-phone` | differs | the FAB covers the Idle band's "New →" |
| 9 | NotificationsPopover | `shell-notifications-busy-desktop` | differs | a Segmented replaces the board's pill group; Mark all read moved onto the tab row; no per-row unread dot |
| 10 | TabletNotifications | `shell-notifications-busy-tablet` | differs | the sheet sits in the flow and squeezes the page, so Running rows draw outside their card |
| 11 | PhoneNotifications | `shell-notifications-busy-phone` | differs | the board draws no Unread/All tabs on the phone and gives each row a state mark |
| 12 | CommandPalette | `shell-palette-busy-desktop` | differs | the field is an outlined field with a floating label; the rows lost the age column |
| 13 | Fleet | none — rendered now | matches | Reorder is drawn disabled and 40 px against the board's active 44 |
| 14 | TabletFleet | none — rendered now | differs | the board puts bell and avatar in the rail with no search; elapsed times wrap to two lines |
| 15 | PhoneFleet | none — rendered now | differs | the Idle header prints "idle IDLE 4"; row names clip; Running keeps a Stop the board drops |
| 16 | ConfirmKill | `confirm-kill-busy-desktop` | differs | the repeated row loses mark, word and elapsed; the dialog sits on `surface-container-high`, the board on `-low` |
| 17 | PhoneConfirmKill | `confirm-kill-busy-phone` | differs | sheet, handle, radius and words match; the row again drops "running · macbook" and "3h 41m" |
| 18 | ConfirmDelete | `confirm-delete-busy-desktop` | differs | the row keeps mark and word but loses elapsed; surface tier off by one |
| 19 | Machines | none — rendered now | differs | no "Add machine"; the unreachable chip reads `2026-07-07` where the board says `7 Jul` |
| 20 | TabletMachines | none — rendered now | differs | row 19, plus "Worth a look" clips the machine name |
| 21 | PhoneMachines | none — rendered now | differs | the board keeps one full card and folds five into 72 px rows; the build draws six full cards |
| 22 | Machine | none — rendered now | differs | columns swapped; no back link; card titles became eyebrows; readiness rows lost their white row |
| 23 | TabletMachine | none — rendered now | differs | no back arrow; card order is About/Readiness/Workspaces/Sessions against the board's About/Workspaces/Readiness/Sessions |
| 24 | PhoneMachine | none — rendered now | differs | the header wraps to three rows and every list value clips |
| 25 | Usage | none — rendered now | differs | no proportion bars, no per-model token counts, and the read result reverts to "Nothing read yet" |
| 26 | TabletUsage | none — rendered now | differs | row 25, and the table's columns are not the board's five |
| 27 | PhoneUsage | none — rendered now | differs | the board turns Sessions into 64 px cards; the build keeps a table whose Cost column is off-screen |
| 28 | SessionTerminal | `session-terminal-busy-desktop` | differs | no sessions rail; the pane is capped at 880 px and 60vh instead of filling; the status line sits outside the dark pane |
| 29 | PhoneSessionTerminal | `session-terminal-busy-phone` | differs | a visible Stop/Resume/Delete row, not the board's ⋮ overflow; no tile in the app bar |
| 30 | SessionTranscript | `session-transcript-busy-desktop` | differs | no rail; the waiting card points at Chat, the board at Terminal; a bare tool name renders with no target |
| 31 | SessionChat | `session-chat-busy-desktop` | differs | no rail; the composer is a grey filled field, not the board's white pill with a live primary send |
| 32 | TabletSessionChat | `session-chat-busy-tablet` | differs | a search pill the board has not; bell and avatar in the content bar; Resume where the board draws only Stop and Delete |
| 33 | PhoneSessionChat | `session-chat-busy-phone` | differs | desktop copy verbatim at 390 px; verbs row instead of ⋮; composer not the white pill |
| 34 | SessionSpend | `session-spend-busy-desktop` | differs | no rail; `prices as of 2026-08-11` instead of `4 Sep`; otherwise close |
| 35 | PhoneSessionSpend | `session-spend-busy-phone` | differs | the desktop layout reflowed; the board puts counts inside each model card and ends with a Read again row |
| 36 | SessionEnded | `session-ended-busy-desktop` | differs | no rail; no age on the ended card; the meta sentence is not the board's |
| 37 | NewSession | `new-session-name-busy-desktop` | differs | drawn as a page with the rail, not the board's modal; steps are Name/Source/Start/Create, not Name/Machine/Source/Start; no swatches, no upload; chips unmarked |
| 38 | PhoneNewSessionName | `new-session-name-busy-phone` | differs | no fixed 80 px bottom action bar; ← instead of ✕; swatches and upload missing |
| 39 | NewSessionSource | `new-session-source-busy-desktop` | differs | the provider picker is three cards, not the board's segmented pills; grant line and repo rows carry no mark |
| 40 | TabletNewSession | `new-session-source-busy-tablet` | differs | no modal or scrim; the header keeps "New session" rather than the tile and name |
| 41 | PhoneNewSession | `new-session-source-busy-phone` | differs | **the sticky footer covers the card**, and row text overflows the card's right edge |
| 42 | NewSessionLocal | `new-session-local-busy-desktop` | differs | no folder age, no up-button, no folder count; an extra "Or type a path"; absolute `/home/biswa/…` where the board uses `~` |
| 43 | NewSessionStart | `new-session-start-busy-desktop` | differs | icons where the board uses marks; "A command" has no inset input; "What will happen" has no card, no numbers, no mono |
| 44 | PhoneNewSessionStart | `new-session-start-busy-phone` | differs | **the same sticky-footer overlap**; "So far" is a plain list, not tappable rows |
| 45 | NewSessionCloning | `new-session-cloning-busy-desktop` | differs | **no progress track**; step 2 says "Creating workspace", the board says "Creating tmux session" |
| 46 | Settings (the Providers pane) | `settings-providers-busy-desktop` | differs | the pane's footnote repeats the category blurb; GitLab gains "· later" and a dead Connect |
| 47 | TabletSettings | `settings-general-busy-tablet` | differs | rail plus list plus pane leaves the pane too narrow, so every supporting line clips |
| 48 | PhoneSettings | `settings-index-busy-phone` | differs | the build groups seven categories under two eyebrows; the board is one flat list |
| 49 | PhoneSettingsProviders | `settings-providers-busy-phone` | differs | the board's phone-length strings are unused; desktop strings clip; the app bar reads `providers · Settings` |
| 50 | SettingsGeneral | `settings-general-busy-desktop` | differs | two read-only values became segmented buttons; supporting lines shortened |
| 51 | SettingsNotifications | `settings-notifications-busy-desktop`, `settings-relay-busy-desktop` | differs | the edit sheet is a centred dialog, not the board's 480 px side sheet; three row wordings changed |
| 52 | SettingsAgents | `settings-agents-busy-desktop` | differs | the whole **Behaviour** group is missing |
| 53 | SettingsAccess | `settings-access-busy-desktop` | differs | the **Known hosts** row and the whole **Secrets** group are missing |
| 54 | SettingsAppearance | `settings-appearance-busy-desktop` | differs | the Dark preview draws light; the custom-hex label sits on its own placeholder |
| 55 | SettingsAbout | `settings-about-busy-desktop` | differs | no display version; "running" has no mark; Check for update and Daemon log missing |
| 56 | SettingsProviderConnect | `settings-connect-nogrant-desktop` | differs | the words match line for line; the geometry is a centred dialog, not a side sheet |
| 57 | Setup | `setup-firstrun-desktop` | differs | the Sessions rail is drawn beside it; no "Place the key"; the key moved into step 2 |
| 58 | TabletSetup | `setup-firstrun-tablet` | matches | rail 96 with the FAB at the top, no tab group, six steps |
| 59 | PhoneSetup | `setup-firstrun-phone` | differs | the app bar reads "Dashboard", so the screen carries no title (baseline is stale — see 96) |
| 60 | Unreachable | `unreachable-unreachable-desktop` | differs | a stray unstyled `Fleet` heading; no reasoning paragraph, no "last good read", no "Open Tailscale" |
| 61 | EmptyStates | `empty-states-empty-desktop` | matches | the three Fleet blocks are word for word |
| 62 | Repair | `repair-repair-desktop`, `repair-refused-repair-desktop` | matches | numbered editor, inline marker on line 7, mark and word, both footnotes |
| 63 | WorkspaceNotFound | `workspace-not-found-empty-desktop` | differs | the Fleet button fills the card and puts the arrow before the label |

**Counts: 6 match, 57 differ, 0 not built.** Every board is a route or a state of one, so M14 §1.1
holds. **49 of 63 have a screenshot baseline; 14 do not** — MainDark, MainCompact, Fleet ×3,
Machines ×3, Machine ×3 and Usage ×3. `machines.spec.ts`, `machine.spec.ts` and `usage.spec.ts`
call `axe()` and never `screenshot()`, and no `fleet.spec.ts` exists, so the busy Fleet has never
been pictured.

> **2026-09-07: all 63 have one now.** Finding 98 is closed and the fourteen missing baselines were
> rendered in the Playwright image. What they show is in §5's note.

Most of the 57 are small: a word, a tier, a wrap. Four are visible defects — 15, 41, 44 and 25.

### The three ADR-0024 product rules hold

**No fleet spend total** (`usage/read.ts:64` refuses to sum, and the note is on all three sizes).
**Attach and Kill, never Adopt** on unclaimed sessions. **Only Kill and Delete confirm** —
`fleet/Confirm.tsx` exports exactly `KillSession` and `DeleteWorkspace`, and Stop and Resume post
straight through `fleet/Verb.tsx:56`.

### One thing the boards disagree about

`SessionTerminal.dc.html:200` and `SessionTranscript.dc.html:184` draw three tabs; `SessionChat`,
`SessionSpend` and `SessionEnded` draw four with Chat first. The build draws four everywhere, which
matches the majority. The two three-tab boards are stale, and the canvas should say so.

---

## 2. The design-guidelines audit

Against ADR-0024 §2 and §4 over `web/src/m3/`, `web/src/shell/` and `web/src/screens/`.

`web/src/m3/` is close. The tokens, the state layer, the springs and the focus ring are all real,
and nearly every finding against it is one unconverted number rather than a missing seam.
`web/src/screens/` is not there yet: the row title's size, a re-implemented hero, 39 size-only
typescale reads and a dead selector are §4 rules the screens do not keep.

The numbers behind the findings:

- **39** call sites in `screens/` and `shell/` write `font-size: var(--md-sys-typescale-*-size)`;
  **3** pair it with the role's line-height. The rest inherit `.shell`'s 20 px body leading.
- **25** sections use `<Eyebrow as="h2">` (label-medium 12, uppercase) as the section heading
  against **7** uses of `title-large`. The 2026-09-07 amendment blesses the eyebrow as the label
  *above* a title, not as the title.
- **Nine** files carry radii off the shape scale: 22, 24, 20, 18, 14, 10, 6 and 4 px.
- **Six** components draw a 40 px visible control against §4's 44. The 48 px hit area is honoured
  by `.m3-interactive::after` (`tokens.css:551-555`), so this is a visual miss, not a target miss.

---

## 3. The accessibility audit

Against WCAG 2.2 AA over `web/src/m3/`, `web/src/shell/` and `web/src/screens/`.

**axe is clean, and this section stays off its ground.** `web/e2e/lib/axe.ts:4` runs `wcag2a`,
`wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` on every route at 390, 834 and 1440, and no spec
passes a `known` list, so the suite carries no acknowledged debt. Everything below is a failure axe
cannot see.

### The terminal pane is a keyboard trap

`screens/session/Terminal.tsx:30` opens xterm.js and never registers
`attachCustomKeyEventHandler` — the string appears nowhere in the tree. xterm consumes Tab and sends
the byte to the pty, so **a keyboard user who enters the pane cannot leave it**. The proof is beside
it: `screens/session/Keys.tsx:205` draws a Tab button, which exists because Tab does not reach the
browser. Nothing on the screen says how to get out. This is WCAG 2.1.2, Level A, and it is the worst
thing in the build.

The pane also takes focus by itself. `Terminal.tsx:35` calls `xterm.focus()` inside the callback that
runs when `document.fonts.ready` resolves, so focus jumps into the trap after the page has settled
and without the user asking (2.4.3, 3.2.1).

### Focus goes where nothing reserved room for it

`grep -rn "scroll-padding\|scroll-margin" web/src` returns nothing. Three surfaces sit over the
content anyway:

- the phone's FAB is `position: fixed` 80 px from the bottom and 56 tall (`shell/Shell.css:166-171`)
  while `.shell__main` reserves 96 px (`Shell.css:152-154`), so the FAB covers the last 40 px;
- the navigation bar is fixed at `z-index: 5` (`Shell.css:160-164`);
- New session's phone footer is `position: sticky; bottom: 0` on an opaque `surface`
  (`screens/new-session/NewSession.css:367-373`) with no room reserved above it.

A control focused at the foot of a scroll therefore sits under one of the three. That is WCAG 2.4.11,
new in 2.2 and Level AA, and it is the same defect §1 recorded three times by eye — rows 8, 41 and
44.

### What changes without navigation, and what says so

Twelve live regions exist. The three things that change most say nothing.

**The clone.** `screens/new-session/Starting.tsx:122-140` advances four stages from *waiting* to
*running* to *done* on a poll, inside a plain `<ol aria-label="Stages">`. There is no `aria-live`,
no `role="status"` and no `Track`. A screen reader hears nothing between Start and the session
opening. Only a refusal speaks, because `ErrorSurface.Inline` carries `role="alert"`. Fixing this
also closes §1 row 45, which wanted the board's progress track: the track is the live region.

**A session going running → crashed.** `screens/dashboard/Dashboard.tsx:404-440`,
`screens/fleet/Fleet.tsx:264-350` and `shell/SessionsRail.tsx:73-100` redraw the mark and the word on
every poll, and none of the three is inside a live region (4.1.3).

**The terminal ending.** `Terminal.tsx:138` puts `role="status"` on the connecting line — correct
while it is attached. When the session ends, that node is replaced by `ErrorSurface.Inline` or by the
plain paragraph at `Terminal.tsx:163`, so the live region **unmounts with the news it should carry**
and the end is silent.

One more is quieter. `screens/session/Chat.tsx:144` writes the string
`'Typed your message into the pane.'` into the `role="status"` paragraph at `Chat.tsx:203` and never
clears it, so the second and every later send write a string React already has. Only the first send
is announced.

### The palette moves a cursor it never scrolls to

`shell/PalettePopup.tsx:194-199` moves `active` on ArrowUp and ArrowDown and paints the row with
`tone="selected"`. `.palette__list` is `max-height: 50vh; overflow-y: auto` (`shell/Palette.css:22-23`)
and **no call to `scrollIntoView` exists anywhere in `web/src`**. Past the sixth workspace the active
option leaves the box and the arrow keys move nothing a person can see (2.4.7).

The list also has two cursors. The field is `role="combobox"` with `aria-activedescendant`
(`PalettePopup.tsx:187`), and every option is a real `<button role="option">`
(`PalettePopup.tsx:227`), so Tab walks the whole list as well (4.1.2). The legend that would explain
either model — `↑↓ move  Enter open  Esc close` — is `aria-hidden="true"` (`PalettePopup.tsx:261`).

### The focus ring, and the one background it fails on

`m3/tokens.css:308-311` gives 3 px of `secondary` at a 2 px offset. Against `surface` and every
container tier it computes between 4.9:1 and 6.4:1 in both themes, well over the 3:1 that 1.4.11
asks. It fails on exactly one background. `m3/snackbar/Snackbar.css:13` paints `inverse-surface`, and
the positive offset keeps the ring inside that dark box: `#536350` on `#2E322D` is **2.0:1** in light,
`#BACCB4` on `#E1E3DB` is **1.3:1** in dark. `m3/card/Card.css:54` has the same exposure. Neither
reaches a screen today — no file under `screens/` or `shell/` imports the Snackbar or writes
`surface="inverse"` — so this is a defect in the library, not yet on a page.

One place clips the ring. `m3/list/List.css:41-43` draws it inward at `outline-offset: -3px`
precisely to survive `.m3-list`'s `overflow: hidden` (`List.css:9`), and that works along the edges.
It does not work at the corners: `.m3-list-item` is square (`List.css:33`) and the container's radius
is 16 or 20 px, so on the first and last row the ring's own corner falls outside the rounded
silhouette and is cut.

### Reduced motion holds

`m3/tokens.css:428-434` sets the three spatial durations to 1 ms and leaves the effects durations
alone. That is R14 §5's deliberate split — remove movement, keep feedback — and it reaches
everything: every transform, height and corner animation in `m3/` reads a `*-spatial` token, the one
animation in a screen (`screens/fleet/Fleet.css:161`) reads the pair, and the shimmer that does not
use a token carries its own block (`m3/skeleton/Skeleton.css:38-42`). No gap.

### The 44 px rule, and what the hit area really gives

`.m3-interactive::after` (`m3/tokens.css:551-555`) is
`inset: min(0px, calc((100% - var(--md-sys-hit-area)) / 2))` over `--md-sys-hit-area: 48px`
(`tokens.css:312`), and `position: relative` comes from the same rule (`tokens.css:535`). A 40 px
control therefore gets −4 px on each axis and a true 48 × 48 target, and **nothing clips it**: no
component wraps an interactive element in an `overflow: hidden` box tight enough to cut the 4 px.
WCAG 2.5.8's 24 × 24 is met everywhere with room to spare.

So the miss is visual, as §2 said — but it is eight components, not six. Six draw at 40:
`button/Button.css:7` (size S), `pill/Pill.css:8`, `tab-pills/TabPills.css:32`,
`segmented/Segmented.css:15`, `disclosure/Disclosure.css:30` and `snackbar/Snackbar.css:25`. Two more
draw at 32: `chip/Chip.css:6` and `switch/Switch.css:7`. Compact density adds a ninth by dropping
`--m3-row-min-height` from 44 to 40 (`tokens.css:340` against `:321`).

### Text that clips, and reflow

`.m3-clip` is `nowrap` + `hidden` + `ellipsis` (`m3/tokens.css:603-607`) and adds no `title`. A screen
reader still gets the whole string, so this is not a name problem; it is 1.4.4, because at 200 % zoom
the visible text shrinks and the cut words are gone. Nine sites cut something a person needs: the
workspace name as the page `<h1>` (`screens/session/Header.tsx:71`,
`screens/session-terminal/SessionTerminal.tsx:42`), session names
(`screens/dashboard/Dashboard.tsx:540,646`, `screens/machine/Sessions.tsx:77`,
`screens/machines/Unclaimed.tsx:51`), the model and workspace names in Usage
(`screens/usage/Usage.tsx:51,85`), the fleet's error detail (`screens/fleet/Fleet.tsx:297,316,346`)
and a repo path (`screens/machine/Machine.tsx:97`).

Reflow at 320 px is sound: the shell switches to the phone below 600 px (`shell/formFactor.ts:9`),
every screen grid guards its columns with `minmax(0, …)`, and Usage's table is a keyboard-focusable
scroll region (`screens/usage/Sessions.tsx:58`), which 1.4.10 allows a data table. **200 % zoom on a
tablet is not sound.** `m3/side-sheet/SideSheet.css:7` is `flex: none; width: 420px`, and
`shell/Shell.css:132-139` gives `.shell__column` `min-width: 0`, so the docked sheet takes 420 of a
640 px effective width and the page keeps 124 px after the rail. §1 rows 10 and 47 are that
arithmetic seen by eye: rows drawn outside their card, supporting lines clipped.

### Two more, in forms and in a toolbar

`screens/settings/Notifications.tsx:164-185` never sets `aria-invalid` on the Topic URL or the Token
when the write fails; the daemon's words go to a separate `aria-live` div at `:186` that neither
field points at (3.3.1). And `screens/session/Keys.tsx:201` declares `role="toolbar"` over seven
buttons with no roving `tabindex` and no arrow keys, which is a role the widget does not implement
(4.1.2). Its Ctrl button also clears its own `aria-pressed`: the click calls `focus()` on the pane,
which fires the `onBlur` at `Keys.tsx:222` while the pane's `ctrl` flag stays armed. `shell/Palette.tsx:20-29` binds Ctrl-K on
`document` with no guard for where focus is, so the palette summons itself while the pane holds it.

### What is already right, and would be wrong to flag

- **State is never colour alone.** `m3/mark/Mark.tsx:22` makes the bare dot `aria-hidden`, and every
  one of the five bare uses in a screen has the word beside it (`machine/Machine.tsx:175`,
  `machines/MachineCard.tsx:83`, `repair/Repair.tsx:139`, `session/Spend.tsx:109`,
  `session/Terminal.tsx:139`). `State` supplies `word[state]` by default.
- **No icon-only control can be nameless.** `label: string` is required on `IconButton`
  (`m3/icon-button/IconButton.tsx:62`) and `Fab` (`m3/fab/Fab.tsx:7`). `Switch`'s is optional
  (`m3/switch/Switch.tsx:8`) and every call site passes one — a hole, not a bug.
- **Dialog, bottom sheet, menu and popover are Base UI with no focus overrides**, so the trap and the
  return are the library's. `SideSheet` is the one hand-rolled case and it is correct: it stores the
  opener, focuses its `tabIndex={-1}` heading and restores focus on close
  (`m3/side-sheet/SideSheet.tsx:20-30`).
- **The phone's single `<h1>` is deliberate.** `Shell.css:156-158` hides the screen's and
  `m3/top-app-bar/TopAppBar.tsx:19` supplies one, and every route names itself
  (`src/router.ts:25-206`). §1 row 59 predates `useScreenTitle('Set up Yantra')`
  (`screens/setup/Setup.tsx:173`); that baseline is stale, and the screen is fine.
- **`Snackbar` mounts its live region empty and fills it a tick later**
  (`m3/snackbar/Snackbar.tsx:18-24`). `ErrorSurface` does not: `role="alert"` and the text arrive in
  one pass (`m3/error-surface/ErrorSurface.tsx:40,46-49`), so it announces by luck where the snackbar
  announces by design. That one is a finding; the snackbar's pattern is the fix.

---

## 4. The findings

Numbered from 91. *Whose* names the M14 role that owns the fix
([plan §2](m14-the-material-dashboard.md)). Ranked: the keyboard trap, then the rest of the
accessibility failures and the visible defects, then the design rules, then the differences that are
one word.

| # | What is wrong | Where | Whose | Severity |
|---|---|---|---|---|
| 91 | The terminal pane takes Tab and never gives it back, so a keyboard cannot leave it (2.1.2, A) | `screens/session/Terminal.tsx:30-53`; `screens/session/Keys.tsx:205` | UI | blocker |
| 92 | Nothing reserves room under the phone's fixed FAB, its fixed navigation bar or New session's sticky footer, so a focused control at the foot of a scroll sits under them (2.4.11). Closes §1 rows 8, 41, 44 | `shell/Shell.css:152-171`, `screens/new-session/NewSession.css:367-373` | UI | high |
| 93 | The four clone stages advance with no live region and no progress track, so the whole start is silent (4.1.3). Closes §1 row 45 | `screens/new-session/Starting.tsx:122-140` | UI | high |
| 94 | A session going running → crashed is announced nowhere; the three lists that redraw on a poll hold no live region (4.1.3) | `screens/dashboard/Dashboard.tsx:404-440`, `screens/fleet/Fleet.tsx:264-350`, `shell/SessionsRail.tsx:73-100` | UI | high |
| 95 | The pane takes focus the moment the fonts resolve, unasked (2.4.3, 3.2.1) | `screens/session/Terminal.tsx:35` | UI | high |
| 96 | The palette's arrow keys move an active option the scrolling list never brings into view (2.4.7) | `shell/PalettePopup.tsx:194-199`, `shell/Palette.css:22-23` | UI | high |
| 97 | Settings drops three groups the boards draw — **Behaviour**, **Known hosts**, **Secrets** — and About's Check for update and Daemon log. §1 rows 52, 53, 55 | `screens/settings/Agents.tsx:13-25`, `Access.tsx:27,66`, `About.tsx:48,59` | UI | high |
| 98 | Fourteen of 63 boards have no screenshot baseline: `machines.spec.ts`, `machine.spec.ts` and `usage.spec.ts` call `axe()` and never `screenshot()`, and no `fleet.spec.ts` exists | `web/e2e/` | Testing | high |
| 99 | The terminal's `role="status"` unmounts when the session ends, so the end is the one thing it does not announce (4.1.3) | `screens/session/Terminal.tsx:137-174` | UI | moderate |
| 100 | Usage draws no proportion bar and no per-model token counts, and holds the read in component state, so leaving the page reverts it to *Nothing read yet*. §1 row 25 | `screens/usage/Usage.tsx:47-58,83-93`, `screens/usage/read.ts:36-52` | UI, API | moderate |
| 101 | PhoneFleet's Idle header prints the word twice — `idle IDLE 4` — on screen and aloud, because `State` supplies its own. §1 row 15 | `screens/fleet/Fleet.tsx:246-251` | UI | moderate |
| 102 | The palette's options are tabbable buttons inside a listbox driven by `aria-activedescendant`, and the legend naming the keys is `aria-hidden` (4.1.2) | `shell/PalettePopup.tsx:227,261-263` | UI | moderate |
| 103 | The chat's status region writes one unchanging string, so only the first send is announced (4.1.3) | `screens/session/Chat.tsx:144,203` | UI | moderate |
| 104 | The transcript scrolls itself to the bottom on every five-second read, with no way to stop it (2.2.2) | `screens/session/Chat.tsx:129-131` | UI | moderate |
| 105 | A one-of-N choice is announced as independent toggles; Material's segmented button is radio semantics (4.1.2) | `m3/segmented/Segmented.tsx:21-55` | Packages | moderate |
| 106 | At 200 % zoom on a tablet the docked 420 px sheet leaves the page 124 px, and rows draw outside their card (1.4.10). §1 rows 10, 47 | `m3/side-sheet/SideSheet.css:7`, `shell/Shell.css:132-139` | Packages, UI | moderate |
| 107 | Nine names, paths and errors clip with the full string nowhere on the page at 200 % zoom (1.4.4). §1 rows 5, 15, 20, 24, 49 | `m3/tokens.css:603-607` and the nine sites in §3 | UI | moderate |
| 108 | The key row declares `role="toolbar"` over seven tab stops with no arrow keys (4.1.2) | `screens/session/Keys.tsx:201-234` | UI | moderate |
| 109 | The relay fields never go `aria-invalid`, and the failure text points at neither (3.3.1) | `screens/settings/Notifications.tsx:164-186` | UI | moderate |
| 110 | The focus ring on `inverse-surface` is 2.0:1 in light and 1.3:1 in dark against 1.4.11's 3:1. Latent: no screen draws either surface yet | `m3/tokens.css:308-311,571`, `m3/snackbar/Snackbar.css:13`, `m3/card/Card.css:54` | Packages | moderate |
| 111 | `role="alert"` mounts with its text, so `ErrorSurface` announces by luck where `Snackbar` announces by design. Sits beside open row 79 | `m3/error-surface/ErrorSurface.tsx:40,46-49` | Packages | moderate |
| 112 | The session screens lose the sessions rail the boards keep beside them. §1 rows 28, 30, 31, 34, 36 | `shell/Shell.tsx:111-115` | UI | moderate |
| 113 | New session is a page, not the boards' modal, and its steps are Name/Source/Start/Create against Name/Machine/Source/Start. §1 rows 37, 40 | `screens/new-session/NewSession.tsx:62,85` | UI | moderate |
| 114 | The phone keeps the desktop strings the boards shorten, and clips them. §1 rows 5, 33, 49 | `screens/session/Chat.tsx`, `screens/settings/Providers.tsx` | UI | moderate |
| 115 | No spec opens `/m3`, and CI never sets `E2E_DEV`, so the gallery Y-339 says axe passes on is never rendered in the run that gates a merge | `web/e2e/`, `src/router.ts:200-206` | Testing | moderate |
| 116 | 39 call sites read `--md-sys-typescale-*-size` without the role's line-height, so the text inherits `.shell`'s 20 px leading | ten CSS files under `screens/` and `shell/` | UI | moderate |
| 117 | 22 sections use `<Eyebrow as="h2">` — label-medium 12 uppercase — as the section heading, against seven uses of `title-large` | `screens/fleet/Fleet.tsx:213,248`, `screens/dashboard/Dashboard.tsx:303,473,590,605,831`, +15 | UI | moderate |
| 118 | Eight components draw a visible control under §4's 44 px — six at 40, Chip and Switch at 32 — and Compact drops the row to 40. The 48 px hit area holds, so this is visual only | `m3/button/Button.css:7`, `pill/Pill.css:8`, `tab-pills/TabPills.css:32`, `segmented/Segmented.css:15`, `disclosure/Disclosure.css:30`, `snackbar/Snackbar.css:25`, `chip/Chip.css:6`, `switch/Switch.css:7`, `tokens.css:340` | Packages | moderate |
| 119 | The Ctrl key clears its own `aria-pressed` by focusing the pane, while the pane stays armed | `screens/session/Keys.tsx:214-226` | UI | low |
| 120 | Send, Stop and Resume go disabled with no reason a reader can get at | `screens/session/Chat.tsx:195`, `screens/session/Header.tsx:97-110` | UI | low |
| 121 | The tablet's action row sits outside every landmark, and its bell writes `aria-expanded` for a popup not yet in the DOM and names no `aria-controls` | `shell/Shell.tsx:150-167` | UI | low |
| 122 | Ctrl-K is bound on `document` with no guard for where focus is, so it fires while the terminal pane holds it | `shell/Palette.tsx:20-29` | UI | low |
| 123 | The focus ring's corner is cut on a List's first and last row, where a square item meets a 20 px container radius | `m3/list/List.css:9,33,41-43` | Packages | low |
| 124 | `Switch`'s `label` is optional where `IconButton`'s and `Fab`'s are required, so a nameless switch compiles | `m3/switch/Switch.tsx:8,17` | Packages | low |
| 125 | The dashboard hero assembles its own `font` shorthand and drops the role's tracking | `screens/dashboard/Dashboard.css:105-108` against `m3/tokens.css:123-125` | UI | low |
| 126 | Fifteen declarations carry radii off the shape scale: 22, 24, 20, 18, 14, 10, 6 and 4 px | `m3/disclosure/Disclosure.css:4`, `m3/kbd/Kbd.css:4`, `m3/popover/Popover.css:15`, `m3/side-sheet/SideSheet.css:11`, `m3/tile/Tile.css:17`, +10 in `screens/` | Packages, UI | low |
| 127 | Two call sites write a colour where ADR-0024 §2 says a role | `screens/session/Terminal.css:13`, `screens/settings/Settings.css:323` | UI | low |
| 128 | Three value formats print raw where the boards print a short form: `2026-07-07` for `7 Jul`, `prices as of 2026-08-11` for `4 Sep`, `/home/biswa/…` for `~`. §1 rows 19, 34, 42 | `screens/machines/`, `screens/session/Spend.tsx`, `screens/new-session/LocalDirs.tsx` | UI | low |
| 129 | The tablet puts search, bell and avatar in a content bar; the boards put bell and avatar at the foot of the rail and draw no search. §1 rows 4, 7, 14, 32 | `shell/Shell.tsx:150-167` | UI | low |
| 130 | `Card[data-surface="inverse"]` matches nothing, and `m3/divider/`, `m3/snackbar/` and `m3/tab-pills/` are imported by no screen | `m3/card/Card.css:54,73` | Quality | low |
| 131 | Unreachable still offers no **Open Tailscale**, and Fleet's own unreachable branch leaves a stray unstyled `Fleet` heading. The rest of §1 row 60 was closed by Y-358, after §1 was measured | `shell/NotReached.tsx:20-33`, `screens/fleet/Fleet.tsx:76` | UI | low |
| 132 | The copy differences on six rows: a card's wording, a footnote that repeats its blurb, a step named *Creating workspace* for *Creating tmux session*, a waiting card pointing at Chat for Terminal. §1 rows 6, 30, 45, 46, 50, 51 | `screens/` | UI | low |
| 133 | `SessionTerminal.dc.html:200` and `SessionTranscript.dc.html:184` draw three tabs where five other boards draw four. The build follows the majority; the two boards are stale | `docs/design/canvas/` | Review | low |

**43 findings. Twenty-three are accessibility failures** — 91 to 96, 99, 102 to 111 and 119 to 124.
Rows 91 to 98 are what gates the close; everything from 119 down is an afternoon.

### The 57 differences, and the twelve not worth a task

Twelve of the 57 rows §1 marked *differs* do not become findings, and saying so is the point of a
review.

- **Three are a surface tier or a fill.** Rows 1, 16 and 18 put a dialog on `surface-container-high`
  where the board drew `-low`, and row 1's Attach lost a white fill. The tier is one token either
  way, no rule in ADR-0024 §2 names it, and the board and the build are both legible. Change the
  board.
- **Five are a component substitution the build argues for and wins.** Row 9 and row 39 replace a
  pill group with a Segmented and a segmented picker with cards; row 12's palette field is outlined
  with a floating label; row 29 and 33's verb row replaces a `⋮` overflow. Each is more discoverable
  than the board and none breaks a §4 rule. Row 133 is the same shape: the boards are stale, not the
  build.
- **Two are the boards' own inconsistency.** Rows 22 and 23 disagree with each other about the card
  order on Machine; the build picked one.
- **Two are dead weight.** Row 47's tablet Settings clips because the pane is third in a row of
  three, which is finding 106 already; row 20's clipped machine name is finding 107 already. Counting
  them twice would inflate the ledger, not the fix.

The other 45 rows are represented above, most of them grouped: **39 typescale reads are one finding,
not 39** (116), 22 eyebrow headings are one (117), every off-scale radius is one (126), the three raw
value formats are one (128), and the copy differences on six rows are one (132).

---

## 5. Does Y-352 close?

The row asks three things. One holds, one holds with an asterisk, one does not.

**e2e, axe and the budget at three sizes — two of three.** The suite was run twice today at
`435f633`. On this host: **504 passed, 5 failed**, every failure a `toHaveScreenshot` diff on the
confirm sheet at phone and the terminal at phone and tablet. Re-run inside
`mcr.microsoft.com/playwright:v1.63.0-noble`, the image `web.yml` uses, `session.spec.ts` and
`confirm.spec.ts` give **72 passed, 0 failed**. The five are host font rendering, exactly as
`playwright.config.ts:6-12` warns, not drift. **So e2e and axe are green at 390, 834 and 1440.** The
budget is not: at `435f633` `npm run budget` measured **159.7 KiB** gzip against the 145 KiB
ceiling, 14.7 KiB over, with fonts at 78.5 KiB and under. `index.css` was 21.0 KiB of it and still
carried the shadcn sheet, which Y-353 deletes. Open row 84 stands beside this: `web.yml:49` carries
`continue-on-error: true`, so today the budget cannot fail a build even when it exits 1.

> **2026-09-07, after Y-353 and Y-356 merged in.** The 159.7 KiB above is the figure at `435f633`
> and nothing else in this section moves with it. `/` is **147.6 KiB** now, 2.6 KiB over, and fonts
> are still 78.5 KiB. Row 84 stays open on the smaller gap.

**Every board has a compared screenshot — no.** Forty-nine of 63 do. Fourteen have none: MainDark,
MainCompact, Fleet ×3, Machines ×3, Machine ×3 and Usage ×3. The cause is concrete and so is the
cure. `machines.spec.ts`, `machine.spec.ts` and `usage.spec.ts` call `axe()` and never
`screenshot()`; `fleet.spec.ts` does not exist. **The fix is one new spec and three edited ones** —
add `fleet.spec.ts` on the busy scenario, add a `screenshot()` call to the three, then generate the
baselines inside the Playwright image with `--update-snapshots`. That is finding 98, and it is one
sitting.

> **2026-09-07: it was one sitting, and it holds now.** `fleet.spec.ts` is written, the three specs
> call `screenshot()`, and MainDark and MainCompact are captured from `dashboard.spec.ts` through
> its `prefer()` helper. All 63 boards have a compared picture.
>
> Held against their boards, the fourteen confirm §1 rows 14, 15 and 19 to 27 word for word. Rows 2
> and 3 stand: the dark and the compact dashboards match, and both inherit row 1's three. **Row 13
> is corrected to *differs*** — its own text already named the disabled 40 px Reorder against the
> board's active 44, and the build also leaves blank the date the board prints on every idle row.
> Two differences this pass did not have: `/machines` writes *opened 4 Sep ago*, an absolute date
> inside a relative sentence, and Usage can only be pictured at the viewport, because a full-page
> capture drops the read ([the ledger](m14-quality-phase1.md) rows 98 and 135).

**Zero open findings on `web/` — no.** This pass adds 43 to the seven still open from
[m14-quality-phase1.md](m14-quality-phase1.md): 66, 67, 77, 79, 83, 84 and 86. Fifty in total, one of
them a Level A keyboard trap.

> **The Figma caveat, repeated because it is load-bearing.** `get_metadata` on
> `9HzDailb9rpFWMS3174nu4` answered *"You've reached the Figma MCP tool call limit on the Starter
> plan"*. Every one of the 63 comparisons in §1 is against `docs/design/canvas/*.dc.html`, which the
> Figma file was made from on 2026-09-06. If a board moved in Figma after that date, **this review
> does not know it**, and none of §1's verdicts can be treated as a comparison against the Figma
> boards. That is a gap in the evidence, not in the build.

### The recommendation

**Y-352 cannot close yet, and the shortest path is three pieces of work, not fifty.**

1. **Fix the eight rows that gate it: 91 to 98.** The keyboard trap is Level A and ships today; the
   three live regions and the two focus failures are AA; the missing Settings groups are content the
   boards specify; the missing baselines are the row's own done criterion. Everything else in §4 is
   real and none of it is a reason to hold the milestone.
2. **Land Y-353.** It deletes `components/ui/`, `index.css`'s shadcn sheet and the seven pre-M14
   routes. That is the 21.0 KiB of CSS and the ten importers standing between 159.7 KiB and the
   ceiling. Measure again after it merges; if the number still exceeds 145 KiB, the next cut is a
   route split, not a token.

   > **It landed the same day, and the number still exceeds 145 KiB.** `index.css` went 21.0 KiB to
   > 8.6 and `/` went 159.1 KiB to 146.7, then 147.3 with Y-358's screen and **147.6** with this
   > row's live region and scroll padding. The remaining 2.6 KiB is react-dom, TanStack Router and
   > Query, Base UI and the dashboard itself, so the next cut is neither a route split nor a token:
   > it is Y-357, which compresses the wire. See
   > [m14-quality-phase1.md](m14-quality-phase1.md#after-y-353-2026-09-07).

3. **Take `continue-on-error: true` off `web.yml:49`** in the same PR that gets under the ceiling —
   open row 84, and the plan already says the budget is a failing test rather than a note.

Rows 99 to 133 belong in a Y-360 sweep alongside phase 1's 66, 67, 77 and 79. They are one file each
and none of them changes a screen's shape.

**Re-run the Figma comparison the day the quota resets.** Until then §1 is a comparison against the
canvas, and the canvas is one remove from the boards the owner draws on.
