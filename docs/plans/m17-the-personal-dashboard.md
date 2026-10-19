# M17: the personal dashboard

- **Asked 2026-10-19 by the owner (Y-500):** "It should be fully personalised and should highlight every key important thing that I need to know, so the widget grid makes sense."
- **Decided:** the owner chose the widget grid after the cost of testing at three sizes was raised. This plan builds the grid and does not argue the choice again.
- **Yantra read at:** `main` at `dc84722` on 2026-10-19. Paths are relative to the repository root.
- **Read against:** [ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md), [ADR-0019](../adr/0019-a-probe-that-asks-a-machine-is-a-post.md), [ADR-0021](../adr/0021-the-relay-is-written-to-an-environment-file.md), [D3](../design/03-dashboard-surface.md), [the M14 plan](m14-the-material-dashboard.md), [the M16 plan](m16-the-coding-loop.md), `CLAUDE.md` §B1, `web/scripts/budget.mjs`.

## 1. The demo that closes the milestone

The owner opens `/` on the phone, the iPad and the laptop. Each device shows a useful default layout before any setup. On the laptop the owner taps **Edit**. The owner drags *PR checks* next to *Needs you*, makes *Machines* small, removes *Idle* and adds *Spend* for one workspace. The owner taps **Done**. The page keeps that layout after a reload. On the phone the owner moves *PR checks* to the top with the keyboard-free move buttons. The owner copies a layout link on the laptop and opens it on the iPad, and the iPad takes that layout after the owner confirms. When the daemon is down, each widget shows its own designed error. The rest of the page stays usable.

**Done when** Playwright walks that demo on the fixture at 390, 834 and 1440 with axe, `npm run budget` passes, and the owner walks it once on their real devices.

## 2. Findings that shape the plan

1. **The dashboard is eager.** `web/src/router.ts:21` imports `Home` directly, so every widget that is drawn by default costs first-load bytes. New widgets must load lazily, and only when they are in the layout.
2. **Budget headroom is about 40 KiB, and that number is old.** `npm run budget -- --no-build` on the `dist/` of 2026-09-30 gives 163,081 B against 204,800 B, so 41,719 B are left. The fonts have 1,492 B left. The source has changed since 2026-10-08, so Y-505 measures again on `main` before it starts.
3. **Two reads must never poll.** Spend (`POST …/tokens`) reads a transcript over ssh. ADR-0019 and `spendQuery` keep it on request only. M16's `GET …/threads` runs `git worktree list` over ssh for each workspace (`crates/yantra-core/src/thread.rs:51`). A widget may read either one only when the owner asks, or once when the widget mounts.
4. **No fleet total for money.** ADR-0024's consequences keep D6 §5.1: there is no spend total across workspaces. The Spend widget shows the workspaces the owner pins, one by one.
5. **Key expiry is half there.** `Machine.expired` exists. Tailscale's `KeyExpiry` date is in `tailscale status --json` (`crates/yantra-core/tests/fixture/tailscale-status.json:38`), but no code parses it. So "expires in 9 days" needs a small Rust row.
6. **PR state has no fleet-wide read.** The Y-494 watcher keeps PR state in memory. M16 gives it no `GET`. A dashboard widget needs one cheap in-memory route.
7. **`GET /api/tasks` calls `allowed()`** (`crates/yantrad/src/tasks.rs:283`). A browser on a node that is not the owner's gets 403 there, but the other reads still work. The Delegations widget must draw that refusal as a typed state.
8. **Neither react-grid-layout nor gridstack documents keyboard move or resize.** Their READMEs at 2.3.0 and 14.0.0 do not mention it. dnd-kit ships a keyboard sensor and screen-reader announcements.

## 3. The widget catalogue

### 3.1 What every widget shares

Each widget is a record in one registry: `id`, `title`, the sizes it allows, a data hook, and a render function for each size. Its data hook returns one typed view:

```ts
type WidgetView<T> =
  | { state: 'reading' }                       // first read in flight: Skeleton
  | { state: 'ok'; data: T; age: number }      // drawn; age feeds the stamp
  | { state: 'empty'; line: string }           // one quiet line (D7 S13)
  | { state: 'never'; what: string }           // not looked at yet (D3 §7.1)
  | { state: 'failed'; error: ApiError }       // ErrorSurface.Inline + Try again if retryable
  | { state: 'refused'; error: ApiError }      // 403/503 from allowed(): says why, no retry
  | { state: 'unsupported'; route: string }    // 404 on a route this daemon is too old for
  | { state: 'blocked'; on: string }           // a read it depends on failed; names that read
```

Two things wrap every widget:

- **A per-widget `ErrorBoundary`** for a render crash: "*Title* could not be drawn". This is the pattern `Dashboard.tsx` uses today.
- **The page-level "Nothing here can be reached" surface** (`Dashboard.tsx:761`). It stays: when every read fails, the page says so once, and the widgets do not each show the same error.

`ApiError` (`web/src/api/errors.ts`) gives `describe()` and `said`, and only `network` can be tried again. Each widget has a Vitest component test for every state it can reach, and the e2e specs draw the failed states from fixture scenarios (`refused.json`, `flaky.json`, `nogrant.json`, `unreachable.json`, and new ones where the table says so).

### 3.2 Sizes

| Size | Desktop, 4 tracks | Tablet, 2 tracks | Phone, 1 column |
| --- | --- | --- | --- |
| **S** | 1 track × 1 row: a count and one line | 1 × 1 | one line |
| **M** | 2 × 1: up to about 5 rows | 2 × 1 | a card |
| **L** | 2 × 2: everything, plus detail | 2 × 2 | not offered; shown as M |

### 3.3 The widgets

| Widget | Shows | Data source (exists?) | S | M | L | States beyond reading and ok |
| --- | --- | --- | --- | --- | --- | --- |
| **Needs you** | Trust prompts, crashes, unclear agents, broken files, review requests, assigned issues | `work()` needs band from `/api/workspaces` + status; `/api/attention` (yes) | count + top item | rows, with Answer, Open and Repair | all rows + GitHub unread count | `failed` (workspaces); GitHub part `failed` or `never` on its own line; `empty` "Nothing needs you" |
| **Running** | Live sessions, elapsed time, track | `work()` running band + `/api/sessions` (yes) | count + longest | rows | rows + Open buttons | `blocked` on workspaces; `empty` |
| **Machines** | Online count, asleep and not-answering machines, heartbeat | `/api/machines` (yes) | "5 of 6 online" | list with state | list + CPU, RAM, disk, battery from `heartbeat` | `failed`; a machine with `heartbeat: null` shows "never heard from" (I-47) |
| **Readiness** | Machines with `absent` checks | `/api/readiness` (yes) | count of machines with gaps | machine + missing checks | + `detail`, Recheck (POST, debounced) | `unknown` is never shown as absent (R-23); `failed` |
| **Keys** | Node keys expired or expiring within 14 days | `Machine.expired` (yes); `key_expires` (Y-509) | count | list with dates | — | `empty` "No key expires in 14 days"; before Y-509 it shows expired keys only |
| **GitHub inbox** | Review requests, assigned issues, unread count | `/api/attention`, `/api/github` (yes) | counts | rows | rows + Start session (after Y-489) | `refused`-like "GitHub is not connected" with a link to Settings › Providers (from `Connection.connected`); `failed`; own 300 s stamp (D6 §2) |
| **PR checks** | Each watched PR: checks, review state, Fix and Merge links | `GET /api/pulls` (Y-512, after Y-494) | failing count | PR rows with check marks | + review comments count, Open in Chat | `unsupported` on an older daemon; `empty` "No open PRs" |
| **Threads** | Threads with a PR, plus the threads of live workspaces | `/api/pulls` (Y-512); `GET …/threads` (Y-488) on mount and on Refresh only | count | rows | + branch and issue | `failed` for each workspace, named; never on a timer (finding 3) |
| **Worth a look** | tmux sessions no workspace claims | `/api/sessions` + workspaces (yes) | count | rows with Attach and Kill | same | `failed`; `blocked` "no workspace list to check against" |
| **Idle** | Idle workspaces | `work()` idle band (yes) | count | names | grid of rows (today's Compact grid) | `empty` "no idle workspaces" |
| **Recent activity** | The last session events | `/api/notifications` (yes) | newest event | 5 events | 15 events | `failed`; `empty` "Nothing has happened since the daemon started" (I-59) |
| **Spend** | Pinned workspaces' cost for a span (Today, 7 days, 30 days) | `POST …/tokens` with `since` (yes), on request only | one figure | each pinned workspace + span picker | + model split | not asked, `nothing` (409), `refused` (status), `failed`; the answer keeps its arrival stamp; no total |
| **Appliance** | Version, uptime, update available, relay set, GitHub connected | `/api/about`, `/api/github` (yes); Update is `POST /api/update` (yes) | version + "update available" | + Update button, relay, grant | — | `published.looked: 'failed'` says "could not check for updates" with `said`; Update refused draws the 403 sentence |
| **Delegations** | ACP tasks Claude delegated, with state | `GET /api/tasks` (yes, in memory) | running count | rows with Stop | — | `refused` on a non-owner node (finding 7); `empty` |

**Outside the grid, always drawn:**

- **The status strip**: machines online and the freshness stamp, as today.
- **Finish setup**.
- **The reorder pill** (D3 §4.4).
- **The first-run Setup page**, which still replaces the whole page.

The strip gains one rule: when *Needs you* is not in the layout and something needs the owner, it adds "· 2 need you →". The owner can then remove any widget and still never lose what needs them. This is the one guard. It is not a lock.

## 4. The grid

### 4.1 Library: `@dnd-kit/core` 6.3.1 with `@dnd-kit/sortable` 10.0.0, in a lazy edit chunk

| Option | Version, licence | min+gzip (bundlephobia) | Touch | Keyboard move and resize | React 19 |
| --- | --- | --- | --- | --- | --- |
| react-grid-layout | 2.3.0, MIT | 24,754 B, plus react-draggable | yes, but drag fights the page scroll | not documented | peer `>=16.3`; uses prop-types |
| gridstack | 14.0.0, MIT | 25,126 B + 1,436 B CSS | yes (`dd-touch`) | not documented | imperative DOM; the React wrapper is new in v12 |
| `@dnd-kit/react` | 0.5.1, MIT | 32,978 B + deps | yes | yes | peer `^19`, but pre-1.0 and changing every week |
| **`@dnd-kit/core` + `sortable`** | **6.3.1 + 10.0.0, MIT** | **14,237 + 3,670 B** | **yes, TouchSensor with a delay** | **KeyboardSensor + announcements** | **peer `>=16.8`; widely used on 19** |

**Why:** the sizes are discrete (S, M, L), so the page needs no free-form resize engine. A grid engine is mostly bytes for features this page does not use. View mode is a plain CSS grid and loads no drag code at all. dnd-kit loads only when the owner taps **Edit**, so `/` pays 0 B for it. It is the smallest option, and it is the only one with keyboard support built in. That satisfies §B1 (a battle-tested package) and ADR-0024 §7 (the budget).

**Resize is a menu, not a handle.** Each widget's menu holds a Material segmented button for S, M and L. It works the same way with a mouse, a finger, a keyboard and a screen reader, and it needs no package.

### 4.2 The CSS grid

- `grid-template-columns: repeat(4, 1fr)` on desktop and `repeat(2, 1fr)` on tablet. Each size sets `grid-column: span n` and `grid-row: span n`. The breakpoints come from `shell/formFactor.ts`.
- **No `grid-auto-flow: dense`.** Dense packing would make the visual order differ from the DOM order, and that breaks focus order (WCAG 2.4.3, 1.3.2). An S widget can leave a gap. The default layouts are planned so that they leave none.
- Rows size to their content (`grid-auto-rows: minmax(min-content, auto)`). L clamps its list and links to the full screen.

### 4.3 The phone: a reorder-only list

**Decision: a one-column list.** On the phone the owner can reorder, add and remove widgets, and pick S (one line) or M (a card). L is not offered. A two-column phone grid at 390 px would make every M card a cramped half-width tile, and it would double the screenshots for the size that matters most (D3 §10). Moving works with Move up and Move down in each widget's menu, and dnd-kit's long-press drag is available as a second way.

## 5. Where the layout is kept

**Decision: in this browser's `localStorage`, under its own key, `yantra.dashboard`.** The layout is not synced.

```ts
type Layout = { v: 1; phone: Item[]; tablet: Item[]; desktop: Item[] }
type Item = { id: WidgetId; size: 'S' | 'M' | 'L'; pins?: string[] } // pins: Spend's workspaces
```

- **Its own key, not `yantra.prefs`.** `index.html` reads `yantra.prefs` before the first paint (`shell/prefs.ts:5`), and a layout has no reason to touch that script.
- **One layout for each form factor.** The phone list and the desktop grid are different things. If an iPad rotates past 1240 px, it uses the desktop layout.
- **Read with a hand-written guard.** An unknown widget id is dropped. A bad size falls back to the widget's default. A file that cannot be parsed falls back to the default layout, and a snackbar says "Your saved layout could not be read, so the default is shown." Private mode keeps the layout in memory, as `writePrefs` does. A `storage` event updates other tabs.
- **No ADR is needed for this.** ADR-0024 §5 already makes preferences browser-local and rejects server-held preferences. Y-503 adds a dated blockquote that names the layout.

**Why not sync.** The daemon persists nothing about the fleet (§B1), and it writes one file, which is configuration (ADR-0021). Sync would need a new ADR that supersedes ADR-0024 §5 and amends ADR-0021 and §B1. Its smallest form would be a `dashboard.json` that the daemon writes. That is a second file of state for a layout, and the layouts differ by form factor anyway.

**The smallest way across devices, with no ADR: a layout link.** Edit mode has **Copy layout link**. It puts the layout, base64url-encoded, in the URL fragment (`/#layout=…`). The fragment never reaches `yantrad` or its logs. Opening the link on another device asks "Use this layout on this device?" and then replaces that device's layout. This is Y-514.

## 6. The default layout and edit mode

### 6.1 Defaults (good with zero setup)

| Order | Desktop and tablet | Phone |
| --- | --- | --- |
| 1 | Needs you, L | Needs you, M |
| 2 | Running, M | Running, M |
| 3 | Machines, S | PR checks, S |
| 4 | Appliance, S | Machines, S |
| 5 | PR checks, M | GitHub inbox, S |
| 6 | GitHub inbox, M | Worth a look, S |
| 7 | Worth a look, M | Recent activity, S |
| 8 | Recent activity, M | Idle, S |
| 9 | Idle, M | Appliance, S |

- The defaults keep D3 §4's order, which is who must act next: the owner first, then the agent, then nobody.
- PR checks is in the default layout only when the daemon answers `/api/pulls`. Before that, the widget is not placed.
- Keys, Readiness, Spend, Threads and Delegations are in the Add sheet only.
- **Density** (Clean or Compact) no longer changes the layout. It changes only spacing. Today's Compact pairing of Idle and Recent becomes "Idle at L, Recent at M". Y-503 records this in D8.

### 6.2 Edit mode

- **Enter:** an **Edit** icon button beside the Dashboard title. The FAB keeps New session.
- **While editing:** the widget content is `inert`, so a tap moves the widget and does not follow a link. Each widget shows a drag handle and a menu with Move earlier, Move later, Size (S, M, L), Remove, and, for Spend, Choose workspaces.
- **The top bar** has **Add widget**, **Reset**, **Copy layout link** and **Done**. Esc also ends edit mode.
- **Add widget** opens a side sheet on desktop and tablet, and a bottom sheet on the phone. It lists the widgets that are not placed, with one line about each. A widget that is new since the last edit has a "New" badge.
- **Remove** shows a snackbar with Undo.
- **Reset** asks for confirmation in a dialog and resets this form factor only.
- **Saving:** every change saves at once. There is no Save button.
- **Announcements:** each move and resize is announced through `m3/live`, for example "Machines moved to position 3 of 9".

## 7. Rows

Numbers continue from Y-502. **Each web row ships its Playwright spec at 390, 834 and 1440 with axe (`wcag22aa`) and a keyboard walk, and keeps `npm run budget` green.** Each Rust row regenerates `contract.gen.ts` with `just fixtures`.

| ID | Title | Done when … | Kind | Paths | Depends | needsOwner |
| --- | --- | --- | --- | --- | --- | --- |
| Y-503 | D8: the widget boards, and the ADR-0024 amendment | D8 shows each widget at S, M and L and in its error states, plus edit mode at three sizes. ADR-0024 has a dated blockquote: the layout is browser-local under §5, and dnd-kit loads only in edit mode. | docs | `docs/design/08-personal-dashboard.md`, `docs/design/canvas/*`, `docs/adr/0024-*.md`, `tracker.md` | Y-500 | yes |
| Y-504 | The layout store | `yantra.dashboard` reads, guards, saves and syncs across tabs, with one layout for each form factor. Vitest covers corrupt, unknown-id, private-mode and default cases. | web | `web/src/screens/dashboard/layout.ts`, `layout.test.ts` | Y-503 | no |
| Y-505 | The widget frame and the grid | The dashboard draws today's bands as registry widgets in the default layout, on a CSS grid at three sizes. `dashboard.spec.ts` still passes, and the entry grows by less than 6 KiB. | web | `web/src/screens/dashboard/{Dashboard,Grid,registry,Widget}.tsx`, `Dashboard.css`, `web/e2e/dashboard.spec.ts` | Y-504 | no |
| Y-506 | Today's bands at S, M and L | Needs you, Running, Machines, Worth a look, Idle, Recent activity and GitHub inbox each draw at their sizes and in every typed state. A component test covers each state. | web | `web/src/screens/dashboard/widgets/*`, `web/e2e/widgets.spec.ts`, `web/e2e/fixture/scenarios/*` | Y-505 | no |
| Y-507 | Edit mode without drag | Edit, the widget menu, Add, Remove with Undo, Reset and Done work with a keyboard and a touch screen at three sizes. The strip names needs-you items when Needs you is removed. | web | `web/src/screens/dashboard/{Edit,AddSheet,WidgetMenu}.tsx`, `web/e2e/edit.spec.ts` | Y-506 | no |
| Y-508 | Drag to move, in a lazy chunk | `@dnd-kit/core` and `@dnd-kit/sortable` move widgets by mouse, touch and keyboard, with announcements. `budget.mjs` measures the edit chunk under its own 25 KiB line, and `/` does not grow. | web | `web/src/screens/dashboard/Drag.tsx`, `web/package.json`, `web/scripts/budget.mjs`, `THIRD_PARTY_NOTICES.md`, `web/e2e/edit.spec.ts` | Y-507 | no |
| Y-509 | A machine's key expiry | `Machine` carries `key_expires` from Tailscale's `KeyExpiry`, and `null` when there is none. The inventory test reads the fixture, and the contract is regenerated. | rust | `crates/yantra-core/src/inventory.rs`, `crates/yantrad/src/api.rs`, `crates/yantrad/src/contract.rs`, `web/src/api.ts` | — | no |
| Y-510 | Fleet health widgets | Machines at L with heartbeat, Readiness, Keys and Appliance draw at their sizes and states. Appliance's Update button uses the existing mutation and draws its refusals. | web | `web/src/screens/dashboard/widgets/{Readiness,Keys,Appliance}.tsx`, `web/e2e/widgets.spec.ts` | Y-506, Y-509 | no |
| Y-511 | Spend and Delegations widgets | Spend reads pinned workspaces for a span only on request and shows no total. Delegations lists `/api/tasks` and draws a 403 as refused. | web | `web/src/screens/dashboard/widgets/{Spend,Delegations}.tsx`, `web/src/api/{queries,hooks}.ts`, `web/e2e/widgets.spec.ts` | Y-507 | no |
| Y-512 | `GET /api/pulls`: the watched PRs | The route serves the Y-494 watcher's in-memory PRs as a `Looked` list, with no GitHub or ssh call. A test checks the shape and the contract. | rust | `crates/yantrad/src/{watch,api}.rs`, `crates/yantrad/src/contract.rs`, `web/src/api.ts` | Y-494 | no |
| Y-513 | PR checks and Threads widgets | PR checks shows each PR's checks and links to Fix and Merge in the Chat. Threads reads `…/threads` only on mount and on Refresh, and both draw `unsupported` on an older daemon. | web | `web/src/screens/dashboard/widgets/{Pulls,Threads}.tsx`, `web/e2e/widgets.spec.ts` | Y-512, Y-488, Y-506 | no |
| Y-514 | The layout link, and the owner's walk | Copy layout link writes the layout to the fragment, and opening the link asks before it replaces the layout. The owner walks §1 on the phone, the iPad and the laptop. | web | `web/src/screens/dashboard/{layout,Edit}.ts*`, `web/e2e/edit.spec.ts`, `tracker.md` | Y-508, Y-510, Y-511 | yes |

**Build order:**

1. Y-503, then Y-504, then Y-505, then Y-506.
2. Y-507, with Y-509 beside it (different paths).
3. Y-508, Y-510 and Y-511 together.
4. Y-512 and Y-513 when M16's Y-494 and Y-488 have merged.
5. Y-514 last. It does not wait for Y-513.

**Milestone row for `tracker.md` §2:** M17, *The personal dashboard*. The definition of done is §1. Status ⬜ todo, planned 2026-10-19, this plan, Y-503…Y-514.

## 8. Risks and unknowns

- **The test matrix is large.** There are 14 widgets, 3 sizes, 3 form factors and up to 8 states. To keep it in hand:
  - The phone offers only S and M.
  - Vitest component tests cover each state.
  - Playwright takes screenshots of the default layout and of edit mode for each form factor, and draws each widget's failed state once at each size.
  - If e2e time grows past 2× today's, the widget specs run each state at one size and only the default layout at all three.
- **The budget.** `/` had about 40 KiB of headroom on an old build. Today's widgets stay eager. Every new widget is `lazy()` and loads only when it is placed. dnd-kit loads only in edit mode. The fonts have 1.5 KiB left, so the plan adds no font and no icon font.
- **`@dnd-kit/core` has had no release since 2024-12-05.** The menu path works without it, so the page loses nothing if the package breaks. If it breaks under the React Compiler, Y-508 turns the compiler off for `Drag.tsx` alone. When `@dnd-kit/react` reaches 1.0, a row moves to it.
- **The owner can hide the thing that needs them.** The strip's "N need you" line is the guard. Y-507 tests it.
- **Layouts differ by device.** The owner may expect sync. The layout link covers this without daemon state. If the owner wants real sync, that is a new ADR, and this plan does not write it.
- **More widgets, more reads.** Widgets share query keys with the screens, so a read is made once. Spend and Threads never poll (ADR-0019). Delegations and PRs are in-memory reads.
- **Held order still matters inside widgets.** `useHeldBands` moves up into one provider that every band widget reads, so the reorder pill keeps working (D3 §4.4). The grid itself never moves on its own, which makes the positions more stable than they are today.
- **PR checks waits on M16.** Until Y-494 lands, the widget is not offered. On an older daemon it draws `unsupported`.
- **Unknown:** whether 14 days is the right warning time for key expiry. Y-503 asks the owner on the D8 boards.

## Sources

All accessed 2026-10-19.

- Yantra on `main` at `dc84722`:
  - `CLAUDE.md` §6, §B0, §B1; `tracker.md` (Y-449, Y-487…Y-502, M16).
  - `docs/adr/0019-*.md`, `0021-*.md`, `0024-*.md` (with the Y-370 and Y-383 notes).
  - `docs/design/03-dashboard-surface.md` §1, §4, §7, §9.1, §10; `docs/plans/m14-the-material-dashboard.md`; `docs/plans/m16-the-coding-loop.md`; `docs/plans/v0.7.2-qa-pass.md` §6.
  - `web/package.json`, `web/scripts/budget.mjs` (run with `--no-build` on the `dist/` of 2026-09-30), `web/playwright.config.ts`, `web/e2e/dashboard.spec.ts`, `web/e2e/fixture/scenarios/`.
  - `web/src/router.ts`, `web/src/screens/dashboard/{Dashboard,Home,bands}.ts*`, `web/src/shell/{prefs,formFactor}.ts`, `web/src/api.ts`, `web/src/api/{errors,queries,hooks}.ts`, `web/src/lib/spend.ts`, `web/src/screens/usage/span.ts`, `web/src/m3/` (listing).
  - `crates/yantrad/src/{api,write,tasks,contract}.rs` (route tables), `crates/yantra-core/src/thread.rs`, `crates/yantra-core/tests/fixture/tailscale-status.json`.
- npm registry, read with `npm view` (version, licence, peerDependencies, dependencies, unpackedSize, time):
  - `react-grid-layout@2.3.0`, `gridstack@14.0.0`
  - `@dnd-kit/core@6.3.1` (published 2024-12-05), `@dnd-kit/sortable@10.0.0`, `@dnd-kit/react@0.5.1` (published 2026-10-15), `@dnd-kit/dom@0.5.1`, `@dnd-kit/helpers@0.5.1`
  - `@atlaskit/pragmatic-drag-and-drop@4.0.0`, `@atlaskit/pragmatic-drag-and-drop-react-accessibility@3.2.4`, `react-resizable@4.0.2`
- Package READMEs from the registry tarballs: `react-grid-layout@2.3.0` and `gridstack@14.0.0`. Neither documents keyboard move or resize.
- Bundlephobia size API, <https://bundlephobia.com/api/size?package=…>, for min+gzip of `react-grid-layout@2.3.0`, `gridstack@14.0.0`, `@dnd-kit/react@0.5.1`, `@dnd-kit/core@6.3.1` and `@dnd-kit/sortable@10.0.0`.
