# R25 — Phone UX and agent-flow audit

Access date for every live reading: 2026-11-08. Owner, same day, after QA from the phone: "the UX is
horrible. It doesn't feel native."

This note changes no code, ADR or tracker row. It lists faults, names the file behind each one, and
proposes PR-sized items. The ADR and practice audit is Y-659's other half and is not here.

## How I looked

- **Live product.** The dashboard on `yantra-box`, `http://100.95.169.83:7717`, version 0.10.3 (the same
  as `main`). I only read. I opened a session's terminal page, which attaches to a tmux pane, and I sent
  no key.
- **Profiles.** Chromium 156 with a 390 x 844 phone profile (`isMobile`, `hasTouch`, scale 3). Only
  Chromium is installed, so the iPhone 15 profile ran on Chromium too. **WebKit behaviour (rubber band,
  keyboard, safe areas, sticky hover) is read from code and not measured.**
- **Screens.** Dashboard, Fleet, Machines, a machine page, New session (steps 1 and 2), a workspace's
  Chat, Terminal and thread menu, Notifications, Usage, Rooms, Add device, all of Settings, and
  landscape. Screenshots are in `~/yantra-mobile-audit/2026-11-08/` (outside the repo).
- **Not walked.** A thread with tool calls and an approval card: the box has no such thread, and I may
  not start one. I read `web/src/screens/session/Chat.tsx` for those. New session's Start step (it would
  create a session).
- **T3 Code** at `~/Github/t3code-ref`, commit `67eebaca`. Its `apps/web` is a browser app like ours.
  Its `apps/mobile` is a native Expo app, so we copy ideas from it and not files.

## The five worst faults

1. **The dashboard is a web page, not an app frame.** The document scrolls. The top bar scrolls away.
   Dashboard is 3,416 px tall. Nothing stops the page rubber-banding or pulling to refresh.
   (Item F1.)
2. **The base touch rules are missing.** No `overscroll-behavior`, no `touch-action: manipulation`, no
   `user-select: none` on controls, and nearly every `:hover` rule is not gated, so a tapped control
   stays "hovered". (Item F2.)
3. **The keyboard is not planned for.** The viewport meta has no `interactive-widget=resizes-content`,
   and the composer is `position: sticky`. On Android Chrome the keyboard can cover the composer. T3
   sets the meta tag. (Item F3. Needs a real phone to confirm.)
4. **Approvals and questions are weak.** A question from Claude reads "asks to use a tool" with Accept
   and Decline. Threads are named by hex id. The push says "chat thread 2dc4acd8dfa61561 waits for an
   answer" and carries no link, so a tap opens nothing in particular. (Items C1, C2, C6; rows Y-649,
   Y-654.)
5. **The floating "New session" button covers content.** On Dashboard it sits on the first "Open"
   button; on Machines "Add a device" sits on the readiness text. (Item F4.)

## What is already right

Do not redo these. The shell has a status-bar strip and safe-area padding (`Shell.css`), a bottom bar
with `env(safe-area-inset-bottom)`, light and dark `theme-color` tags that follow the owner's theme
choice, a service worker, a standalone manifest, a 16 px composer font, no horizontal overflow on any
screen I walked (390 px wide everywhere, including `/machines/add`, so Y-645's overflow is fixed), and
48 px hit areas drawn by `.m3-interactive::after` around 34 to 40 px controls. A raw measure of those
buttons reads 40 px high and is not a fault.

## Items, foundation first

Each "Done when" names a Playwright check at 390 x 844 in the `phone` project
(`web/playwright.config.ts`, `--project=phone`) using the `scenario()` fixtures in `web/e2e/lib`.

### Foundation

**F1. Make the phone shell an app frame.**
- Fault: the document is the scroller. `.shell` is `min-height: 100dvh`, and the top app bar has no
  `position: sticky`, so the title and back arrow leave the screen. A pull past the top can scroll the page
  or refresh it on Android (from code; not measured). Seen on every screen; the keyboard-size test of Chat showed the bar gone.
- Root cause: `web/src/shell/Shell.css` (`.shell`, `[data-shell="phone"] .shell__main`),
  `web/src/m3/top-app-bar/*.css`, no rule on `html`/`body` in `web/src/index.css`.
- T3: `apps/web/src/index.css` lines 1735 to 1752 (`html, body { overscroll-behavior: none }`,
  `body { height: 100%; overflow: hidden }`, `#root` clips and owns the scroll). **Copy the idea in
  part.** Yantra's FAB, rail and `scroll-padding` rules rely on a document scroller (comment in
  `Shell.css`, line 150), so on the phone shell only: `html { overscroll-behavior: none }`, a sticky top
  bar, and `.shell__main` as the scroll container.
- Row: none. Y-645 (small faults) does not cover it.
- Done when: on `/`, after scrolling 600 px, the top bar's `getBoundingClientRect().top` is 0 (plus
  the safe-area inset), and `getComputedStyle(documentElement).overscrollBehaviorY` is `none`.

**F2. Add the base touch rules.**
- Fault: `-webkit-tap-highlight-color` is set only on `.m3-interactive` (`tokens.css` line 584), so
  plain links flash. No `touch-action: manipulation` anywhere (the 300 ms rule applies on iOS in some
  cases). Controls can be selected by long press: only the Talk button and the menus set
  `user-select: none`. There is no `-webkit-text-size-adjust`. `:hover` has 5 rules in CSS and 1 is
  gated by `(hover: hover)`; `tokens.css` line 604 (`.m3-interactive:hover::before`) is not, and it is
  on every button and chip. A tapped button keeps its hover layer on touch.
- Root cause: `web/src/index.css`, `web/src/m3/tokens.css`, `Composer.css` line 335, `AddDevice.css`
  line 75, `Fleet.css` lines 87 to 88.
- T3: `apps/web/src/index.css` line 12 gates hover with a custom `any-hover` variant. **Copy the idea**;
  Yantra writes hand CSS, so wrap each rule in `@media (hover: hover) and (pointer: fine)`.
- Row: none.
- Done when: a test reads `getComputedStyle` of `html` (tap colour transparent), a plain `<a>` and a
  `button` (`touch-action: manipulation`; the button `user-select: none`), and a stylesheet scan finds no
  `:hover` rule outside a `(hover: hover)` block.

**F3. Fix the viewport and installed-app metadata.**
- Fault: the viewport meta is `width=device-width, initial-scale=1.0, viewport-fit=cover`. It lacks
  `interactive-widget=resizes-content`, so on Android Chrome the keyboard overlays the sticky composer
  and `dvh` does not shrink. `manifest.webmanifest` has `theme_color` and `background_color` of
  `#151714` (dark) only, so a light-theme owner sees a dark splash. The manifest has no `id`, no
  `screenshots`, no `shortcuts` (New session). The page is plain `http://…:7717`, which is not a secure
  context: the service worker and the install prompt do not run there (Y-652 covers the HTTPS door).
- Root cause: `web/index.html` line 6, `web/public/manifest.webmanifest`.
- T3: `apps/web/index.html` line 5 to 8 has the exact meta tag. **Copy it.**
- Row: Y-652 covers HTTPS only.
- Done when: a test reads the viewport meta and finds `interactive-widget=resizes-content`, and one
  test reads the manifest for `id`, a `shortcuts` entry for `/new`, and a `background_color` equal to the
  light surface. The keyboard case needs the owner's phone (listed in the release smoke pass).

**F4. Stop the floating action button covering content.**
- Fault: `.shell__fab` is fixed at 80 px above the bottom. It covers the first "Open" button on
  Dashboard, and the readiness text on Machines. The page leaves 136 px at its end only, so mid-scroll
  the button sits on content. It also shows on Fleet, where "New session" is not the screen's main action.
- Root cause: `web/src/shell/Shell.css` lines 200 to 230, `web/src/shell/primary.ts`.
- T3: none (T3 web has no FAB; its mobile app puts the action in the header). **Do not copy.** Use M3
  Expressive's rule: an extended FAB collapses to an icon on scroll down and shows on scroll up.
- Row: none.
- Done when: at `/` and `/machines`, for each scroll offset in 0, 300 and 600 px, the FAB's rectangle
  overlaps no `a` or `button` rectangle other than itself.

**F5. Raise plain links to a 44 px hit area.**
- Fault: links without `.m3-interactive` are small: Fleet machine names 200 x 24, "Open 316 on GitHub"
  138 x 16, Dashboard's "Open →" 36 x 20, Notifications' "Settings" 54 x 20, the machine link in a
  session's terminal header 72 x 15, the Tailscale link 138 x 15.
- Root cause: `Fleet.css` (`a.fleet__name`, `a.fleet__machine`), `AddDevice.css`, the dashboard's
  status line, and `Terminal` header. Give them `.m3-interactive` or a `min-block-size: 44px`.
- T3: none needed.
- Row: none.
- Done when: a test collects every visible `a` and `button` at `/`, `/fleet`, `/machines`,
  `/notifications` and `/w/<name>`, adds the `::after` extent of `.m3-interactive`, and finds none under
  44 x 44.

**F6. Make screen changes feel like an app.**
- Fault: every route change is a hard cut. There is no view transition, no shared-element motion, no
  predictive back. The back arrow is at the top left, far from the thumb. I did not measure loading
  states because the box answers in under 2.5 s; the screens show skeletons in code (`m3/skeleton`), so
  I cannot call this a fault.
- Root cause: `web/src/router.ts` (no `viewTransition`), `web/src/shell/Shell.tsx`.
- T3: `apps/web/src/components/ui/sheet.tsx` and `sidebar.tsx` for sheets. T3's mobile app uses a
  native stack for transitions; **do not copy**, use TanStack Router's `viewTransition` option and
  `vercel-react-view-transitions`.
- Row: none.
- Done when: a test navigates Dashboard to Machines to a machine page and finds
  `document.startViewTransition` was called each time, with `prefers-reduced-motion: reduce` calling it
  zero times.

**F7. Use the phone shell on a phone held sideways.**
- Fault: at 844 x 390 the width media query picks the tablet shell. A 96 px rail takes a quarter of the
  width, and the terminal's own 390 px height leaves no room for the page below it. Seen in
  `android-landscape-*.png`.
- Root cause: `web/src/shell/formFactor.ts` (width only, 600 px).
- T3: none. Add `(max-height: 500px) and (orientation: landscape)` to the phone query.
- Row: none.
- Done when: at 844 x 390 with `hasTouch`, `[data-shell]` is `phone`.

### Chat

**C1. Fix the thread list and header.**
- Fault: the thread menu lists `2dc4acd8dfa61561` and "no PR". The header, tabs, thread picker and the
  Diff and Commit bar take about 220 px before the first message. "Nothing asked yet" shows with Diff and
  Commit beside it, though Y-633 is marked done.
- Root cause: `web/src/screens/session/ChatHeader.tsx`, `GitActions.tsx`, `threads.ts`.
- T3: `apps/web/src/components/Sidebar.tsx` and `chat/ChatHeader.tsx`; on the phone, T3 collapses its
  sidebar into a `Sheet` (`ui/sidebar.tsx`, `isMobile`). **Copy.**
- Row: Y-649 (hex ids), Y-644 (ids and tmux text), Y-633 (layout). A new row is only needed for "hide
  Diff and Commit until a branch has changes".
- Done when: at 390 px an empty thread shows its first message line within 160 px of the top, no hex id
  appears in `body`, and Diff and Commit are hidden.

**C2. Answer approvals and questions at the composer.**
- Fault: `Asking` in `Chat.tsx` (line 130) shows "asks to run / change / read" or "a tool" with three
  buttons. A question with options has no option buttons and no free-text answer. The card sits in the
  timeline, so it scrolls away.
- Root cause: `web/src/screens/session/Chat.tsx` lines 62 to 170.
- T3: `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx` and
  `ComposerPendingUserInputPanel.tsx`. **Copy**; both are in Y-654's row.
- Row: Y-654.
- Done when: with a fixture request that has three options, the composer shows three option buttons
  at least 44 px high, and a second fixture with an approval keeps the card visible while the timeline
  scrolls (`scenario(page, 'asking')`).

**C3. Group tool calls and render replies as T3 does.**
- Fault: every tool call is a card of equal weight; replies are plain text. On a phone one turn is many
  screens tall.
- Root cause: `Chat.tsx` (`Tool` card), `Turns.tsx`.
- T3: `apps/web/src/components/chat/MessagesTimeline.tsx`, `TimelineWorkGroupRows.tsx` and
  `ChatMarkdown.tsx`. **Copy.**
- Row: Y-650, Y-653.
- Done when: a fixture turn with 8 tool calls shows one collapsed "Worked for" row of at most 56 px, and
  a code block has a copy button of at least 44 px.

**C4. Keep the composer clear of the keyboard.**
- Fault: `.composer-dock` is `position: sticky; bottom: 0` (`Composer.css` line 829). With F3's meta tag
  missing it can sit under the keyboard. I simulated the keyboard by shrinking the viewport to 508 px:
  the composer stays visible, so the layout is sound when the keyboard resizes it. A real device is
  needed for the rest. `useDockHeight` measures the dock but nothing reads `visualViewport`.
- Root cause: `web/src/composer/Composer.css`, `useDockHeight.ts`, `web/index.html`.
- T3: `apps/mobile/src/features/keyboard/useSoftKeyboardShowing.ts` (native). In the web app
  `apps/web/index.html` is the whole fix. **Copy the meta tag** (F3) and add a `visualViewport` fallback
  for iOS.
- Row: none.
- Done when: a test shrinks the viewport to 508 px high with the composer focused and finds the
  composer's bottom edge at or above 508 px.

**C5. Make a thread survive a locked screen.**
- Fault: a locked phone drops the WebSocket. `web/src/api/socket.ts` retries with a budget of 5
  attempts (`ATTEMPTS`) and has no `visibilitychange`, `pageshow` or `online` listener. Browser timers
  freeze in the background, so on return the page can sit on "reconnecting" until a timer fires, or
  give up. The turn runs on (ADR-0035) and the keeper (ADR-0041, PR #646) holds it; the page does not
  ask again on return.
- Root cause: `web/src/api/socket.ts`, `web/src/screens/session/useChat.ts` (`onDropped`).
- T3: `apps/web/src/connection/platform.ts` lines 68 to 141 (online, offline and visibility
  streams) and `apps/web/src/hooks/useLiveRefresh.ts`. **Copy**; re-express the idea (reconnect at once
  on `visibilitychange` to visible and on `online`, and reset the attempt budget).
- Row: none. Needs an owner phone pass for the lock case (it is not a keeper fault).
- Done when: a test closes the chat socket, dispatches `visibilitychange` with
  `document.visibilityState = 'visible'`, and finds a new socket opened within 500 ms with attempts
  reset to 0.

**C6. Make the push say what is waiting and open it.**
- Fault: the wait message is "{workspace}: chat thread {hex id} waits for an answer", with title
  "Approval needed". It has no click target (`notify.rs` has no click header), no action buttons and no
  word of the request (ADR-0035 Q5 keeps the request out on purpose). A tap opens the dashboard, not
  the thread. The in-app bell holds 80 unread, mostly "bishwajeets-macbook-pro became unreachable"
  repeated; the Notifications page is 5,331 px tall with no grouping.
- Root cause: `crates/yantrad/src/chat.rs` line 1034 (`Wait::message`),
  `crates/yantra-core/src/notify.rs`, `web/src/shell/NotificationsScreen.tsx`.
- T3: `apps/mobile/src/features/agent-awareness/notificationNavigation.ts` routes a tap to the thread;
  `notificationPayload.ts` carries the deep link. **Copy the idea**, re-expressed in Rust: add a
  `Click` URL of `/w/<name>?thread=<id>` and the thread's title. Whether the title may leave the box is
  a decision for the owner (Q5).
- Row: none. Touches an invariant, so the build loop will park it.
- Done when: a Rust test shows the relay request carries a `Click` header with the thread's path, and
  a phone test opens `/notifications` and finds repeated "became unreachable" rows folded into one row
  with a count.

### Other screens

**S1. Make New session fit a phone.**
- Fault: step 2 is 1,692 px tall; the repository list scrolls inside a page that scrolls. The footer
  (Back, Continue) is sticky, which is right. Machine chips are 34 px high with a 48 px hit area, fine.
  The step bar's numbers are small. The Name step holds a keyboard-heavy field above the machine choice.
- Root cause: `web/src/screens/new-session/NewSession.css` lines 146 to 148 (`max-height: min(28rem,
  55dvh)` makes a second scroller).
- T3: none. Y-655 replaces the wizard for a known workspace.
- Row: Y-643 (done), Y-655 (todo). Not a separate item beyond them.
- Done when: at step 2 the document height is at most 844 px plus the footer, and the list is the only
  scroller.

**S2. Cut the Machines and machine page down.**
- Fault: a machine page is 2,424 px tall at 390 px, and the Readiness card prints raw probe text
  ("claude is not on PATH or in any of: $HOME/.local/bin, …") in a monospace block. The Dashboard
  "Finish setup" card shows 4 rows of past tense before any action. The count on Dashboard says 30
  waiting and the bell 80 (the bell counts all unread; this is not a fault if the label says so).
- Root cause: `web/src/screens/machine/Readiness.*`, `web/src/screens/dashboard/`.
- T3: none.
- Row: Y-641 (counts, done). Y-644 (raw text, todo) covers the tmux half only.
- Done when: `/m/<machine>` shows the first failing check and its fix command above 600 px, and the
  other checks sit inside a closed `Disclosure`.

**S3. Settings inputs.**
- Fault: General and Appearance render `INPUT` elements at 1 x 1 px (visually hidden radios) with 14
  px font; Notifications and Usage the same. The visible control is a label, so a tap works, but a
  zoom-on-focus risk exists on iOS if any of them focuses by script. `Default machine` is a native
  `select` at 220 x 40.
- Root cause: `web/src/m3/segmented`, `web/src/m3/switch`.
- T3: none.
- Row: none. Low priority.
- Done when: every `input`, `select` and `textarea` has a computed `font-size` of at least 16 px.

## Agent flow: what the owner meets

| Step | Yantra today | T3 | Gap and item |
| --- | --- | --- | --- |
| Start a thread | A four-step wizard, then a chat page. | Type in the thread and send. | Y-655. |
| Pick a machine | A chip row on step 1 (a good choice list; Y-642 removed machines that run no session). Default machine setting. | Environment switcher in the header. | Fine on the phone. Show the machine on the thread header. |
| Approvals | A card in the timeline, 3 buttons. | A panel at the composer. | C2, Y-654. |
| Questions | Shown as "asks to use a tool". | An option panel with navigation. | C2, Y-654. |
| Background work | The keeper holds the turn (ADR-0041, PR #646). The page shows a terminal line "Waiting for 2 background agents" only in the Terminal tab. | A work log and a banner lane. | C3. The Chat tab does not say a turn runs in the background. Add one line in the timeline. |
| Cancel | Stop in the composer; the status reads "Stopping Claude…". | Same. | Parity. |
| Errors | A typed `ErrorSurface`, with Retry for logged-out harnesses. | A banner stack above the composer. | Parity; the full text shows (Y-631). |
| Notifications | An ntfy push, with no link. | A native push that opens the thread. | C6. |
| Resume after the screen locks | The socket reconnects on a timer, up to five tries. | Reconnects on visibility and `online`. | C5. |

## Order to build

1. F1, F2, F3 together are three small PRs and change every screen; build them first.
2. F4 and F5 next (touch and overlap).
3. C1, C2, C3 are rows already; C4, C5 are new; C6 waits on the owner.
4. F6, F7, S1 to S3 last.

## What I could not check

- Real WebKit: rubber band, sticky hover, safe-area insets and the iOS keyboard.
- A thread with tool calls, an approval, a question, and the background line. The box has none and I
  may not create one.
- New session's Start step.
- The push on a locked phone.

The owner's phone pass should cover F1, F3, C4, C5 and C6 first.

## Sources

All accessed 2026-11-08.

- Live dashboard, `http://100.95.169.83:7717` (`yantra-box`, version 0.10.3), screenshots in
  `~/yantra-mobile-audit/2026-11-08/`.
- Yantra at `origin/main` `6c7d7ea6`: `web/index.html`, `web/public/manifest.webmanifest`,
  `web/public/sw.js`, `web/src/index.css`, `web/src/m3/tokens.css`, `web/src/shell/Shell.css`,
  `web/src/shell/formFactor.ts`, `web/src/composer/Composer.css`, `web/src/screens/session/Chat.tsx`,
  `web/src/api/socket.ts`, `crates/yantrad/src/chat.rs`, `tracker.md` rows Y-630 to Y-656.
- T3 Code at `67eebaca`, `~/Github/t3code-ref`: `apps/web/index.html`, `apps/web/src/index.css`,
  `apps/web/src/connection/platform.ts`, `apps/web/src/hooks/useLiveRefresh.ts`,
  `apps/web/src/components/chat/`, `apps/web/src/components/ui/sidebar.tsx`,
  `apps/mobile/src/features/agent-awareness/`, `apps/mobile/src/features/keyboard/`.
- Pull request #646, ADR-0041 "a Claude keeper holds the thread" (open when I read it).
- [ADR-0035](../adr/0035-a-chat-turn-outlives-its-ssh-pipe.md).
- Skill text used: `mobile-native` (Kowalski), for the symptom list.
