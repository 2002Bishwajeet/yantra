# M14 — the Material dashboard: the build plan

- **Date:** 2026-09-06
- **Status:** accepted by the owner's instruction of 2026-09-06; rows Y-337 to Y-356 are open
- **Decides with:** [ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md) (the
  stack), [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md) (the grant),
  [ADR-0025](../adr/0025-the-daemon-remembers-what-it-pushed.md) (proposed, the notifications list)
- **Evidence:** [R14](../research/14-material-3-expressive-on-the-web.md),
  [m14-screen-inventory.md](m14-screen-inventory.md), [m14-rust-inventory.md](m14-rust-inventory.md)

## 0. What the owner asked for, in their words

"Build them. React 19, full TanStack. Always fan out subagents; each one has a specific job:
modular packages, the testing suite, API integrations, UI design, UI review, code structure and
quality. Minimal, concise comments. Fully Material 3 compliant. Complete all the UI screens and
test end to end until it passes all the UI/UX quality with flying colours. If Rust work is left,
fan out subagents for it while the UI is built. Research Material 3 Expressive and create
reusable, modular, testable components. Use the tech stack that is memory-efficient, bundles
less, and gives a high-quality web project. Use the installed Vercel, React, TanStack, Playwright
and accessibility skills. Delete old code and components that are not needed."

## 1. The goal, as a test

M14 is done when:

1. Every board on the desktop, tablet and phone pages of the canvas (63 of 65; the ESP32 two are
   out) is a route or a state of one, and `web/e2e` opens each at 390, 834 and 1440 px.
2. Every e2e run passes axe with the `wcag22aa` tags, a keyboard walk, and a screenshot the
   reviewer has compared to the board.
3. `/` loads in 145 KiB gzip or less of JS and CSS, and the fonts in 80 KiB or less (ADR-0024 §7),
   measured by a test that fails.
4. `npm test`, `npm run e2e`, `cargo test` and `just check` are green, and the `web` workflow runs
   the e2e.
5. `web/src/components/ui/` is gone, and so is every component nothing imports.
6. The owner has opened the dashboard on a phone and an iPad, over the tailnet, and the tracker
   says so. That last step is the owner's, as it was for M5 and M13.

## 2. The approach

**Vertical slices on a walking skeleton**, which is this repo's rule (§1 of the tracker). Not a
component library finished before a page exists: the tokens, the shell and the Dashboard land as
one thin slice first, end to end, with its e2e; every later screen is a slice on that skeleton.

**Six roles, one agent each, briefs that name files.** Agents cannot see each other's work, so
each brief says which directories it owns, which it may read, and which it may not touch. The
mainline (this session) integrates: it installs dependencies, edits `package.json`, `tracker.md`
and the session log, merges, runs the full suite, and writes the sticky notes back to the canvas
when a build decision changes a board.

| Role | Owns | Loads first |
| --- | --- | --- |
| Packages | `web/src/m3/` (tokens, components, gallery) | `vercel-composition-patterns`, `vercel-react-best-practices`, R14 |
| Testing | `web/e2e/`, `web/playwright.config.ts`, the fixture server, `.github/workflows/web.yml` | `playwright-best-practices`, `accessibility` |
| API | `web/src/api/` (keys, `queryOptions`, hooks, mutations), `web/src/api.ts` types | `tanstack-query-best-practices`, `tanstack-router-best-practices` |
| Rust | `crates/*` for the rows in §4, in a worktree | crate `CLAUDE.md` and `tracker.md`, R13, ADR-0023 |
| UI | `web/src/routes/`, `web/src/shell/`, `web/src/screens/` | the board files, BRIEF.md, `vercel-react-view-transitions` |
| Review | reads everything, writes findings and small fixes | `web-design-guidelines`, `accessibility` |
| Quality | the structure and the deletions, after each wave | `vercel-react-best-practices` |

**A screen is a contract.** For each screen group the UI agent gets: the board files, the route
path, the hooks it may call (from the API agent's index), the components it may use (from the
gallery), the e2e the Testing agent wrote as a failing spec, and the done line from the tracker
row. It returns the route, its unit tests, the e2e green, and a screenshot at three sizes.

**Review is a loop, not a gate at the end.** After every wave the Review agent runs the design
guidelines and the accessibility audit on the new files and compares screenshots to boards; its
findings become fixes in the same wave. The mainline re-reads this plan every thirty minutes and
corrects drift: scope creep, a board changed without a sticky note, a rule from ADR-0024 broken.

## 3. The stack, fixed

React 19.2 with the compiler · Vite 8 · TypeScript 6 · oxlint · TanStack Router 1.170, Query
5.102, Form 1.33, Virtual 3.14, Table 9.2 · Base UI 1.6 · Tailwind 4 on M3 roles ·
`@material/material-color-utilities` 0.4 lazily · `@fontsource-variable/google-sans-flex` and IBM
Plex Mono latin · Vitest 4 + Testing Library · Playwright 1.63 + `@axe-core/playwright`.
Everything not on this list needs a line in a PR saying why.

**Errors are designed, typed and tested (owner, 2026-09-06).** The API layer has one error type
with a `kind` (`network`, `refused` with the status and the daemon's text, `missing`, `contract`,
`socket`) and no hook throws a bare `Error`. The component library has an `ErrorSurface` in the
Unreachable board's register and an `ErrorBoundary` on `react-error-boundary`, reset through
Query's `useQueryErrorResetBoundary`; the router's `defaultErrorComponent` and every route's
`errorComponent` use it, and so does every surface that can fail alone (a tab, a card, the
terminal). Every error path has a unit test, and the e2e suite has `unreachable`, `refused`
and `flaky` scenarios.

Bundle rules: no barrel files; every route lazy except `/`; Form, Table, Virtual, xterm and the
colour engine never in the `/` chunk; `npm run compiled` still proves the compiler ran;
`npm run budget` fails above the two ceilings.

## 4. The rows

Phase 0 is this document. Phases 1 to 3 run their rows in parallel where the table says so.

### Phase 1 — foundations (parallel: Packages, Testing, API, Rust ×2)

| Row | Deliverable | Done when |
| --- | --- | --- |
| Y-338 | **Tokens and the theme engine.** `web/src/m3/tokens.css` with every color, shape, typescale and motion role; sage light and dark precomputed; Clean/Compact as a `data-density` attribute; Light/Dark/System as `data-theme`; the four spring `linear()` curves; reduced-motion floor; the lazy seed engine reproducing sage within two hex units. | A test proves every role is defined in both themes, a test proves the seed engine matches `palette-sage.json`, and the `/` chunk contains no colour-engine code. |
| Y-339 | **The component library.** Every primitive on ten or more boards (inventory §E): text roles, mark + state, pill, icon button, button (filled, tonal, text, outlined), FAB, chip, row, list + list item, card, tile, lead, track, tab pills, nav rail destination, bottom nav destination, top app bar, segmented, switch, field, dialog, bottom sheet, side sheet, popover, menu, stepper, disclosure, skeleton, snackbar. One directory each under `web/src/m3/`, Base UI for behaviour, no boolean-prop variants (composition patterns skill). A dev-only gallery route lists them all. | Each component has a unit test for its roles, keyboard and states; axe passes on the gallery at three sizes; the gallery screenshot matches the board idiom. |
| Y-340 | **The test harness.** `web/e2e/` with Playwright, three projects (phone 390×844 WebKit-sized Chromium, tablet 834×1194, desktop 1440×1024), `@axe-core/playwright` with `wcag22aa`, a fixture server in Node answering `/api` and the terminal socket from `contract.gen.ts` plus scenario files (busy fleet, empty fleet, unreachable daemon, no grant), screenshot conventions, `npm run e2e`, `npm run budget`, and the `web` workflow running both. | A smoke spec opens `/` on the fixture server at three sizes and passes axe in CI. |
| Y-341 | **The API layer.** `web/src/api/keys.ts` (one factory), one `queryOptions` per read, one mutation per write with invalidation by key, hooks the routes call, `staleTime` per class matching the daemon's sweeps, the beacon, the terminal socket wrapper, and types in `api.ts` for the new routes as their Rust lands. Old `useLooked`, `useSpend`, `useTranscript` fold in and are deleted. | Every route in inventory §C has a typed hook and a fixture; existing tests pass through the new layer. |
| Y-342 | **The GitHub grant** (Rust, ADR-0023). `yantra-core/src/github.rs` device flow, `notify::write_env` composing both variables, `yantra github login|logout|status`, `POST /api/github/login`, `POST /api/github/login/poll`, `DELETE /api/github`, `GET /api/github`, `yantra ls repos`, `GET /api/repos` on a 300 s refresh class, attention over the API behind `Forge`. | Unit tests over captured JSON; an `#[ignore]` test against the real endpoint; the env file round-trips both variables; `contract.gen.ts` and `api.ts` updated. |
| Y-343 | **Daemon facts and events** (Rust, ADR-0025). `GET /api/about`, `GET /api/ssh-identity`, `Session.created_at` as an epoch, `GET /api/notifications` ring buffer, `yantra about`, `yantra ls notifications`. | Router tests on the JSON; the buffer holds 50 and drops the oldest; a restart empties it and the test says so. |
| Y-344 | **Clone and mkdir** (Rust). `yantra clone <url> --machine <m> --into <path>` running `git clone` in a tmux session, `POST /api/machines/{m}/clone` → 202 with the session name, `yantra mkdir`/`POST /api/machines/{m}/dirs` with `{make}`, no token on the wire. | A podman test clones a local bare repo through the session and `probe` sees it. |

### Phase 2 — the screens (parallel: UI ×3, Review, Quality)

| Row | Deliverable | Done when |
| --- | --- | --- |
| Y-345 | **The shell.** `/` Dashboard, `/fleet`, `/machines`, `/usage`, `/settings`, `/new` re-IA'd; desktop top bar with tab pills, search pill, bell, avatar and the sessions rail; tablet rail with FAB; phone top app bar, bottom nav and FAB; the command palette; notifications as popover, side sheet and pushed screen; avatar menu. | e2e opens every destination at three sizes; the palette finds and never runs a verb. |
| Y-346 | **Dashboard.** Main, Compact, Dark, empty; tablet and phone. Hero, status strip, needs-you list, running rows with track, unclaimed rows, Idle disclosure, Recent card (Compact). | e2e on busy and empty scenarios, three sizes, both densities, both themes. |
| Y-347 | **Fleet, Machines, one machine, Usage.** Reorder held; On GitHub card; machine cards with the four checks; readiness checklist; sessions with Terminal/Attach/Kill; Usage as a fan-out on request with by-workspace, by-model and the sessions table, no fleet total, no time window yet. | e2e for each, three sizes; Kill and Delete confirm, Stop and Resume do not. |
| Y-348 | **Session.** Chat first, then Terminal (phone key row), Transcript, Spend, ended; the composer and the option rows write to the terminal socket. | e2e against the fixture socket; the terminal test suite still passes. |
| Y-349 | **New session.** Four steps on TanStack Form: name with a generated word pair and a tile; machine chips; source GitHub (search over the swept list, "already on" via dirs), GitLab drawn disabled, local browser with New folder; start; the starting screen reading the clone session's socket. | e2e walks all four steps to a created workspace on the fixture. |
| Y-350 | **Settings.** Categories; General (local), Notifications with the sheet and switches, Providers with the connect sheet on the device flow, Agents, Appearance (live), Access, About; phone index and pushed screens. | e2e per category; the token is never drawn; Appearance changes the whole scheme without a reload. |
| Y-351 | **Dialogs and states.** Kill and Delete (dialog and bottom sheet), Repair with the numbered editor, workspace not found, Unreachable, Setup's six steps, the empty and pending catalogue. | e2e on the unreachable and empty scenarios; every board in inventory groups 6, 7, 29 to 33 has a screenshot. |

### Phase 3 — the gate and the close (Review, Quality, mainline)

| Row | Deliverable | Done when |
| --- | --- | --- |
| Y-352 | **The review loop.** Design-guidelines and accessibility audits on every new file; screenshot-to-board comparison for all 63 boards; findings fixed; the budget met. | Zero open findings; e2e and axe green at three sizes; the budget test passes. |
| Y-353 | **Cleanup and the documents.** `components/ui/` deleted; every unimported component deleted; `web/README.md`, `docs/architecture.md`, `llms.txt`, D3's amendments, the milestone row. | `git grep shadcn` is empty; the summaries name what shipped. |

### Later, not scheduled

| Row | What | Why later |
| --- | --- | --- |
| Y-354 | Usage time windows (Today, 7 days, 30 days) | needs timestamps in `tokens.rs`, I-61 and I-62 |
| Y-355 | The GitLab grant | ADR-0023 left it open |
| Y-356 | Streaming chat | ADR-0011-sized; the SDK instead of the TUI |

## 5. Decisions taken in this plan, for the owner to overturn

1. **Material's numbers win over the brief's seven near-misses** (ADR-0024 §4), because the
   owner asked for full compliance. Body 14, titles 22 and 16, hero 57 and 36, hit areas 48,
   nav bar 64, rail 96.
2. **Preferences are browser-local**, and the Appearance and General boards say "on this device".
3. **Usage ships without time windows**; the segmented control is replaced by "as read" until
   Y-354.
4. **Repository search filters the swept list in the browser**, not GitHub's search API.
5. **A clone runs in a tmux session on the machine**; the starting screen watches its socket.
6. **The chat composer writes to the terminal socket**; there is no keys route.
7. **The notifications list is an in-memory ring buffer** (ADR-0025, proposed).
8. **Board details the daemon does not know are dropped**: sshd version, ssh latency, distro
   name, the login name on `provider-auth`, known-hosts count, secret backends. The tailnet IP is
   added to `Machine` because Tailscale already reports it.
9. **Google Sans Flex is self-hosted**, weight axis only, latin subset.

## 6. Branches and merging

- `y-337-material-build-plan`: this document, the ADRs, R14, the inventories, the rows.
- `y-338-m14-foundations`: Phase 1 web rows in one checkout, disjoint directories, one PR.
- `y-342-github-grant`, `y-343-daemon-facts`: Rust rows in worktrees, one PR each.
- `y-345-m14-screens`: Phase 2, one PR per wave (shell + dashboard; fleet/machines/usage;
  session + new session; settings + states).
- `y-352-m14-gate`: Phase 3.
Every parallel branch collides on `tracker.md` and `docs/session-log.md`; only the mainline edits
them, once per merge.

## 7. Risks

- **The env file writer truncates** (inventory §1). Y-342's first test is that writing the token
  keeps the relay and writing the relay keeps the token.
- **A read handler that awaits the network.** `/api/repos` is a sweep; the search box never
  calls the daemon per keystroke.
- **The compiler bails out silently** on default-destructured props (R8). The gallery's build
  runs `npm run compiled` and the logger; a bail-out in `m3/` is a failing check.
- **Three form factors triple the e2e time.** Playwright shards by project in CI.
- **Worktrees eat disk** (memory): prune each Rust worktree after its merge.
